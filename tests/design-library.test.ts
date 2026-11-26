// Design 素材库（docs/BOARDS.md 第 4 节）：上传字体、图片、视频（按文件头认格式、限大小、试用字体不收），
// 每个用途设一份当前使用的、一键切换与切回（操作编号原样重提、别人先换过的拒绝、种类不对的拒绝）；
// 门户横幅、大屏视频、平板字体读「现在用的」；归档在用的素材要先换掉；员工没有管理权限进不来。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { solidPng } from '../src/server/modules/legacy/samples';
import { createStaff } from '../src/server/modules/staff';
import { setDesignQuotaForTest } from '../src/server/modules/design';
import { DESIGN_LIMITS } from '../src/shared/design';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let designer: string;
let designer2: string;
let clerk: string;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnxEJMAIAJF4C/3FpsJcAAAAASUVORK5CYII=', 'base64');
// 素材库不解码，只核对结构：WOFF2 头里的长度等于文件长度；MP4 顶层盒子首尾相接、有 ftyp、moov、mdat
function woff2(fill: number, n = 60) {
  const b = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(n, fill)]);
  b.writeUInt32BE(b.length, 8);
  return b;
}
const box = (type: string, payload: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
};
const mp4 = (n: number, fill: number) => Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isommp41', 'latin1')), box('moov', Buffer.alloc(16, 1)), box('mdat', Buffer.alloc(n, fill))]);
const WOFF2 = woff2(1);
const MP4 = mp4(60, 2);

async function upload(app: FastifyInstance, cookie: string, query: string, body: Buffer) {
  const res = await app.inject({ method: 'POST', url: `/api/design/upload?${query}`, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: body });
  return { status: res.statusCode, body: res.json() };
}
const assign = (cookie: string, slot: string, versionId: number | null, fromVersionId: number | null, opKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/design/slots/${slot}/assign`, { versionId, fromVersionId, opKey, reason: '测试' });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'artist', displayName: '设计师', role: 'designer', password: PASSWORD, mustChangePassword: false });
  designer = await login(ctx.app, 'artist');
  await createStaff(ctx.sql, { username: 'artist2', displayName: '设计师二', role: 'designer', password: PASSWORD, mustChangePassword: false });
  designer2 = await login(ctx.app, 'artist2');
  clerk = ctx.clerk;
}, 120_000);
afterAll(async () => {
  await ctx.close();
});

describe('素材库', () => {
  it('上传：图片、字体、视频按文件头认；字体要写授权说明；格式不对、试用字体不收；店员进不来', async () => {
    const img = await upload(ctx.app, designer, 'kind=image&name=横幅一', PNG);
    expect(img.status, JSON.stringify(img.body)).toBe(201);
    expect((await upload(ctx.app, designer, 'kind=font&name=英文字体', WOFF2)).body.error.code).toBe('DESIGN_FONT_LICENSE');
    expect((await upload(ctx.app, designer, `kind=font&name=英文字体&note=${encodeURIComponent('某厂商，门店使用授权')}`, WOFF2)).status).toBe(201);
    expect((await upload(ctx.app, designer, 'kind=video&name=待机', MP4)).status).toBe(201);
    expect((await upload(ctx.app, designer, 'kind=video&name=假视频', PNG)).body.error.code).toBe('DESIGN_TYPE');
    const trial = Buffer.concat([WOFF2, Buffer.from('Unlicensed Trial', 'latin1')]);
    trial.writeUInt32BE(trial.length, 8);
    expect((await upload(ctx.app, designer, 'kind=font&name=试用&note=x', trial)).body.error.code).toBe('DESIGN_FONT_TRIAL');
    expect((await upload(ctx.app, clerk, 'kind=image&name=x', PNG)).status).toBe(403);
    expect((await api(ctx.app, clerk, 'GET', '/api/design/assets')).status).toBe(403);
    const list = (await api(ctx.app, designer, 'GET', '/api/design/assets?kind=image')).body as { name: string }[];
    expect(list.map((a) => a.name)).toContain('横幅一');
  });

  it('用途：设成某一版、门户读得到；种类不对拒绝；别人先换过拒绝；原样重提不重复；切回「不用素材」', async () => {
    const a = (await upload(ctx.app, designer, 'kind=image&name=横幅二', solidPng(0x2f, 0x6f, 0x5e))).body as { id: number; latest: { id: number } };
    const v1 = a.latest.id;
    const video = (await api(ctx.app, designer, 'GET', '/api/design/assets?kind=video')).body[0] as { latest: { id: number } };
    expect((await assign(designer, 'portal.banner', video.latest.id, null)).body.error.code).toBe('DESIGN_KIND_MISMATCH');
    const key = randomUUID();
    const set = await assign(designer, 'portal.banner', v1, null, key);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.slot.current).toMatchObject({ versionId: v1 });
    expect((await assign(designer, 'portal.banner', v1, null, key)).body.replayed).toBe(true);
    // 看到的「现在用的」已经过时：拒绝
    expect((await assign(designer, 'portal.banner', null, null)).body.error.code).toBe('SLOT_CHANGED');
    // 登录了都能读现在用的与文件（门户横幅给所有人看）
    const current = (await api(ctx.app, clerk, 'GET', '/api/design/current')).body;
    expect(current['portal.banner']).toBe(v1);
    const file = await ctx.app.inject({ method: 'GET', url: `/api/design/files/${v1}`, headers: { cookie: clerk } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('image/png');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/design/files/${v1}` })).statusCode).toBe(401);
    // 加一版：用途不自己跟着换，提示有新版本
    const v2 = (await upload(ctx.app, designer, `kind=image&assetId=${a.id}`, solidPng(0xe0, 0xa8, 0x2e))).body.latest.id as number;
    // 没上架的版本：管素材的能取（预览），普通员工按「文件不存在」（Codex 安全审查：不能按编号一个个试）
    expect((await ctx.app.inject({ method: 'GET', url: `/api/design/files/${v2}`, headers: { cookie: designer } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/design/files/${v2}`, headers: { cookie: clerk } })).statusCode).toBe(404);
    const slots = (await api(ctx.app, designer, 'GET', '/api/design/slots')).body as { slot: string; current: { versionId: number } | null; newerVersionId: number | null }[];
    expect(slots.find((s) => s.slot === 'portal.banner')).toMatchObject({ current: { versionId: v1 }, newerVersionId: v2 });
    // 在用的不能归档
    const seen = async () => ((await api(ctx.app, designer, 'GET', `/api/design/assets/${a.id}`)).body as { updatedAt: string }).updatedAt;
    expect((await api(ctx.app, designer, 'POST', `/api/design/assets/${a.id}/archive`, { archived: true, expectedUpdatedAt: await seen() })).status).toBeGreaterThanOrEqual(400);
    // 切回不用素材：门户不显示横幅；之后可以归档
    expect((await assign(designer, 'portal.banner', null, v1)).status).toBe(200);
    expect((await api(ctx.app, clerk, 'GET', '/api/design/current')).body['portal.banner']).toBeNull();
    // 归档带页面看到的修改时间：之后改过（这里改了名字）就拒绝；用新的时间才成。结果不确定的原请求晚到也不生效（时间已经变了）
    const stale = await seen();
    await new Promise((r) => setTimeout(r, 5));
    // 改名字也带看到的修改时间：拿旧的被拒（晚到的原请求不盖掉之后的修改），拿新的才成
    expect((await api(ctx.app, designer, 'PUT', `/api/design/assets/${a.id}`, { name: '横幅改名', tags: [], note: '', expectedUpdatedAt: stale })).status).toBe(200);
    expect((await api(ctx.app, designer, 'PUT', `/api/design/assets/${a.id}`, { name: '横幅又改', tags: [], note: '', expectedUpdatedAt: stale })).body.error.code).toBe('ASSET_CHANGED');
    expect(((await api(ctx.app, designer, 'GET', `/api/design/assets/${a.id}`)).body as { name: string }).name).toBe('横幅改名');
    expect((await api(ctx.app, designer, 'POST', `/api/design/assets/${a.id}/archive`, { archived: true, expectedUpdatedAt: stale })).body.error.code).toBe('ASSET_CHANGED');
    const fresh = await seen();
    expect((await api(ctx.app, designer, 'POST', `/api/design/assets/${a.id}/archive`, { archived: true, expectedUpdatedAt: fresh })).status).toBe(200);
    expect((await api(ctx.app, designer, 'POST', `/api/design/assets/${a.id}/archive`, { archived: true, expectedUpdatedAt: fresh })).body.error.code).toBe('ASSET_CHANGED');
    // 归档的不能再设
    expect((await assign(designer, 'portal.banner', v2, null)).body.error.code).toBe('DESIGN_ARCHIVED');
  });

  it('结果不确定的切换：查回、确认作废后原请求晚到也不换；已经换了的作废给结果', async () => {
    const img = (await upload(ctx.app, designer, 'kind=image&name=横幅三', solidPng(0x11, 0x22, 0x33))).body as { latest: { id: number } };
    const now = ((await api(ctx.app, clerk, 'GET', '/api/design/current')).body as Record<string, number | null>)['portal.banner'] ?? null;
    const lost = randomUUID();
    expect((await api(ctx.app, designer, 'GET', `/api/design/ops/${lost}`)).body).toEqual({ found: false, abandoned: false });
    expect((await api(ctx.app, designer, 'POST', `/api/design/ops/${lost}/abandon`, { slot: 'portal.banner' })).body).toEqual({ found: false, abandoned: true });
    // 原请求晚到：拒绝，用途不变
    expect((await assign(designer, 'portal.banner', img.latest.id, now, lost)).body.error.code).toBe('OP_ABANDONED');
    expect(((await api(ctx.app, clerk, 'GET', '/api/design/current')).body as Record<string, number | null>)['portal.banner'] ?? null).toBe(now);
    // 已经换了的：作废给「已换好」
    const done = randomUUID();
    expect((await assign(designer, 'portal.banner', img.latest.id, now, done)).status).toBe(200);
    expect((await api(ctx.app, designer, 'POST', `/api/design/ops/${done}/abandon`, { slot: 'portal.banner' })).body).toEqual({ found: true, abandoned: false });
    expect((await api(ctx.app, designer, 'GET', `/api/design/ops/${done}`)).body.found).toBe(true);
    expect((await assign(designer, 'portal.banner', null, img.latest.id)).status).toBe(200);
  });

  it('上传在读正文之前把关（Codex 安全审查）：没写种类、声明超过这一种的上限直接拒绝；素材库总量超了拒绝，不存', async () => {
    expect((await upload(ctx.app, designer, 'name=x', PNG)).status).toBe(400);
    const big = await ctx.app.inject({
      method: 'POST',
      url: '/api/design/upload?kind=image',
      headers: { cookie: designer, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(DESIGN_LIMITS.image.maxBytes + 1, 1),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('DESIGN_TOO_LARGE');
    const [{ used }] = (await ctx.sql<{ used: string }[]>`SELECT coalesce(sum(size_bytes), 0)::text AS used FROM design_asset_versions`) as unknown as [{ used: string }];
    setDesignQuotaForTest(Number(used) + 10);
    try {
      const over = await upload(ctx.app, designer, 'kind=image&name=超额', solidPng(0x90, 0x91, 0x92));
      expect(over.status).toBe(413);
      expect(over.body.error.code).toBe('DESIGN_QUOTA');
      const [{ n }] = (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM design_assets WHERE name = '超额'`) as unknown as [{ n: number }];
      expect(n).toBe(0);
    } finally {
      setDesignQuotaForTest(null);
    }
    // 总版本数、每人每天的版本数也有上限（Codex 安全审查：只限字节时小文件能存上亿条）
    const [{ total }] = (await ctx.sql<{ total: number }[]>`SELECT count(*)::int AS total FROM design_asset_versions`) as unknown as [{ total: number }];
    setDesignQuotaForTest({ versions: total });
    try {
      const over = await upload(ctx.app, designer, 'kind=image&name=超数', solidPng(0x93, 0x94, 0x95));
      expect([over.status, over.body.error.code]).toEqual([413, 'DESIGN_QUOTA']);
    } finally {
      setDesignQuotaForTest(null);
    }
    const [{ mine }] = (await ctx.sql<{ mine: number }[]>`
      SELECT count(*)::int AS mine FROM design_asset_versions v JOIN staff s ON s.id = v.created_by WHERE s.username = 'artist2' AND v.created_at > now() - interval '24 hours'`) as unknown as [
      { mine: number },
    ];
    setDesignQuotaForTest({ perStaffDay: mine });
    try {
      const over = await upload(ctx.app, designer2, 'kind=image&name=当天超数', solidPng(0x96, 0x97, 0x98));
      expect([over.status, over.body.error.code]).toEqual([429, 'DESIGN_DAILY_LIMIT']);
    } finally {
      setDesignQuotaForTest(null);
    }
    // 每人一共能占的字节：设计师二已传的加上这一张超了就拒绝，别人照样能传（Codex 安全审查）
    const [{ mineBytes }] = (await ctx.sql<{ mineBytes: string }[]>`
      SELECT coalesce(sum(v.size_bytes), 0)::text AS mine_bytes FROM design_asset_versions v JOIN staff s ON s.id = v.created_by WHERE s.username = 'artist2'`) as unknown as [{ mineBytes: string }];
    setDesignQuotaForTest({ perStaffBytes: Number(mineBytes) + 10 });
    try {
      const over = await upload(ctx.app, designer2, 'kind=image&name=个人超额', solidPng(0x99, 0x9a, 0x9b));
      expect([over.status, over.body.error.code]).toEqual([413, 'DESIGN_STAFF_QUOTA']);
    } finally {
      setDesignQuotaForTest(null);
    }
    // 只有文件头的「视频」「字体」不收：要像个能播的视频、完整的字体
    const headOnly = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(1, 0)]);
    expect((await upload(ctx.app, designer, 'kind=video&name=空壳', headOnly)).body.error.code).toBe('DESIGN_TYPE');
    expect((await upload(ctx.app, designer, 'kind=video&name=没有画面', Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1')), box('moov', Buffer.alloc(4))]))).body.error.code).toBe(
      'DESIGN_TYPE',
    );
    // 顶层盒子太多（几百万个 8 字节的 free 盒子那种）：不往下走，直接拒绝（Codex 安全审查）
    const manyBoxes = Buffer.concat([
      box('ftyp', Buffer.from('isom', 'latin1')),
      ...Array.from({ length: 300 }, () => box('free', Buffer.alloc(0))),
      box('moov', Buffer.alloc(4)),
      box('mdat', Buffer.alloc(4)),
    ]);
    expect((await upload(ctx.app, designer, 'kind=video&name=盒子太多', manyBoxes)).body.error.code).toBe('DESIGN_TYPE');
    const badWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x00]);
    expect((await upload(ctx.app, designer, 'kind=video&name=坏webm', badWebm)).body.error.code).toBe('DESIGN_TYPE');
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00, 0x18, 0x53, 0x80, 0x67, 0x84]), Buffer.alloc(4, 9)]);
    expect((await upload(ctx.app, designer, 'kind=video&name=好webm', webm)).status).toBe(201);
    const shortFont = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(9, 1)]);
    expect((await upload(ctx.app, designer, `kind=font&name=半个字体&note=${encodeURIComponent('授权')}`, shortFont)).body.error.code).toBe('DESIGN_TYPE');
    // 占位放掉了：接着能传
    expect((await upload(ctx.app, designer, 'kind=image&name=没超额', solidPng(0x90, 0x91, 0x92))).status).toBe(201);
  });

  it('素材列表按编号从新到旧分页（before 往前翻），按名字、标签搜（Codex 审查：不再截到 500 条）', async () => {
    const made: number[] = [];
    for (const [i, n] of ['翻页甲', '翻页乙', '翻页丙'].entries())
      made.push(((await upload(ctx.app, designer, `kind=image&name=${encodeURIComponent(n)}`, solidPng(0x30 + i, 0x31, 0x32))).body as { id: number }).id);
    const first = (await api(ctx.app, designer, 'GET', '/api/design/assets?kind=image&q=翻页')).body as { id: number; name: string }[];
    expect(first.map((x) => x.name)).toEqual(['翻页丙', '翻页乙', '翻页甲']);
    const older = (await api(ctx.app, designer, 'GET', `/api/design/assets?kind=image&q=${encodeURIComponent('翻页')}&before=${made[2]}`)).body as { name: string }[];
    expect(older.map((x) => x.name)).toEqual(['翻页乙', '翻页甲']);
    // 搜的字里有 % 不当通配符
    expect((await api(ctx.app, designer, 'GET', `/api/design/assets?kind=image&q=${encodeURIComponent('%')}`)).body).toEqual([]);
  });

  it('下载按段读出来送：超过一段（1MB）的文件逐字节一样，带 content-length（Codex 安全审查）', async () => {
    const big = mp4(2_600_000, 7);
    const v = (await upload(ctx.app, designer, 'kind=video&name=分段', big)).body as { latest: { id: number } };
    const res = await ctx.app.inject({ method: 'GET', url: `/api/design/files/${v.latest.id}`, headers: { cookie: designer } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(big.length));
    expect(Buffer.compare(res.rawPayload, big)).toBe(0);
  });

  it('同一个人同时取很多份素材：超过同时下载的上限也不报错，排队一个个给（Codex 审查）', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(((await upload(ctx.app, designer, `kind=image&name=排队${i}`, solidPng(0xc0 + i, 0x10, 0x20))).body as { latest: { id: number } }).latest.id);
    const all = await Promise.all(ids.map((id) => ctx.app.inject({ method: 'GET', url: `/api/design/files/${id}`, headers: { cookie: designer } })));
    expect(all.map((r) => r.statusCode)).toEqual(ids.map(() => 200));
  });

  it('下载到一半断开：占位放掉，之后照常能取（Codex 审查）', async () => {
    const big = mp4(5_000_000, 3);
    const v = (await upload(ctx.app, designer, 'kind=video&name=断开', big)).body as { latest: { id: number } };
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      // 同一个人连着断开 6 次（超过每人 4 个），之后还能马上取到
      for (let i = 0; i < 6; i += 1) {
        const ctrl = new AbortController();
        const res = await fetch(`${address}/api/design/files/${v.latest.id}`, { headers: { cookie: designer }, signal: ctrl.signal });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        await reader.read();
        ctrl.abort();
        await reader.cancel().catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 200));
      const started = Date.now();
      const ok = await fetch(`${address}/api/design/files/${v.latest.id}`, { headers: { cookie: designer } });
      expect(ok.status).toBe(200);
      expect((await ok.arrayBuffer()).byteLength).toBe(big.length);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      // 断开的连接收掉（app.close 在 afterAll 里关监听）
      ctx.app.server.closeAllConnections();
    }
  }, 60_000);

  it('同一个新文件同时传两次：只建一份素材（按内容摘要排队）', async () => {
    const png = solidPng(0x44, 0x55, 0x66);
    // 两位设计师各传一次（同一个人同时只能传一个，Codex 审查）
    const [a, b] = await Promise.all([upload(ctx.app, designer, 'kind=image&name=并发一', png), upload(ctx.app, designer2, 'kind=image&name=并发二', png)]);
    expect([a.status, b.status].every((x) => x === 201)).toBe(true);
    expect(a.body.id).toBe(b.body.id);
  });

  it('加新版重传：A 传成功没收到回复、别人接着传了 B，再重传 A 不另加一版，B 还是最新（Codex 审查）', async () => {
    const first = (await upload(ctx.app, designer, 'kind=image&name=重传', solidPng(0x70, 0x10, 0x10))).body as { id: number };
    const fileA = solidPng(0x70, 0x20, 0x20);
    const a = (await upload(ctx.app, designer, `kind=image&assetId=${first.id}`, fileA)).body as { latest: { id: number; versionNo: number } };
    const b = (await upload(ctx.app, designer, `kind=image&assetId=${first.id}`, solidPng(0x70, 0x30, 0x30))).body as { latest: { id: number; versionNo: number } };
    expect(b.latest.versionNo).toBe(a.latest.versionNo + 1);
    const retry = await upload(ctx.app, designer, `kind=image&assetId=${first.id}`, fileA);
    expect(retry.status).toBe(201);
    expect(retry.body.latest).toMatchObject({ id: b.latest.id, versionNo: b.latest.versionNo });
    expect(retry.body.versions).toHaveLength(3);
    // 旧文件要再用：直接把那一版换上（页面「选更早的版本」），不用重传
    const cur = ((await api(ctx.app, clerk, 'GET', '/api/design/current')).body as Record<string, number | null>)['portal.banner'] ?? null;
    expect((await assign(designer, 'portal.banner', a.latest.id, cur)).status).toBe(200);
    expect((await api(ctx.app, clerk, 'GET', '/api/design/current')).body['portal.banner']).toBe(a.latest.id);
    expect((await assign(designer, 'portal.banner', null, a.latest.id)).status).toBe(200);
  });

  it('平板菜单英文字体：设了用途就用素材库的，后台显示来源；切回不用素材照旧读 brand-fonts 目录', async () => {
    const font = ((await api(ctx.app, designer, 'GET', '/api/design/assets?kind=font')).body as { latest: { id: number } }[])[0]!;
    expect((await assign(designer, 'emenu.font.en', font.latest.id, null)).status).toBe(200);
    // 只按版本号给 ETag，内容转到 /api/design/files/:id 取（那里有下载占位与分段读；Codex 安全审查）
    const res = await ctx.app.inject({ method: 'GET', url: '/api/emenu/fonts/brand-en', headers: { cookie: ctx.owner } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/api/design/files/${font.latest.id}`);
    expect(res.headers.etag).toBe(`"design-${font.latest.id}"`);
    const same = await ctx.app.inject({ method: 'GET', url: '/api/emenu/fonts/brand-en', headers: { cookie: ctx.owner, 'if-none-match': `"design-${font.latest.id}"` } });
    expect(same.statusCode).toBe(304);
    const file = await ctx.app.inject({ method: 'GET', url: res.headers.location as string, headers: { cookie: ctx.owner } });
    expect([file.statusCode, file.headers['content-type']]).toEqual([200, 'font/woff2']);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/emenu/fonts/brand-en' })).statusCode).toBe(401);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/admin/emenu/brand-font')).body).toMatchObject({ state: 'active', source: 'library' });
    expect((await assign(designer, 'emenu.font.en', null, font.latest.id)).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/admin/emenu/brand-font')).body.source).not.toBe('library');
  });
});

describe('用途按门店分开设（Codex 安全审查）', () => {
  it('只挂在分店的设计师换横幅：总店的不变；查回、作废只看本店；哪家店用着的素材都不能归档', async () => {
    const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '素材分店主体' });
    const storeId = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'DS', name: '素材分店', entityId: entity.body.id })).body.id as number;
    const created = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: 'dsart', displayName: '分店设计师', role: 'designer' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const temp = created.body.temporaryPassword as string;
    const first = await login(ctx.app, 'dsart', temp);
    expect((await api(ctx.app, first, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: 'dsart-2026x' })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${created.body.staff?.id ?? created.body.id}/stores`, { storeIds: [storeId] })).status).toBe(200);
    const branch = await login(ctx.app, 'dsart', 'dsart-2026x');

    const hqBefore = ((await api(ctx.app, clerk, 'GET', '/api/design/current')).body as Record<string, number | null>)['portal.banner'] ?? null;
    const img = (await upload(ctx.app, branch, 'kind=image&name=分店横幅', solidPng(0xa1, 0xb2, 0xc3))).body as { id: number; latest: { id: number }; updatedAt: string };
    const op = randomUUID();
    expect((await assign(branch, 'portal.banner', img.latest.id, null, op)).status).toBe(200);
    expect(((await api(ctx.app, branch, 'GET', '/api/design/current')).body as Record<string, number | null>)['portal.banner']).toBe(img.latest.id);
    // 总店不变
    expect(((await api(ctx.app, clerk, 'GET', '/api/design/current')).body as Record<string, number | null>)['portal.banner'] ?? null).toBe(hqBefore);
    // 分店的操作编号：总店查不到、作废不了
    expect((await api(ctx.app, designer, 'GET', `/api/design/ops/${op}`)).body).toEqual({ found: false, abandoned: false });
    expect((await api(ctx.app, designer, 'POST', `/api/design/ops/${op}/abandon`, { slot: 'portal.banner' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 分店用着：总店的设计师也归档不了
    const detail = (await api(ctx.app, designer, 'GET', `/api/design/assets/${img.id}`)).body as { updatedAt: string };
    const refused = await api(ctx.app, designer, 'POST', `/api/design/assets/${img.id}/archive`, { archived: true, expectedUpdatedAt: detail.updatedAt });
    expect(refused.body.error.code).toBe('DESIGN_IN_USE');
    expect(refused.body.error.message).toContain('素材分店');
    // 页面记下的发起门店对不上（在总店发起、换到分店后原样重提 / 作废）：拒绝，不会换到分店上
    const lost = randomUUID();
    const wrong = await api(ctx.app, branch, 'POST', '/api/design/slots/portal.banner/assign', { versionId: null, fromVersionId: img.latest.id, opKey: lost, reason: '', storeId: 1 });
    expect(wrong.body.error.code).toBe('STORE_MISMATCH');
    expect(((await api(ctx.app, branch, 'GET', '/api/design/current')).body as Record<string, number | null>)['portal.banner']).toBe(img.latest.id);
    expect((await api(ctx.app, branch, 'POST', `/api/design/ops/${lost}/abandon`, { slot: 'portal.banner', storeId: 1 })).body.error.code).toBe('STORE_MISMATCH');
    expect((await api(ctx.app, branch, 'POST', '/api/design/slots/portal.banner/assign', { versionId: null, fromVersionId: img.latest.id, opKey: randomUUID(), reason: '', storeId })).status).toBe(
      200,
    );
  });
});

describe('换用途要发布权限（Codex 安全审查）', () => {
  it('只有 studio.edit、没有 studio.publish 的：能传素材、看用途，不能换、不能确认作废', async () => {
    await ctx.sql`
      INSERT INTO settings (key, value) VALUES ('role_permissions', ${ctx.sql.json({ designer: { add: [], remove: ['studio.publish'] } })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    try {
      const img = (await upload(ctx.app, designer, 'kind=image&name=只能编辑', solidPng(0xa1, 0xa2, 0xa3))).body as { latest: { id: number } };
      expect(img.latest.id).toBeGreaterThan(0);
      expect((await api(ctx.app, designer, 'GET', '/api/design/slots')).status).toBe(200);
      const cur = ((await api(ctx.app, designer, 'GET', '/api/design/slots')).body as { slot: string; current: { versionId: number } | null }[]).find((s) => s.slot === 'portal.banner')!;
      expect((await assign(designer, 'portal.banner', img.latest.id, cur.current?.versionId ?? null)).status).toBe(403);
      expect((await api(ctx.app, designer, 'POST', `/api/design/ops/${randomUUID()}/abandon`, { slot: 'portal.banner' })).status).toBe(403);
    } finally {
      await ctx.sql`DELETE FROM settings WHERE key = 'role_permissions'`;
    }
  });
});

describe('官网接素材库（8.1.46，docs/BOARDS.md 第 5 节）', () => {
  const pub = (name: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: 'GET', url: `/api/public/website/${name}`, headers });

  it('不要登录：没设 404；设了给文件（ETag、按段取）；只开官网两个用途，别的用途、按编号取都不给', async () => {
    expect((await pub('hero-video')).statusCode).toBe(404);
    expect((await pub('share-image')).statusCode).toBe(404);
    expect((await pub('portal-banner')).statusCode).toBe(404);

    const video = mp4(4000, 7);
    const v = (await upload(ctx.app, designer, 'kind=video&name=官网首屏', video)).body as { latest: { id: number } };
    expect((await assign(designer, 'website.hero.video', v.latest.id, null)).status).toBe(200);
    const full = await pub('hero-video');
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toContain('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['cache-control']).toBe('public, no-cache');
    expect(full.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(full.rawPayload.equals(video)).toBe(true);
    const etag = full.headers.etag as string;
    expect(etag).toBe(`"dv-${v.latest.id}"`);
    expect((await pub('hero-video', { 'if-none-match': etag })).statusCode).toBe(304);

    // 按段取（Safari 播视频要）：一段、开头到尾、最后 n 个；起点超出 416
    const part = await pub('hero-video', { range: 'bytes=10-109' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-109/${video.length}`);
    expect(part.rawPayload.equals(video.subarray(10, 110))).toBe(true);
    const tail = await pub('hero-video', { range: 'bytes=-16' });
    expect(tail.rawPayload.equals(video.subarray(video.length - 16))).toBe(true);
    expect((await pub('hero-video', { range: `bytes=${video.length}-` })).statusCode).toBe(416);

    // 素材库里别的版本、门店用途的素材：这个地址拿不到；/api/design/files 照旧要登录
    expect((await ctx.app.inject({ method: 'GET', url: `/api/design/files/${v.latest.id}` })).statusCode).toBe(401);

    // 换一版：ETag 跟着变，官网刷新就换上；种类不对拒绝；切回不用素材又是 404
    const v2 = (await upload(ctx.app, designer, 'kind=video&name=官网首屏二', mp4(500, 9))).body as { latest: { id: number } };
    expect((await assign(designer, 'website.hero.video', v2.latest.id, v.latest.id)).status).toBe(200);
    expect((await pub('hero-video', { 'if-none-match': etag })).statusCode).toBe(200);
    const img = (await upload(ctx.app, designer, 'kind=image&name=分享图', solidPng(0x40, 0x80, 0x60))).body as { latest: { id: number } };
    expect((await assign(designer, 'website.hero.video', img.latest.id, v2.latest.id)).body.error.code).toBe('DESIGN_KIND_MISMATCH');
    expect((await assign(designer, 'website.share.image', img.latest.id, null)).status).toBe(200);
    expect((await pub('share-image')).headers['content-type']).toContain('image/png');
    expect((await assign(designer, 'website.hero.video', null, v2.latest.id)).status).toBe(200);
    expect((await pub('hero-video')).statusCode).toBe(404);
  });

  it('全公司一份：只在总店换；分店看到的是总店那一份', async () => {
    const branch = await login(ctx.app, 'dsart', 'dsart-2026x');
    const states = (await api(ctx.app, branch, 'GET', '/api/design/slots')).body as { slot: string; current: { versionId: number } | null }[];
    const share = states.find((s) => s.slot === 'website.share.image')!;
    expect(share.current).not.toBeNull();
    const refused = await assign(branch, 'website.share.image', null, share.current!.versionId);
    expect(refused.body.error.code).toBe('DESIGN_SLOT_HQ_ONLY');
    expect((await api(ctx.app, branch, 'POST', `/api/design/ops/${randomUUID()}/abandon`, { slot: 'website.share.image' })).body.error.code).toBe('DESIGN_SLOT_HQ_ONLY');
    expect((await pub('share-image')).statusCode).toBe(200);
  });
});
