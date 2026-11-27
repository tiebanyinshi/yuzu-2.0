// 8.2.16 业财法与审批中心导出（A3）、微信特批登记时必传 OK 截图与截图复用提示（A4，WB6、WB7），docs/V8216_GF_EXPORT.md。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, newDoc, okShot, setupPeople, yuan, type People } from './govflow-helpers';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
const today = () => new Date().toISOString().slice(0, 10);
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
});
