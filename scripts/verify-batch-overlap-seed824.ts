// 手工核对用（不进 CI；docs/V8222_TECHNICIANS.md 第 11 节，scripts/verify-batch-overlap-upgrade.sh 调用）：
// 在 v8.2.4 的工作区里、用 v8.2.4 自己的代码（迁移、buildApp、接口）往一个新建的独立库里写数据——
//   · 一报多：POST /api/bookings/batch，同一位技师同一时段两位 + 同一时段一位不指定；
//   · VERIFY_WITH_CONFLICTS=1 时另建两张单张新建的技师预约（POST /api/bookings，同一技师、不同时段），派对房两张（不同时段）：接口不让建重叠，
//     之后由 shell 脚本用 SQL 把第二张挪到与第一张重叠（模拟坏数据——普通预约的重叠只能这样来）。
// 运行：cd <v8.2.4 工作区> && DATABASE_URL=<独立库> npx tsx <本仓库>/scripts/verify-batch-overlap-seed824.ts
// 只在库名含 verify 的库上跑（防止指到别的库）。输出一行 JSON：几张预约的单号与编号。

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const url = process.env.DATABASE_URL ?? '';
if (!/verify/i.test(new URL(url).pathname)) throw new Error('DATABASE_URL 的库名要含 verify（只在新建的独立库上跑）');
process.env.APP_ENV = 'test';
const root = process.cwd();
const load = (p: string) => import(pathToFileURL(`${root}/${p}`).href);
const { buildApp } = await load('src/server/app.ts');
const { loadConfig } = await load('src/server/config.ts');
const { createSql } = await load('src/server/db.ts');
const { migrate } = await load('src/server/migrate.ts');
const { createStaff } = await load('src/server/modules/staff.ts');

const PASSWORD = 'verify-pass-2026';
const config = loadConfig({ databaseUrl: url, env: 'test', logLevel: 'silent', integrations: { mock: true, liveConfigured: [] } });
const sql = createSql(url, { max: 4 });
const applied: string[] = await migrate(sql);
await createStaff(sql, { username: 'owner', displayName: '核对店主', role: 'owner', password: PASSWORD, mustChangePassword: false });
const app = await buildApp(sql, config);

async function login(username: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`登录失败 ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x: { name: string }) => x.name === 'yuzu_sid');
  return `yuzu_sid=${c.value}`;
}
async function api(cookie: string, method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) {
  const res = await app.inject({ method, url: path, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  if (res.statusCode >= 300) throw new Error(`${method} ${path} → ${res.statusCode} ${JSON.stringify(body)}`);
  return body;
}

try {
  const owner = await login('owner');
  const items = await api(owner, 'POST', '/api/items', { name: '核对足疗', category: '足疗', price: 19800, durationMinutes: 60, technicianRequired: true });
  const foot = items.items.find((i: { name: string }) => i.name === '核对足疗').id as number;
  const tech: Record<string, number> = {};
  for (const no of ['V1', 'V2']) {
    const r = await api(owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender: 'female', grade: 'standard', skills: ['足疗'] });
    tech[no] = r.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  await api(owner, 'PUT', '/api/admin/technicians/rules', { enabled: true });
  // 派对房（开单即占用）：空间台账导入
  const csv = (rows: string[]) => rows.join('\r\n');
  for (const [kind, rows] of [
    ['zones', ['楼层,区域名(中文),区域名(英文),备注', 'L2,核对娱乐区,Verify Fun,合成样例']],
    ['spaces', ['楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注', 'L2,X,X501,派对房,12,核对派对房,,核对派对房 X501,']],
  ] as const) {
    await api(owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv: csv([...rows]), encoding: 'UTF-8', clientKey: randomUUID() });
  }
  const spaceId = (await api(owner, 'GET', '/api/admin/spaces')).spaces.find((s: { code: string }) => s.code === 'X501').id as number;

  const me = await api(owner, 'GET', '/api/auth/me');
  const tomorrow = new Date(Date.parse(`${me.today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const slots = ((await api(owner, 'GET', `/api/bookings/slots?kind=technician&date=${tomorrow}&itemId=${foot}`)) as { startsAt: string }[]).map((s) => s.startsAt);

  // 一报多（v8.2.4 的真接口）：V1 同一时段两位 + 一位不指定
  const batchKey = randomUUID();
  const batch = await api(owner, 'POST', '/api/bookings/batch', {
    clientKey: batchKey,
    source: 'front',
    rows: [
      { guestName: '王', tagCode: 'A001', guestPhone: '13900000011', itemId: foot, technicianId: tech.V1, startsAt: slots[2] },
      { guestName: '李', itemId: foot, technicianId: tech.V1, startsAt: slots[2] },
      { guestName: '张', itemId: foot, technicianId: null, startsAt: slots[2] },
    ],
  });
  // 单张新建（v8.2.4 的真接口）：V2 两个不同时段；派对房两个不同时段（VERIFY_WITH_CONFLICTS=1 时才建）
  const extra: Record<string, string> = {};
  if (process.env.VERIFY_WITH_CONFLICTS === '1') {
    const single = async (startsAt: string, guestName: string) =>
      (await api(owner, 'POST', '/api/bookings', { clientKey: randomUUID(), kind: 'technician', guestName, itemId: foot, technicianId: tech.V2, startsAt })).bookingNo as string;
    const singleA = await single(slots[6]!, '赵');
    const singleB = await single(slots[10]!, '钱');
    const spaceSlots = ((await api(owner, 'GET', `/api/bookings/slots?kind=space&date=${tomorrow}&spaceId=${spaceId}&durationMinutes=120`)) as { startsAt: string }[]).map((s) => s.startsAt);
    const room = async (startsAt: string, guestName: string) =>
      (await api(owner, 'POST', '/api/bookings', { clientKey: randomUUID(), kind: 'space', guestName, spaceId, startsAt, durationMinutes: 120 })).bookingNo as string;
    const roomA = await room(spaceSlots[0]!, '孙');
    const roomB = await room(spaceSlots[spaceSlots.length - 1]!, '周');
    Object.assign(extra, { singleA, singleB, roomA, roomB });
  }
  console.log(JSON.stringify({ migrations: applied.length, lastMigration: applied.at(-1), batchKey, batch: batch.bookings.map((b: { bookingNo: string }) => b.bookingNo), ...extra }));
} finally {
  await app.close();
  await sql.end({ timeout: 5 });
}
