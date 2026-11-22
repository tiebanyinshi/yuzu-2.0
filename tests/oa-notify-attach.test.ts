// OA-03 站内通知与附件（docs/OA.md 第 6 节）：notify() 发通知（同一件事没读的只留一条）、列表分页、未读数、标已读、只看自己的；
// 外发通道；附件上传（格式核对、缩略图）、下载头、谁能看、挂到单据上。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationPage, OaAttachment } from '../src/shared/oa';
import { attachmentsOf, bindAttachments, registerAttachmentRef } from '../src/server/modules/oa/attachments';
import { notify, registerNotifyChannel } from '../src/server/modules/oa/notifications';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let ownerId: number;
let clerkId: number;
beforeAll(async () => {
  ctx = await setup();
  const rows = await ctx.sql<{ id: number; username: string }[]>`SELECT id, username FROM staff WHERE username IN ('owner', 'clerk')`;
  ownerId = Number(rows.find((r) => r.username === 'owner')!.id);
  clerkId = Number(rows.find((r) => r.username === 'clerk')!.id);
});
afterAll(async () => ctx.close());

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const b64 = (b: Buffer) => b.toString('base64');
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

describe('OA-03 站内通知', () => {
  it('发通知：同一件事没读的只留一条；未读数、分页、标已读；只看得到自己的；外发通道收到', async () => {
    const sent: number[][] = [];
    registerNotifyChannel((ids) => sent.push([...ids]));
    await notify(ctx.sql, [clerkId], { kind: 'schedule_change', title: '排班变了', body: '明天早班', link: '/oa', ref: { type: 'schedule', id: 7 } });
    await notify(ctx.sql, [clerkId], { kind: 'schedule_change', title: '排班又变了', body: '明天晚班', link: '/oa', ref: { type: 'schedule', id: 7 } });
    for (let i = 0; i < 31; i += 1) await notify(ctx.sql, [clerkId, clerkId], { kind: 'system', title: `第 ${i} 条` });
    expect(sent).toHaveLength(33);
    expect(sent[2]).toEqual([clerkId]);

    let r = await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications/unread-count');
    expect(r.body).toEqual({ unread: 32 });
    r = await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications');
    const page = r.body as NotificationPage;
    expect(page.items).toHaveLength(30);
    expect(page.items[0]!.title).toBe('第 30 条');
    expect(page.nextBefore).not.toBeNull();
    r = await api(ctx.app, ctx.clerk, 'GET', `/api/oa/notifications?before=${page.nextBefore}`);
    const rest = (r.body as NotificationPage).items;
    expect(rest.map((x) => x.title)).toEqual(['第 0 条', '排班又变了']);
    expect(rest[1]).toMatchObject({ kind: 'schedule_change', body: '明天晚班', link: '/oa', readAt: null });

    // 别人看不到、标不了
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/oa/notifications')).body).toMatchObject({ items: [], unread: 0 });
    await api(ctx.app, ctx.owner, 'POST', '/api/oa/notifications/read', { all: true });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications/unread-count')).body).toEqual({ unread: 32 });

    // 标一条已读；读过以后同一件事再发，是新的一条
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/notifications/read', { ids: [rest[1]!.id] });
    expect(r.body).toEqual({ unread: 31 });
    await notify(ctx.sql, [clerkId], { kind: 'schedule_change', title: '排班第三次变', ref: { type: 'schedule', id: 7 } });
    r = await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications?status=unread');
    expect((r.body as NotificationPage).items[0]!.title).toBe('排班第三次变');
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/notifications/read', { all: true });
    expect(r.body).toEqual({ unread: 0 });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/oa/notifications/read', { ids: [] })).status).toBe(400);
  });
});

describe('OA-03 附件', () => {
  it('上传：核对格式与扩展名、缩略图；下载头；没挂到单据上只有上传的人看得到', async () => {
    let r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { fileName: '证明.png', mime: 'image/png', data: b64(PNG), thumb: b64(JPEG) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const img = r.body as OaAttachment;
    expect(img).toMatchObject({ fileName: '证明.png', isImage: true, hasThumb: true, sizeBytes: PNG.length });

    // 扩展名或文件头对不上
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { fileName: '证明.pdf', mime: 'application/pdf', data: b64(PNG) });
    expect(code(r)).toBe('ATTACHMENT_INVALID');
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { fileName: '证明.jpg', mime: 'image/png', data: b64(PNG) });
    expect(code(r)).toBe('ATTACHMENT_INVALID');
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { fileName: 'a.exe', mime: 'application/x-msdownload', data: b64(PNG) });
    expect(r.status).toBe(400);
    // 非图片不能带缩略图；缩略图不是 JPEG
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { fileName: 'a.txt', mime: 'text/plain', data: b64(Buffer.from('你好')), thumb: b64(JPEG) });
    expect(code(r)).toBe('ATTACHMENT_INVALID');
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { fileName: 'b.png', mime: 'image/png', data: b64(PNG), thumb: b64(PNG) });
    expect(code(r)).toBe('ATTACHMENT_INVALID');

    // 文本：当附件下载、nosniff
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { fileName: '说明.txt', mime: 'text/plain', data: b64(Buffer.from('<script>x</script>')) });
    const txt = r.body as OaAttachment;
    const dl = await ctx.app.inject({ method: 'GET', url: txt.url, headers: { cookie: ctx.clerk } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    const pic = await ctx.app.inject({ method: 'GET', url: img.url, headers: { cookie: ctx.clerk } });
    expect(pic.headers['content-disposition']).toMatch(/^inline/);
    const th = await ctx.app.inject({ method: 'GET', url: img.thumbUrl!, headers: { cookie: ctx.clerk } });
    expect(th.headers['content-type']).toBe('image/jpeg');
    expect(th.rawPayload.equals(JPEG)).toBe(true);

    // 别人：当不存在
    expect((await ctx.app.inject({ method: 'GET', url: img.url, headers: { cookie: ctx.owner } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/oa/attachments/999999', headers: { cookie: ctx.clerk } })).statusCode).toBe(404);
  });

  it('挂到单据上：只能挂自己传的、没挂过的；挂上以后按单据登记的办法看', async () => {
    const up = async (cookie: string, name: string) => (await api(ctx.app, cookie, 'POST', '/api/oa/attachments', { fileName: name, mime: 'image/png', data: b64(PNG) })).body as OaAttachment;
    const a = await up(ctx.clerk, 'a.png');
    const b = await up(ctx.clerk, 'b.png');
    const other = await up(ctx.owner, 'c.png');
    registerAttachmentRef('test_doc', async (_db, actor, refId) => refId === 42 && actor.id === ownerId);
    const clerk = { id: clerkId } as Parameters<typeof bindAttachments>[2];
    // 别人的附件挂不上
    await expect(ctx.sql.begin((tx) => bindAttachments(tx, [a.id, other.id], clerk, { type: 'test_doc', id: 42 }))).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' });
    await ctx.sql.begin((tx) => bindAttachments(tx, [a.id, b.id], clerk, { type: 'test_doc', id: 42 }));
    // 挂过的不能再挂
    await expect(ctx.sql.begin((tx) => bindAttachments(tx, [a.id], clerk, { type: 'test_doc', id: 43 }))).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' });
    expect((await attachmentsOf(ctx.sql, { type: 'test_doc', id: 42 })).map((x) => x.fileName)).toEqual(['a.png', 'b.png']);
    // 单据的查看权限放行了总裁
    expect((await ctx.app.inject({ method: 'GET', url: a.url, headers: { cookie: ctx.owner } })).statusCode).toBe(200);
  });
});
