// 8.2.16 业财法与审批中心导出（A3）、微信特批登记时必传 OK 截图与截图复用提示（A4，WB6、WB7），docs/V8216_GF_EXPORT.md。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, newDoc, okShot, setupPeople, yuan, type People } from './govflow-helpers';
import { hashRequest } from '../src/server/lib/idempotency';
import { todayIn } from '../src/server/lib/dates';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
// 导出按门店时区的日历日筛选；用 UTC 日期在门店零点前后（UTC 16:00 前后）会差一天
const today = () => todayIn(ctx.config.timezone);
const special = (body: Record<string, unknown> = {}) =>
  api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/specials', {
    clientKey: randomUUID(),
    title: '设备抢修',
    amountCents: yuan(500),
    reason: '设备停机',
    confirmerIds: [p.ids.gf_cfo, p.ids.gf_ceo],
    confirmedAt: new Date(Date.now() - 60_000).toISOString(),
    okScreenshot: okShot(randomUUID()),
    ...body,
  });
const xlsx = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('微信特批：登记时必传 OK 截图', () => {
  it('不传、传 PDF、内容对不上的都拒绝；登记后补登只要需求说明', async () => {
    expect((await special({ okScreenshot: undefined })).status).toBe(400);
    expect((await special({ okScreenshot: { ...okShot(), mime: 'application/pdf' } })).status).toBe(400);
    expect((await special({ okScreenshot: { ...okShot(), mime: 'image/jpeg' } })).body.error.code).toBe('GF_FILE_TYPE');
    const s = await special();
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.files.map((f: { purpose: string }) => f.purpose)).toEqual(['ok_screenshot']);
    expect(s.body.screenshotReusedIn).toEqual([]);
    const need = { purpose: 'need', fileName: '需求说明.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4 需求').toString('base64') };
    const b = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/specials/${s.body.id}/backfill`, { files: [need] });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.backfilledAt).not.toBeNull();
  });

  it('同一张截图用在两笔特批上：照样登记（只提示），两笔都标出对方', async () => {
    const shot = okShot('same-screenshot');
    const a = await special({ okScreenshot: shot });
    const b = await special({ okScreenshot: shot });
    expect(b.status).toBe(200);
    expect(b.body.screenshotReusedIn).toEqual([a.body.specialNo]);
    const list = (await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/specials')).body;
    expect(list.find((x: { id: number }) => x.id === a.body.id).screenshotReusedIn).toEqual([b.body.specialNo]);
  });
});

describe('微信特批：升级前的原请求（没有截图）按原编号查回', () => {
  it('升级前提交、没收到结果的原样重提拿回原单；换了内容的照样冲突；新登记不带截图照样拒绝', async () => {
    const base = {
      clientKey: randomUUID(),
      title: '升级前的特批',
      amountCents: yuan(300),
      reason: '设备停机',
      confirmerIds: [p.ids.gf_cfo, p.ids.gf_ceo],
      confirmedAt: new Date(Date.now() - 120_000).toISOString(),
    };
    const s = await special({ ...base, okScreenshot: okShot(randomUUID()) });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    // 模拟升级前那一笔：摘要照 8.2.16 以前的算法（解析后的请求去掉操作编号，没有截图一栏）
    const legacy = hashRequest({
      docId: null,
      title: base.title,
      amountCents: base.amountCents,
      reason: base.reason,
      confirmerIds: base.confirmerIds,
      confirmedAt: base.confirmedAt,
      payeeAccount: null,
    });
    await ctx.sql`UPDATE gf_specials SET request_hash = ${legacy} WHERE id = ${s.body.id}`;
    const again = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/specials', base);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.id).toBe(s.body.id);
    // 原请求补上截图再提，也认作同一笔
    const withShot = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/specials', { ...base, okScreenshot: okShot('later') });
    expect(withShot.body.id).toBe(s.body.id);
    const changed = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/specials', { ...base, title: '改了事项' });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const fresh = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/specials', { ...base, clientKey: randomUUID() });
    expect(fresh.status).toBe(400);
    expect(fresh.body.error.message).toBe('请上传微信里的 OK 截图');
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM gf_specials WHERE title = ${base.title}`;
    expect(n!.n).toBe(1);
  });
});

describe('导出', () => {
  it('业财法事项：店主、内控、董事长能导出，别人不能；导出写操作日志；日期反了拒绝', async () => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(500), title: '导出用事项' });
    expect(d.status).toBe(200);
    expect((await act(ctx, c('gf_head'), d.body.id, 1)).status).toBe(200);
    const url = `/api/gf/export.xlsx?from=${today()}&to=${today()}`;
    expect((await xlsx(url, c('gf_clerk'))).statusCode).toBe(403);
    expect((await xlsx(`/api/gf/export.xlsx?from=${today()}&to=2000-01-01`, ctx.owner)).statusCode).toBe(422);
    for (const who of [ctx.owner, c('gf_ic'), c('gf_chair')]) {
      const r = await xlsx(url, who);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers['content-type']).toContain('spreadsheetml');
      expect(r.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    }
    const [log] = await ctx.sql`SELECT detail FROM audit_logs WHERE action = 'export' AND target_type = 'gf_docs' ORDER BY id DESC LIMIT 1`;
    expect(log!.detail.count).toBeGreaterThanOrEqual(1);
  });

  it('审批中心：只有店主能导出', async () => {
    const url = `/api/approvals/export.xlsx?from=${today()}&to=${today()}`;
    expect((await xlsx(url, c('gf_clerk'))).statusCode).toBe(403);
    const r = await xlsx(url, ctx.owner);
    expect(r.statusCode, r.body).toBe(200);
    const [log] = await ctx.sql`SELECT detail FROM audit_logs WHERE action = 'export' AND target_type = 'approval_requests' ORDER BY id DESC LIMIT 1`;
    expect(log).toBeDefined();
  });

  it('审批中心：「审批规则」委派给了别人，还要能用审批中心才能导出（与审批列表同一个门槛）', async () => {
    const url = `/api/approvals/export.xlsx?from=${today()}&to=${today()}`;
    const grant = (add: string[]) =>
      ctx.sql`INSERT INTO settings (key, value) VALUES ('role_permissions', ${ctx.sql.json({ clerk: { add, remove: [] } })})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    try {
      await grant(['approval.rules']);
      expect((await api(ctx.app, c('gf_clerk'), 'GET', '/api/approvals')).status).toBe(403);
      expect((await xlsx(url, c('gf_clerk'))).statusCode).toBe(403);
      await grant(['approval.rules', 'approval.act']);
      const r = await xlsx(url, c('gf_clerk'));
      expect(r.statusCode, r.body).toBe(200);
      // 只能用审批中心、没有「审批规则」的照旧不能导出
      await grant(['approval.act']);
      expect((await xlsx(url, c('gf_clerk'))).statusCode).toBe(403);
    } finally {
      await ctx.sql`DELETE FROM settings WHERE key = 'role_permissions'`;
    }
  });

  it('范围里事项超过上限、按状态筛下来不多的照样能导出；筛下来仍超过的拒绝（8.2.16 Codex 审查后补）', async () => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(300), title: '按状态导出' });
    expect(d.status).toBe(200);
    // 再造 2,100 项已撤回的（直接写库，只为凑数量）
    await ctx.sql`
      INSERT INTO gf_docs (biz_no, doc_type, title, department_id, amount_cents, client_key, request_hash, created_by, withdrawn_at, withdrawn_by)
      SELECT 'EXP-' || g, doc_type, '凑数', department_id, amount_cents, gen_random_uuid(), 'x', created_by, now(), created_by
      FROM gf_docs, generate_series(1, 2100) g WHERE id = ${d.body.id}`;
    const base = `/api/gf/export.xlsx?from=${today()}&to=${today()}`;
    const all = await xlsx(base, ctx.owner);
    expect(all.statusCode).toBe(422);
    expect(JSON.parse(all.body).error.code).toBe('EXPORT_TOO_LARGE');
    expect((await xlsx(`${base}&status=withdrawn`, ctx.owner)).statusCode).toBe(422);
    const r = await xlsx(`${base}&status=reviewing`, ctx.owner);
    expect(r.statusCode, r.body).toBe(200);
    const [log] = await ctx.sql`SELECT detail FROM audit_logs WHERE action = 'export' AND target_type = 'gf_docs' ORDER BY id DESC LIMIT 1`;
    expect(log!.detail.count).toBeGreaterThanOrEqual(1);
    expect(log!.detail.count).toBeLessThan(10);
  }, 120_000);
});
