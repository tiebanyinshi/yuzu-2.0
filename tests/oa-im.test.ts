// OA-14 即时通讯（docs/OA.md 第 17 节）：单聊同两人只有一个；建群（至少 3 人、带操作编号、群主、系统提示）；
// 发文本（带操作编号，原样重提不发两遍、换内容拒绝）、图片与文件（只有会话成员看得到）；历史分页、取新消息；
// 撤回（发的人、2 分钟内，撤回后不给原内容）；@ 与站内通知、会话列表的未读与「有人@我」；上报已读；会话列表搜索；不在会话里的看不到。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OaAttachment } from '../src/shared/oa';
import { readersOf, type ImConversationDetail, type ImConversationList, type ImMessagePage, type ImPollResult, type ImSent, type ImSync } from '../src/shared/oa-im';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Emp = { id: number; cookie: string };
const emp: Record<string, Emp> = {};
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const hire = async (username: string): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position: 'front.staff', password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const direct = async (a: Emp, b: Emp) => {
  const r = await api<{ id: number }>(ctx.app, a.cookie, 'POST', '/api/oa/im/direct', { staffId: b.id });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id;
};
const say = (who: Emp, conv: number, body: object, clientKey = randomUUID()) =>
  api<ImSent>(ctx.app, who.cookie, 'POST', `/api/oa/im/conversations/${conv}/messages`, { clientKey, kind: 'text', ...body });
const list = async (who: Emp, q = '') => (await api<ImConversationList>(ctx.app, who.cookie, 'GET', `/api/oa/im/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`)).body;
const upload = async (who: Emp) => {
  const r = await api<OaAttachment>(ctx.app, who.cookie, 'POST', '/api/oa/attachments', {
    clientKey: randomUUID(),
    fileName: 'a.jpg',
    mime: 'image/jpeg',
    data: JPEG.toString('base64'),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

beforeAll(async () => {
  ctx = await setup();
  for (const n of ['a', 'b', 'c', 'd']) emp[n] = await hire(`im_${n}`);
});
afterAll(async () => {
  await ctx.close();
});

describe('OA-14 即时通讯', () => {
  let dm: number;
  let group: number;
  let picId: number;

  it('单聊：同两个人只有一个；不能和自己聊；离职的不行', async () => {
    dm = await direct(emp.a!, emp.b!);
    expect(await direct(emp.b!, emp.a!)).toBe(dm);
    expect(code(await api(ctx.app, emp.a!.cookie, 'POST', '/api/oa/im/direct', { staffId: emp.a!.id }))).toBe('IM_SELF');
    const d = (await api<ImConversationDetail>(ctx.app, emp.a!.cookie, 'GET', `/api/oa/im/conversations/${dm}`)).body;
    expect(d).toMatchObject({ kind: 'direct', title: 'im_b' });
    expect((await api(ctx.app, emp.c!.cookie, 'GET', `/api/oa/im/conversations/${dm}`)).status).toBe(404);
  });

  it('发文本：带操作编号原样重提不发两遍、换内容拒绝；空消息拒绝；不在会话里的不能发', async () => {
    const key = randomUUID();
    const r1 = await say(emp.a!, dm, { body: '你好 😀' }, key);
    expect(r1.status).toBe(201);
    const r2 = await say(emp.a!, dm, { body: '你好 😀' }, key);
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ replayed: true, message: { id: r1.body.message.id } });
    expect(code(await say(emp.a!, dm, { body: '换了' }, key))).toBe('IDEMPOTENCY_CONFLICT');
    expect(code(await say(emp.a!, dm, { body: '   ' }))).toBe('MESSAGE_EMPTY');
    expect((await say(emp.c!, dm, { body: 'x' })).status).toBe(404);
    // b 的会话列表：未读 1、摘要
    const l = await list(emp.b!);
    expect(l.items.find((x) => x.id === dm)).toMatchObject({ title: 'im_a', preview: '你好 😀', unread: 1, mentioned: false });
    expect(l.unread).toBe(1);
    // 未读合计按全部会话算，不受搜索、列表条数影响
    expect((await list(emp.b!, '搜不到的')).unread).toBe(1);
    // 上报已读：未读清零；不会超过最新的一条
    const read = await api<{ lastReadMessageId: number }>(ctx.app, emp.b!.cookie, 'POST', `/api/oa/im/conversations/${dm}/read`, { upTo: 999999 });
    expect(read.body.lastReadMessageId).toBe(r1.body.message.id);
    expect((await list(emp.b!)).unread).toBe(0);
  });

  it('建群：至少 3 人、带操作编号、群主、系统提示；@ 成员与 @所有人发通知，列表标「有人@我」', async () => {
    const tooSmall = await api(ctx.app, emp.a!.cookie, 'POST', '/api/oa/im/groups', { clientKey: randomUUID(), name: '小', memberIds: [emp.b!.id] });
    expect(code(tooSmall)).toBe('GROUP_TOO_SMALL');
    const key = randomUUID();
    const body = { clientKey: key, name: '前厅群', memberIds: [emp.b!.id, emp.c!.id] };
    const g = await api<{ id: number; replayed: boolean }>(ctx.app, emp.a!.cookie, 'POST', '/api/oa/im/groups', body);
    expect(g.status).toBe(201);
    group = g.body.id;
    expect((await api<{ id: number; replayed: boolean }>(ctx.app, emp.a!.cookie, 'POST', '/api/oa/im/groups', body)).body).toEqual({ id: group, replayed: true });
    // 同一个编号换了内容：拒绝；查回（只能查自己的）；确认作废以后原样重提不再建群
    expect(code(await api(ctx.app, emp.a!.cookie, 'POST', '/api/oa/im/groups', { ...body, name: '改了名' }))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(ctx.app, emp.a!.cookie, 'GET', `/api/erp/ops/${key}?type=oa_im_group`)).body).toMatchObject({ found: true, refId: group });
    expect((await api(ctx.app, emp.b!.cookie, 'GET', `/api/erp/ops/${key}?type=oa_im_group`)).status).toBe(403);
    const late = randomUUID();
    expect((await api(ctx.app, emp.a!.cookie, 'POST', `/api/erp/ops/${late}/abandon`, { type: 'oa_im_group', summary: '建群' })).status).toBe(200);
    expect((await api(ctx.app, emp.a!.cookie, 'POST', '/api/oa/im/groups', { ...body, clientKey: late })).status).toBe(409);
    const d = (await api<ImConversationDetail>(ctx.app, emp.c!.cookie, 'GET', `/api/oa/im/conversations/${group}`)).body;
    expect(d.members.map((m) => [m.name, m.role])).toEqual([
      ['im_a', 'owner'],
      ['im_b', 'member'],
      ['im_c', 'member'],
    ]);
    const first = (await api<ImMessagePage>(ctx.app, emp.c!.cookie, 'GET', `/api/oa/im/conversations/${group}/messages`)).body;
    expect(first.messages.map((m) => [m.kind, m.body])).toEqual([['system', 'im_a创建了群聊「前厅群」']]);
    // @c（d 不是群成员，不算）
    const m = await say(emp.a!, group, { body: '@im_c 看一下', mentions: [emp.c!.id, emp.d!.id] });
    expect(m.body.message.mentions).toEqual([emp.c!.id]);
    expect((await list(emp.c!)).items.find((x) => x.id === group)).toMatchObject({ unread: 1, mentioned: true });
    expect((await list(emp.b!)).items.find((x) => x.id === group)).toMatchObject({ unread: 1, mentioned: false });
    const [n] = await ctx.sql<{ title: string; link: string }[]>`SELECT title, link FROM oa_notifications WHERE staff_id = ${emp.c!.id} AND kind = 'im_message' AND ref_type = 'oa_im_message'`;
    expect(n).toMatchObject({ title: 'im_a在「前厅群」里@了你', link: `/oa/im/${group}` });
    await say(emp.c!, group, { body: '大家注意', mentionAll: true });
    expect((await ctx.sql`SELECT 1 FROM oa_notifications WHERE kind = 'im_message' AND ref_type = 'oa_im_message' AND staff_id IN (${emp.a!.id}, ${emp.b!.id})`).length).toBe(2);
    // 看过以后 @ 通知记已读；只清读到的位置之前的：之后刚到的 @ 照旧提醒（OA-15 的新消息通知也一样：还有没读的就不清）
    const m2 = await say(emp.b!, group, { body: '@im_c 还有这个', mentions: [emp.c!.id] });
    await api(ctx.app, emp.c!.cookie, 'POST', `/api/oa/im/conversations/${group}/read`, { upTo: m.body.message.id });
    const unread = await ctx.sql<{ refId: number }[]>`SELECT ref_id FROM oa_notifications WHERE staff_id = ${emp.c!.id} AND kind = 'im_message' AND ref_type = 'oa_im_message' AND read_at IS NULL`;
    expect(unread.map((x) => Number(x.refId))).toEqual([m2.body.message.id]);
    await api(ctx.app, emp.c!.cookie, 'POST', `/api/oa/im/conversations/${group}/read`, { upTo: m2.body.message.id });
    expect((await ctx.sql`SELECT 1 FROM oa_notifications WHERE staff_id = ${emp.c!.id} AND kind = 'im_message' AND read_at IS NULL`).length).toBe(0);
    // 单聊里的 @ 不算
    expect((await say(emp.a!, dm, { body: 'x', mentionAll: true })).body.message.mentionAll).toBe(false);
  });

  it('图片：只有会话成员看得到附件；发图片要选图片', async () => {
    const pic = await upload(emp.a!);
    picId = pic.id;
    const r = await api<ImSent>(ctx.app, emp.a!.cookie, 'POST', `/api/oa/im/conversations/${group}/messages`, { clientKey: randomUUID(), kind: 'image', attachmentId: pic.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.message.attachment).toMatchObject({ id: pic.id, isImage: true });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/oa/attachments/${pic.id}`, headers: { cookie: emp.b!.cookie } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/oa/attachments/${pic.id}`, headers: { cookie: emp.d!.cookie } })).statusCode).toBe(404);
    expect(code(await api(ctx.app, emp.a!.cookie, 'POST', `/api/oa/im/conversations/${group}/messages`, { clientKey: randomUUID(), kind: 'file' }))).toBe('ATTACHMENT_INVALID');
    expect((await list(emp.b!)).items.find((x) => x.id === group)!.preview).toBe('[图片]');
  });

  it('撤回：只能撤自己的、2 分钟内；撤回以后不给原内容，取新消息带上撤回的', async () => {
    const r = await say(emp.b!, group, { body: '说错了' });
    const id = r.body.message.id;
    expect((await api(ctx.app, emp.a!.cookie, 'POST', `/api/oa/im/messages/${id}/revoke`)).status).toBe(403);
    const before = (await api<ImPollResult>(ctx.app, emp.a!.cookie, 'GET', `/api/oa/im/conversations/${group}/poll?after=${id - 1}`)).body;
    expect(before.messages.map((m) => m.body)).toEqual(['说错了']);
    const rv = await api<{ revoked: boolean; body: string }>(ctx.app, emp.b!.cookie, 'POST', `/api/oa/im/messages/${id}/revoke`);
    expect(rv.body).toMatchObject({ revoked: true, body: '' });
    expect((await api(ctx.app, emp.b!.cookie, 'POST', `/api/oa/im/messages/${id}/revoke`)).status).toBe(200);
    const after = (await api<ImPollResult>(ctx.app, emp.a!.cookie, 'GET', `/api/oa/im/conversations/${group}/poll?after=${id}`)).body;
    expect(after).toMatchObject({ messages: [], revoked: [id] });
    // 按 since 续传：上次同步在撤回以前（哪怕是很久以前）就给出；在撤回以后好一阵的不再给
    const longAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect((await api<ImPollResult>(ctx.app, emp.a!.cookie, 'GET', `/api/oa/im/conversations/${group}/poll?after=${id}&since=${encodeURIComponent(longAgo)}`)).body.revoked).toEqual([id]);
    const later = new Date(Date.now() + 120_000).toISOString();
    expect((await api<ImPollResult>(ctx.app, emp.a!.cookie, 'GET', `/api/oa/im/conversations/${group}/poll?after=${id}&since=${encodeURIComponent(later)}`)).body.revoked).toEqual([]);
    expect((await list(emp.a!)).items.find((x) => x.id === group)!.preview).toBe('im_b撤回了一条消息');
    // 带 @ 的消息撤回以后，通知里抄的正文也换掉
    const at = await say(emp.b!, group, { body: '@im_a 机密内容', mentions: [emp.a!.id] });
    await api(ctx.app, emp.b!.cookie, 'POST', `/api/oa/im/messages/${at.body.message.id}/revoke`);
    const [nb] = await ctx.sql<{ body: string }[]>`SELECT body FROM oa_notifications WHERE ref_type = 'oa_im_message' AND ref_id = ${at.body.message.id}`;
    expect(nb!.body).toBe('im_b撤回了这条消息');
    const old = await say(emp.b!, group, { body: '太久了' });
    await ctx.sql`UPDATE oa_im_messages SET created_at = now() - interval '3 minutes' WHERE id = ${old.body.message.id}`;
    expect(code(await api(ctx.app, emp.b!.cookie, 'POST', `/api/oa/im/messages/${old.body.message.id}/revoke`))).toBe('REVOKE_TOO_LATE');
  });

  it('历史分页：往上翻取更早的；会话列表按最后一条倒序、能按名字与消息文字搜', async () => {
    for (let i = 0; i < 35; i += 1) await say(emp.a!, dm, { body: `第${i}条` });
    const p1 = (await api<ImMessagePage>(ctx.app, emp.b!.cookie, 'GET', `/api/oa/im/conversations/${dm}/messages`)).body;
    expect(p1.messages).toHaveLength(30);
    expect(p1.hasMore).toBe(true);
    expect(p1.messages.at(-1)!.body).toBe('第34条');
    const p2 = (await api<ImMessagePage>(ctx.app, emp.b!.cookie, 'GET', `/api/oa/im/conversations/${dm}/messages?before=${p1.messages[0]!.id}`)).body;
    expect(p2.hasMore).toBe(false);
    expect(p2.messages[0]!.body).toBe('你好 😀');
    expect((await list(emp.a!)).items[0]!.id).toBe(dm);
    expect((await list(emp.a!, '前厅')).items.map((x) => x.id)).toEqual([group]);
    expect((await list(emp.a!, '第3')).items.map((x) => x.id)).toEqual([dm]);
    expect((await list(emp.a!, 'im_c')).items.map((x) => x.id)).toEqual([group]);
    // 撤回的消息搜不到
    expect((await list(emp.a!, '说错了')).items).toEqual([]);
    expect((await list(emp.d!)).items).toEqual([]);
  });

  it('退出群聊：成员能退（群主、单聊不能），退出以后看不到；建群有限额', async () => {
    expect(code(await api(ctx.app, emp.a!.cookie, 'POST', `/api/oa/im/conversations/${group}/leave`))).toBe('IM_OWNER_LEAVE');
    expect(code(await api(ctx.app, emp.a!.cookie, 'POST', `/api/oa/im/conversations/${dm}/leave`))).toBe('IM_LEAVE_DIRECT');
    expect((await api(ctx.app, emp.c!.cookie, 'POST', `/api/oa/im/conversations/${group}/leave`)).status).toBe(200);
    expect((await api(ctx.app, emp.c!.cookie, 'POST', `/api/oa/im/conversations/${group}/leave`)).status).toBe(200);
    expect((await api(ctx.app, emp.c!.cookie, 'GET', `/api/oa/im/conversations/${group}`)).status).toBe(404);
    expect((await list(emp.c!)).items.some((x) => x.id === group)).toBe(false);
    expect((await say(emp.c!, group, { body: 'x' })).status).toBe(404);
    const p = (await api<ImMessagePage>(ctx.app, emp.a!.cookie, 'GET', `/api/oa/im/conversations/${group}/messages`)).body;
    expect(p.messages.at(-1)).toMatchObject({ kind: 'system', body: 'im_c退出了群聊' });
    // 限额：10 分钟内最多建 10 个
    const mk = () => api(ctx.app, emp.d!.cookie, 'POST', '/api/oa/im/groups', { clientKey: randomUUID(), name: '刷屏', memberIds: [emp.b!.id, emp.c!.id] });
    for (let i = 0; i < 10; i += 1) expect((await mk()).status).toBe(201);
    expect(code(await mk())).toBe('GROUP_QUOTA');
  });

  it('专用账号（平板、他店、设计师）不能用即时通讯：接口一律 403，也不能被拉进会话', async () => {
    for (const role of ['tablet', 'other_store', 'designer'] as const) {
      const username = `im_${role}`;
      const id = await createStaff(ctx.sql, { username, displayName: username, role, password: PASSWORD, mustChangePassword: false });
      const cookie = await login(ctx.app, username);
      expect((await api(ctx.app, cookie, 'GET', '/api/oa/im/conversations')).status).toBe(403);
      expect((await api(ctx.app, cookie, 'POST', '/api/oa/im/direct', { staffId: emp.a!.id })).status).toBe(403);
      expect((await api(ctx.app, cookie, 'GET', `/api/oa/im/conversations/${dm}/messages`)).status).toBe(403);
      expect((await api(ctx.app, emp.a!.cookie, 'POST', '/api/oa/im/direct', { staffId: id })).status).toBe(404);
    }
    // 原来是员工、后来改成专用账号的：成员记录还在，也看不到聊天文件
    const get = () => ctx.app.inject({ method: 'GET', url: `/api/oa/attachments/${picId}`, headers: { cookie: emp.b!.cookie } });
    expect((await get()).statusCode).toBe(200);
    await ctx.sql`UPDATE staff SET role = 'designer' WHERE id = ${emp.b!.id}`;
    expect((await get()).statusCode).toBe(404);
    // 上传的人自己也一样（a 传的图片，a 改成设计师以后也下载不了）
    const own = () => ctx.app.inject({ method: 'GET', url: `/api/oa/attachments/${picId}`, headers: { cookie: emp.a!.cookie } });
    expect((await own()).statusCode).toBe(200);
    await ctx.sql`UPDATE staff SET role = 'designer' WHERE id = ${emp.a!.id}`;
    expect((await own()).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/oa/attachments/${picId}/thumb`, headers: { cookie: emp.a!.cookie } })).statusCode).toBe(404);
    // 改成专用账号以后，原来的 @ 通知也不再给出（通知列表与未读数都不算）
    expect((await ctx.sql`SELECT 1 FROM oa_notifications WHERE staff_id = ${emp.a!.id} AND kind = 'im_message'`).length).toBeGreaterThan(0);
    const page = (await api<{ items: { kind: string }[] }>(ctx.app, emp.a!.cookie, 'GET', '/api/oa/notifications')).body;
    expect(page.items.some((n) => n.kind === 'im_message')).toBe(false);
  });
});

// OA-15 已读回执与实时通道（docs/OA.md 第 18 节）：回执按各成员读到的位置算；统一的同步接口；新消息进站内通知（每个会话没读的只留一条，读完才清，退出或改成专用账号的看不到）
describe('OA-15 已读回执与实时通道', () => {
  const e: Record<string, Emp> = {};
  beforeAll(async () => {
    for (const n of ['p', 'q', 'r']) e[n] = await hire(`im15_${n}`);
  });
  const sync = async (who: Emp) => (await api<ImSync>(ctx.app, who.cookie, 'GET', '/api/oa/im/sync')).body;
  const convNotes = (who: Emp, conv: number) =>
    ctx.sql<{ title: string; body: string; link: string; readAt: Date | null }[]>`
      SELECT title, body, link, read_at FROM oa_notifications WHERE staff_id = ${who.id} AND kind = 'im_message' AND ref_type = 'oa_im_conversation' AND ref_id = ${conv} ORDER BY id`;

  it('单聊回执：对方没读是未读、读到了是已读；取历史与取新消息都带回各成员读到哪一条', async () => {
    const dm = await direct(e.p!, e.q!);
    const m1 = (await say(e.p!, dm, { body: '在吗' })).body.message;
    const page = (await api<ImMessagePage>(ctx.app, e.p!.cookie, 'GET', `/api/oa/im/conversations/${dm}/messages`)).body;
    expect(page.reads).toEqual([{ staffId: e.q!.id, lastRead: 0 }]);
    const d = (await api<ImConversationDetail>(ctx.app, e.p!.cookie, 'GET', `/api/oa/im/conversations/${dm}`)).body;
    expect(readersOf(m1.id, d.members, page.reads).unread.map((x) => x.staffId)).toEqual([e.q!.id]);
    await api(ctx.app, e.q!.cookie, 'POST', `/api/oa/im/conversations/${dm}/read`, { upTo: m1.id });
    const poll = (await api<ImPollResult>(ctx.app, e.p!.cookie, 'GET', `/api/oa/im/conversations/${dm}/poll?after=${m1.id}`)).body;
    expect(poll.reads).toEqual([{ staffId: e.q!.id, lastRead: m1.id }]);
    expect(readersOf(m1.id, d.members, poll.reads)).toMatchObject({ read: [{ staffId: e.q!.id }], unread: [] });
  });

  it('群回执：几人已读、谁读了谁没读；退出群的不再算', async () => {
    const g = (await api<{ id: number }>(ctx.app, e.p!.cookie, 'POST', '/api/oa/im/groups', { clientKey: randomUUID(), name: '回执群', memberIds: [e.q!.id, e.r!.id] })).body.id;
    const m = (await say(e.p!, g, { body: '明早开会' })).body.message;
    await api(ctx.app, e.q!.cookie, 'POST', `/api/oa/im/conversations/${g}/read`, { upTo: m.id });
    const d = (await api<ImConversationDetail>(ctx.app, e.p!.cookie, 'GET', `/api/oa/im/conversations/${g}`)).body;
    let reads = (await api<ImMessagePage>(ctx.app, e.p!.cookie, 'GET', `/api/oa/im/conversations/${g}/messages`)).body.reads;
    const rs = readersOf(m.id, d.members, reads);
    expect(rs.read.map((x) => x.name)).toEqual(['im15_q']);
    expect(rs.unread.map((x) => x.name)).toEqual(['im15_r']);
    await api(ctx.app, e.r!.cookie, 'POST', `/api/oa/im/conversations/${g}/leave`);
    reads = (await api<ImMessagePage>(ctx.app, e.p!.cookie, 'GET', `/api/oa/im/conversations/${g}/messages`)).body.reads;
    expect(reads.map((x) => x.staffId)).toEqual([e.q!.id]);
  });

  it('统一的同步接口：未读合计与最新一条消息编号，发新消息、读完都跟着变', async () => {
    const before = await sync(e.r!);
    const dm = await direct(e.q!, e.r!);
    const m = (await say(e.q!, dm, { body: '换班' })).body.message;
    const after = await sync(e.r!);
    expect(after).toEqual({ unread: before.unread + 1, lastMessageId: m.id, revokedAt: before.revokedAt });
    await api(ctx.app, e.r!.cookie, 'POST', `/api/oa/im/conversations/${dm}/read`, { upTo: m.id });
    expect(await sync(e.r!)).toEqual({ unread: before.unread, lastMessageId: m.id, revokedAt: before.revokedAt });
    expect((await list(e.r!)).unread).toBe(before.unread);
    // 撤回不产生新消息，同步接口靠撤回时间发现（会话列表的摘要要跟着变）
    expect((await api(ctx.app, e.q!.cookie, 'POST', `/api/oa/im/messages/${m.id}/revoke`)).status).toBe(200);
    const revoked = await sync(e.r!);
    expect(revoked.lastMessageId).toBe(m.id);
    expect(revoked.revokedAt).not.toBe(before.revokedAt);
  });

  it('新消息通知：其余成员每个会话一条（不抄正文），再来消息不加条；读完才清，之后再来照旧提醒；系统提示不发', async () => {
    const g = (await api<{ id: number }>(ctx.app, e.p!.cookie, 'POST', '/api/oa/im/groups', { clientKey: randomUUID(), name: '通知群', memberIds: [e.q!.id, e.r!.id] })).body.id;
    expect(await convNotes(e.q!, g)).toEqual([]);
    const m1 = (await say(e.p!, g, { body: '机密内容' })).body.message;
    const m2 = (await say(e.p!, g, { body: '第二句' })).body.message;
    const n = await convNotes(e.q!, g);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ title: '「通知群」有新消息', body: '', link: `/oa/im/${g}`, readAt: null });
    expect(await convNotes(e.p!, g)).toEqual([]);
    // 读到一半不清
    await api(ctx.app, e.q!.cookie, 'POST', `/api/oa/im/conversations/${g}/read`, { upTo: m1.id });
    expect((await convNotes(e.q!, g))[0]!.readAt).toBeNull();
    await api(ctx.app, e.q!.cookie, 'POST', `/api/oa/im/conversations/${g}/read`, { upTo: m2.id });
    expect((await convNotes(e.q!, g))[0]!.readAt).not.toBeNull();
    // 自己发的不算没读：q 回一句以后自己仍然读完了
    await say(e.q!, g, { body: '收到' });
    expect((await convNotes(e.q!, g)).filter((x) => !x.readAt)).toHaveLength(0);
    await say(e.p!, g, { body: '第三句' });
    expect((await convNotes(e.q!, g)).filter((x) => !x.readAt)).toHaveLength(1);
    // 单聊的标题写谁发来的
    const dm = await direct(e.p!, e.r!);
    await say(e.p!, dm, { body: 'hi' });
    expect((await convNotes(e.r!, dm))[0]).toMatchObject({ title: 'im15_p发来新消息' });
    // 通知列表能看到；退出群以后这个群的通知不再给出
    const notes = async () => (await api<{ items: { kind: string; link: string }[] }>(ctx.app, e.r!.cookie, 'GET', '/api/oa/notifications')).body.items.filter((x) => x.kind === 'im_message');
    expect((await notes()).map((x) => x.link)).toEqual(expect.arrayContaining([`/oa/im/${g}`, `/oa/im/${dm}`]));
    await api(ctx.app, e.r!.cookie, 'POST', `/api/oa/im/conversations/${g}/leave`);
    expect((await notes()).some((x) => x.link === `/oa/im/${g}`)).toBe(false);
    expect((await notes()).some((x) => x.link === `/oa/im/${dm}`)).toBe(true);
  });

  it('上报已读与在途的发消息串行：读到旧的那条时，正在发的新消息的通知不被清掉', async () => {
    const dm = await direct(e.r!, e.p!);
    const m1 = (await say(e.r!, dm, { body: '第一句' })).body.message;
    let reading: Promise<unknown> | undefined;
    await ctx.sql.begin(async (tx) => {
      // 模拟发送事务：锁会话行、插新消息、刷新通知，还没提交时对方上报读到第一句
      await tx`SELECT 1 FROM oa_im_conversations WHERE id = ${dm} FOR UPDATE`;
      await tx`INSERT INTO oa_im_messages (conversation_id, sender_id, kind, body) VALUES (${dm}, ${e.r!.id}, 'text', '第二句')`;
      await tx`UPDATE oa_notifications SET refreshed_at = now() WHERE staff_id = ${e.p!.id} AND ref_type = 'oa_im_conversation' AND ref_id = ${dm}`;
      reading = api(ctx.app, e.p!.cookie, 'POST', `/api/oa/im/conversations/${dm}/read`, { upTo: m1.id });
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(((await reading) as { status: number }).status).toBe(200);
    expect((await convNotes(e.p!, dm)).filter((x) => !x.readAt)).toHaveLength(1);
  });
});
