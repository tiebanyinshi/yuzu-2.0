// OA-07 人脸录入与审核（docs/OA.md 第 10 节）：员工提交 3 张（同一人同时只有一份待审核、原样重提、别人重提不了）、
// 后台退回（要原因）与通过（旧的记 replaced）、停用、站内通知与审计、照片谁能看；
// 打卡（考勤组要人脸）：没自拍、没通过录入、比对不通过都拒绝，通过记「人脸通过」并挂上自拍；比对服务不可用记「待人工核对」。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttendanceSetup, FaceEnrollmentPage, FaceEnrollSaved, MyFace, NotificationPage, PunchResult, PunchToday } from '../src/shared/oa';
import { faceVerifier, verifyFace } from '../src/server/integrations/face';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Emp = { id: number; cookie: string };
let a: Emp;
let b: Emp;
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const hire = async (username: string, position: string): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const upload = async (who: Emp, fileName = '正面.jpg') => {
  const r = await api(ctx.app, who.cookie, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName, mime: 'image/jpeg', data: JPEG.toString('base64') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { id: number }).id;
};
const enroll = async (who: Emp, clientKey = randomUUID()) => {
  const photoIds = [await upload(who), await upload(who, '左.jpg'), await upload(who, '右.jpg')];
  return { photoIds, clientKey, r: await api(ctx.app, who.cookie, 'POST', '/api/oa/face/enroll', { clientKey, photoIds }) };
};
const review = (id: number, body: object, clientKey: string = randomUUID()) =>
  api(ctx.app, ctx.owner, 'POST', `/api/oa/face/enrollments/${id}/review`, { clientKey, storeId: DEFAULT_STORE_ID, ...body });
const punch = (who: Emp, body: object = {}) => api(ctx.app, who.cookie, 'POST', '/api/oa/attendance/punch', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, ...body });
const me = async (who: Emp) => (await api(ctx.app, who.cookie, 'GET', '/api/oa/face/me')).body as MyFace;

beforeAll(async () => {
  ctx = await setup();
  a = await hire('face_a', 'front.staff');
  b = await hire('face_b', 'front.staff');
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', {
    clientKey: randomUUID(),
    storeId: DEFAULT_STORE_ID,
    name: '要人脸',
    gpsRequired: false,
    faceRequired: true,
    memberIds: [a.id, b.id],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect((r.body as AttendanceSetup).groups.find((g) => g.name === '要人脸')!.faceRequired).toBe(true);
});
afterAll(async () => ctx.close());

describe('OA-07 人脸录入与审核', () => {
  it('比对服务：模拟按文件名判；没配置、出错、超时都当 unavailable', async () => {
    const photo = { fileName: 'x.jpg', mime: 'image/jpeg', data: JPEG };
    expect((await verifyFace(faceVerifier({ mock: true }), { enrolled: [photo], probe: photo })).result).toBe('pass');
    expect((await verifyFace(faceVerifier({ mock: true }), { enrolled: [photo], probe: { ...photo, fileName: 'mismatch.jpg' } })).result).toBe('fail');
    expect((await verifyFace(faceVerifier({ mock: false }), { enrolled: [photo], probe: photo })).result).toBe('unavailable');
    const broken = { verify: async () => Promise.reject(new Error('boom')) };
    expect((await verifyFace(broken, { enrolled: [photo], probe: photo })).result).toBe('unavailable');
    const slow = { verify: () => new Promise<never>(() => undefined) };
    expect((await verifyFace(slow, { enrolled: [photo], probe: photo }, 20)).result).toBe('unavailable');
  });

  it('提交：3 张、待审核；同一人同时只有一份待审核；原样重提返回原来那份；别人重提不了', async () => {
    expect((await me(a)).status).toBe('none');
    const first = await enroll(a);
    expect(first.r.status, JSON.stringify(first.r.body)).toBe(200);
    const saved = first.r.body as FaceEnrollSaved;
    expect(saved.enrollment).toMatchObject({ status: 'pending', staffId: a.id });
    expect(saved.enrollment.photos).toHaveLength(3);
    const again = await api(ctx.app, a.cookie, 'POST', '/api/oa/face/enroll', { clientKey: first.clientKey, photoIds: first.photoIds });
    expect(again.body).toMatchObject({ replayed: true, enrollment: { id: saved.enrollment.id } });
    expect((await api(ctx.app, b.cookie, 'POST', '/api/oa/face/enroll', { clientKey: first.clientKey, photoIds: first.photoIds })).status).toBe(403);
    expect(code((await enroll(a)).r)).toBe('FACE_PENDING');
    expect((await me(a)).status).toBe('pending');
    // 照片：本人、管考勤的看得到，别的员工看不到
    const url = saved.enrollment.photos[0]!.url;
    expect((await api(ctx.app, a.cookie, 'GET', url)).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', url)).status).toBe(200);
    expect((await api(ctx.app, b.cookie, 'GET', url)).status).toBe(404);
    // 员工看不了审核列表
    expect((await api(ctx.app, a.cookie, 'GET', '/api/oa/face/enrollments')).status).toBe(403);
  });

  it('退回要原因、发通知；重新提交后通过；再交一份新的，通过时旧的记 replaced；停用以后没有已通过的', async () => {
    const pending = ((await api(ctx.app, ctx.owner, 'GET', '/api/oa/face/enrollments?status=pending')).body as FaceEnrollmentPage).items;
    const mine = pending.find((x) => x.staffId === a.id)!;
    expect((await review(mine.id, { decision: 'reject' })).status).toBe(400);
    const key = randomUUID();
    let r = await review(mine.id, { decision: 'reject', note: '照片太暗' }, key);
    expect(r.body).toMatchObject({ replayed: false, enrollment: { status: 'rejected', reviewNote: '照片太暗' } });
    // 同一编号原样重提：返回原来那次；换了内容拒绝；查回得到那份录入
    expect((await review(mine.id, { decision: 'reject', note: '照片太暗' }, key)).body).toMatchObject({ replayed: true });
    expect(code(await review(mine.id, { decision: 'reject', note: '换了原因' }, key))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${key}?type=oa_face_review`)).body).toMatchObject({ found: true, refId: mine.id });
    // 确认作废的编号：原请求后到也不处理
    const late = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${late}/abandon`, { type: 'oa_face_review', summary: '人脸审核' })).status).toBe(200);
    expect(code(await review(mine.id, { decision: 'approve' }, late))).toBe('OP_ABANDONED');
    // 再点一次：原样（已经是退回）
    expect((await review(mine.id, { decision: 'reject', note: '照片太暗' })).status).toBe(200);
    expect(code(await review(mine.id, { decision: 'approve' }))).toBe('FACE_REVIEWED');
    const n = (await api(ctx.app, a.cookie, 'GET', '/api/oa/notifications?status=unread')).body as NotificationPage;
    expect(n.items[0]).toMatchObject({ title: '人脸录入被退回', link: '/oa/face' });
    expect((await me(a)).status).toBe('rejected');

    const second = (await enroll(a)).r.body as FaceEnrollSaved;
    r = await review(second.enrollment.id, { decision: 'approve' });
    expect(r.body).toMatchObject({ enrollment: { status: 'approved' } });
    expect((await me(a)).status).toBe('approved');
    const third = (await enroll(a)).r.body as FaceEnrollSaved;
    // 新的还没审：照旧用旧的
    expect(await me(a)).toMatchObject({ status: 'approved', approved: { id: second.enrollment.id }, latest: { id: third.enrollment.id } });
    await review(third.enrollment.id, { decision: 'approve' });
    expect((await ctx.sql`SELECT status FROM oa_face_enrollments WHERE id = ${second.enrollment.id}`)[0]!.status).toBe('replaced');
    expect((await me(a)).approved!.id).toBe(third.enrollment.id);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_face_reviewed'`).length).toBe(3);
  });

  it('打卡（要人脸）：没自拍、没通过录入、比对不通过都拒绝；通过记「人脸通过」并挂上自拍；自拍不能用两次；停用以后打不了', async () => {
    expect(code(await punch(a))).toBe('FACE_REQUIRED');
    expect(code(await punch(b, { faceImageId: await upload(b, 'b.jpg') }))).toBe('FACE_NOT_ENROLLED');
    expect(code(await punch(a, { faceImageId: await upload(a, 'mismatch.jpg') }))).toBe('FACE_MISMATCH');
    // 别人的照片
    expect(code(await punch(a, { faceImageId: await upload(b, 'b2.jpg') }))).toBe('ATTACHMENT_INVALID');
    const selfie = await upload(a, '自拍.jpg');
    const r = await punch(a, { faceImageId: selfie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = r.body as PunchResult;
    expect(res.punch).toMatchObject({ faceResult: 'pass', facePhoto: { id: selfie } });
    expect(code(await punch(a, { faceImageId: selfie }))).toBe('ATTACHMENT_INVALID');
    // 自拍：本人与管考勤的看得到，别的员工看不到
    expect((await api(ctx.app, ctx.owner, 'GET', res.punch.facePhoto!.url)).status).toBe(200);
    expect((await api(ctx.app, b.cookie, 'GET', res.punch.facePhoto!.url)).status).toBe(404);
    const today = (await api(ctx.app, a.cookie, 'GET', '/api/oa/attendance/today')).body as PunchToday;
    expect(today.face).toBe('approved');
    expect(today.group!.faceRequired).toBe(true);
    // 停用
    const id = (await me(a)).approved!.id;
    expect((await review(id, { decision: 'revoke' })).status).toBe(400);
    expect((await review(id, { decision: 'revoke', note: '换人了' })).body).toMatchObject({ enrollment: { status: 'revoked' } });
    expect((await me(a)).status).toBe('none');
    expect(code(await punch(a, { faceImageId: await upload(a, '自拍2.jpg') }))).toBe('FACE_NOT_ENROLLED');
  });

  it('查回、作废只能是自己的录入编号', async () => {
    const mine = await enroll(b);
    expect(mine.r.status).toBe(200);
    expect((await api(ctx.app, b.cookie, 'GET', `/api/erp/ops/${mine.clientKey}?type=oa_face_enroll`)).body).toMatchObject({ found: true });
    expect((await api(ctx.app, a.cookie, 'GET', `/api/erp/ops/${mine.clientKey}?type=oa_face_enroll`)).status).toBe(403);
  });
  it('审核列表：按姓名或登录名找；每页 50 份，带 before 翻到更早的', async () => {
    // 造 55 份已通过的（直接写库，只为翻页）
    const ids: number[] = [];
    for (let i = 0; i < 55; i += 1) {
      const e = await hire(`face_many_${i}`, 'front.staff');
      const [row] = await ctx.sql<{ id: number }[]>`
        INSERT INTO oa_face_enrollments (staff_id, status, reviewed_by, reviewed_at) VALUES (${e.id}, 'approved', ${e.id}, now()) RETURNING id`;
      ids.push(Number(row!.id));
    }
    const first = (await api(ctx.app, ctx.owner, 'GET', '/api/oa/face/enrollments?status=approved')).body as FaceEnrollmentPage;
    expect(first.items).toHaveLength(50);
    expect(first.nextBefore).not.toBeNull();
    const second = (await api(ctx.app, ctx.owner, 'GET', `/api/oa/face/enrollments?status=approved&before=${first.nextBefore}`)).body as FaceEnrollmentPage;
    const all = new Set([...first.items, ...second.items].map((x) => x.id));
    for (const id of ids) expect(all.has(id)).toBe(true);
    expect(second.nextBefore).toBeNull();
    const found = (await api(ctx.app, ctx.owner, 'GET', '/api/oa/face/enrollments?status=approved&q=face_many_7')).body as FaceEnrollmentPage;
    expect(found.items.map((x) => x.staffName).sort()).toEqual(['face_many_7']);
    // 通配符当普通字符
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/oa/face/enrollments?status=approved&q=%25')).body as FaceEnrollmentPage).items).toEqual([]);
  });
});
