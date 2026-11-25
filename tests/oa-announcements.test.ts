// 员工办公 v1.1 第 5 批（docs/OA_MOBILE.md 第五节）：公司 / 部门公告回归测试。
// 覆盖：权限边界（oa.announce）、全员与指定部门发布、附件 strict 鉴权、站内通知推送与可见性、
// 已读登记与名单统计、编辑乐观锁、撤回隐藏公告与通知、操作编号幂等与确认作废围栏、非员工/离职隔离。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationPage, OaAnnouncement, OaAnnouncementList, OaAnnouncementReaders, OaAnnouncementSaved, OaAttachment } from '../src/shared/oa';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let hrCookie: string;
let frontCookie: string;
let opsCookie: string;
let tabletCookie: string;
let frontId: number;
let opsId: number;
let resignedCookie: string;
let resignedId: number;

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const code = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  ctx = await setup();
  // hr.lead 默认拥有 oa.announce 权限
  await createStaff(ctx.sql, { username: 'ann_hr', displayName: '人力主管', role: 'clerk', position: 'hr.lead', password: PASSWORD, mustChangePassword: false });
  hrCookie = await login(ctx.app, 'ann_hr');

  frontId = await createStaff(ctx.sql, { username: 'ann_front', displayName: '前厅小王', role: 'clerk', position: 'front.staff', password: PASSWORD, mustChangePassword: false });
  frontCookie = await login(ctx.app, 'ann_front');

  opsId = await createStaff(ctx.sql, { username: 'ann_ops', displayName: '餐饮小李', role: 'clerk', position: 'dining.lead', password: PASSWORD, mustChangePassword: false });
  opsCookie = await login(ctx.app, 'ann_ops');

  await createStaff(ctx.sql, { username: 'ann_tablet', displayName: '桌边平板', role: 'tablet', password: PASSWORD, mustChangePassword: false });
  tabletCookie = await login(ctx.app, 'ann_tablet');

  resignedId = await createStaff(ctx.sql, { username: 'ann_resigned', displayName: '离职测试员', role: 'clerk', position: 'front.staff', password: PASSWORD, mustChangePassword: false });
  resignedCookie = await login(ctx.app, 'ann_resigned');
  await ctx.sql`INSERT INTO staff_profiles (staff_id, status) VALUES (${resignedId}, 'left') ON CONFLICT (staff_id) DO UPDATE SET status = 'left'`;
});

afterAll(async () => ctx.close());

async function uploadPng(cookie: string, fileName = '通知配图.png'): Promise<OaAttachment> {
  const r = await api<OaAttachment>(ctx.app, cookie, 'POST', '/api/oa/attachments', {
    clientKey: randomUUID(),
    fileName,
    mime: 'image/png',
    data: PNG.toString('base64'),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe('员工办公 v1.1 第 5 批：公司公告', () => {
  it('权限边界与非员工/离职隔离', async () => {
    // 普通员工无 oa.announce 不能调用管理接口
    expect((await api(ctx.app, frontCookie, 'GET', '/api/admin/oa/announcements')).status).toBe(403);
    expect(
      (
        await api(ctx.app, frontCookie, 'POST', '/api/admin/oa/announcements', {
          clientKey: randomUUID(),
          title: '越权公告',
          body: '正文',
          scope: 'all',
        })
      ).status,
    ).toBe(403);

    // 专用账号（tablet）与离职员工不可读员工端公告
    expect((await api(ctx.app, tabletCookie, 'GET', '/api/oa/announcements')).status).toBe(403);
    expect((await api(ctx.app, resignedCookie, 'GET', '/api/oa/announcements')).status).toBe(403);

    // hr.lead 默认具备 oa.announce
    expect((await api(ctx.app, hrCookie, 'GET', '/api/admin/oa/announcements')).status).toBe(200);
  });

  it('全员公告发布（带附件、幂等重放、作废围栏）、站内通知与已读名单', async () => {
    const att = await uploadPng(hrCookie, '消防图.png');
    const pubKey = randomUUID();
    const payload = {
      clientKey: pubKey,
      title: '11 月消防演练通知',
      body: '本周五下午 3 点在一楼大厅集合。',
      scope: 'all' as const,
      targetDepts: [],
      pinned: true,
      attachmentIds: [att.id],
    };

    const r1 = await api<OaAnnouncementSaved>(ctx.app, hrCookie, 'POST', '/api/admin/oa/announcements', payload);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.replayed).toBe(false);
    expect(r1.body.announcement.title).toBe(payload.title);
    expect(r1.body.announcement.attachments).toHaveLength(1);
    const annId = r1.body.announcement.id;

    // 原样重提：200 + replayed: true，返回同一条
    const r2 = await api<OaAnnouncementSaved>(ctx.app, hrCookie, 'POST', '/api/admin/oa/announcements', payload);
    expect(r2.status).toBe(200);
    expect(r2.body.replayed).toBe(true);
    expect(r2.body.announcement.id).toBe(annId);

    // 同一编号换内容或换人：409 IDEMPOTENCY_CONFLICT
    expect(code(await api(ctx.app, hrCookie, 'POST', '/api/admin/oa/announcements', { ...payload, title: '改了标题' }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/admin/oa/announcements', payload))).toBe('IDEMPOTENCY_CONFLICT');

    // 已作废的操作编号拒绝发布
    const fencedKey = randomUUID();
    const ab = await api(ctx.app, hrCookie, 'POST', `/api/erp/ops/${fencedKey}/abandon`, { type: 'oa_announcement', summary: '作废测试' });
    expect(ab.status, JSON.stringify(ab.body)).toBe(200);
    const blocked = await api(ctx.app, hrCookie, 'POST', '/api/admin/oa/announcements', { ...payload, clientKey: fencedKey, attachmentIds: [] });
    expect(blocked.status).toBe(409);
    expect(code(blocked)).toBe('OP_ABANDONED');

    // 在职员工均可见、收到站内通知且可下载附件；非员工不可下附件
    const listFront = await api<OaAnnouncementList>(ctx.app, frontCookie, 'GET', '/api/oa/announcements');
    expect(listFront.status).toBe(200);
    expect(listFront.body.items.some((x) => x.id === annId)).toBe(true);
    expect(listFront.body.unreadCount).toBeGreaterThanOrEqual(1);

    const notifBefore = await api<NotificationPage>(ctx.app, frontCookie, 'GET', '/api/oa/notifications?status=unread');
    expect(notifBefore.body.items.some((n) => n.kind === 'announcement' && n.link === `/oa/announcements/${annId}`)).toBe(true);

    expect((await api(ctx.app, frontCookie, 'GET', `/api/oa/attachments/${att.id}`)).status).toBe(200);
    expect((await api(ctx.app, tabletCookie, 'GET', `/api/oa/attachments/${att.id}`)).status).toBe(404);
    expect((await api(ctx.app, resignedCookie, 'GET', `/api/oa/attachments/${att.id}`)).status).toBe(404);

    // 标已读（幂等）并自动消除对应站内通知未读
    const read1 = await api<{ readAt: string }>(ctx.app, frontCookie, 'POST', `/api/oa/announcements/${annId}/read`, {});
    expect(read1.status).toBe(200);
    const read2 = await api<{ readAt: string }>(ctx.app, frontCookie, 'POST', `/api/oa/announcements/${annId}/read`, {});
    expect(read2.status).toBe(200);
    expect(read2.body.readAt).toBe(read1.body.readAt);

    const notifAfter = await api<NotificationPage>(ctx.app, frontCookie, 'GET', '/api/oa/notifications?status=unread');
    expect(notifAfter.body.items.some((n) => n.kind === 'announcement' && n.link === `/oa/announcements/${annId}`)).toBe(false);

    // 管理员查已读名单
    const readers = await api<OaAnnouncementReaders>(ctx.app, hrCookie, 'GET', `/api/admin/oa/announcements/${annId}/readers`);
    expect(readers.status).toBe(200);
    expect(readers.body.readers.map((x) => x.staffId)).toContain(frontId);
    expect(readers.body.targetCount).toBeGreaterThanOrEqual(3);
  });

  it('指定部门公告严格隔离（可见性、附件与通知），支持编辑乐观锁与撤回隐藏', async () => {
    const att = await uploadPng(ctx.owner, '前厅排班须知.png');
    const pub = await api<OaAnnouncementSaved>(ctx.app, ctx.owner, 'POST', '/api/admin/oa/announcements', {
      clientKey: randomUUID(),
      title: '前厅部早班交接要求',
      body: '仅前厅部同事可见的内部说明。',
      scope: 'dept',
      targetDepts: ['front'],
      pinned: false,
      attachmentIds: [att.id],
    });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const deptAnn = pub.body.announcement;

    // 前厅员工可见、可看详情、可下附件、有通知；营运员工一律不可见
    expect((await api<OaAnnouncement>(ctx.app, frontCookie, 'GET', `/api/oa/announcements/${deptAnn.id}`)).status).toBe(200);
    expect((await api(ctx.app, frontCookie, 'GET', `/api/oa/attachments/${att.id}`)).status).toBe(200);

    const opsList = await api<OaAnnouncementList>(ctx.app, opsCookie, 'GET', '/api/oa/announcements');
    expect(opsList.body.items.some((x) => x.id === deptAnn.id)).toBe(false);
    expect((await api(ctx.app, opsCookie, 'GET', `/api/oa/announcements/${deptAnn.id}`)).status).toBe(404);
    expect((await api(ctx.app, opsCookie, 'POST', `/api/oa/announcements/${deptAnn.id}/read`, {})).status).toBe(404);
    expect((await api(ctx.app, opsCookie, 'GET', `/api/oa/attachments/${att.id}`)).status).toBe(404);
    const opsNotif = await api<NotificationPage>(ctx.app, opsCookie, 'GET', '/api/oa/notifications');
    expect(opsNotif.body.items.some((n) => n.link === `/oa/announcements/${deptAnn.id}`)).toBe(false);
    expect(opsId).toBeGreaterThan(0);

    // 编辑：正确 version 成功并自增，过期 version 409 VERSION_CONFLICT
    const upd = await api<OaAnnouncement>(ctx.app, ctx.owner, 'PUT', `/api/admin/oa/announcements/${deptAnn.id}`, {
      title: '前厅部早班交接要求（更新）',
      body: '更新后的交接细则。',
      pinned: true,
      version: deptAnn.version,
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.version).toBe(deptAnn.version + 1);
    expect(upd.body.pinned).toBe(true);

    const stale = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/oa/announcements/${deptAnn.id}`, {
      title: '旧版本覆盖',
      body: '不应成功',
      pinned: false,
      version: deptAnn.version,
    });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('VERSION_CONFLICT');

    // 撤回前前厅员工有未读公告通知
    const beforeRecall = await api<NotificationPage>(ctx.app, frontCookie, 'GET', '/api/oa/notifications?status=unread');
    expect(beforeRecall.body.items.some((n) => n.link === `/oa/announcements/${deptAnn.id}`)).toBe(true);

    // 撤回（带幂等重放 + 必填原因）
    const recallKey = randomUUID();
    const rec1 = await api<OaAnnouncementSaved>(ctx.app, ctx.owner, 'POST', `/api/admin/oa/announcements/${deptAnn.id}/recall`, {
      clientKey: recallKey,
      reason: '制度内容调整',
    });
    expect(rec1.status, JSON.stringify(rec1.body)).toBe(200);
    expect(rec1.body.replayed).toBe(false);
    expect(rec1.body.announcement.status).toBe('recalled');
    expect(rec1.body.announcement.pinned).toBe(false);

    // 撤回原样重放返回 replayed: true
    const rec2 = await api<OaAnnouncementSaved>(ctx.app, ctx.owner, 'POST', `/api/admin/oa/announcements/${deptAnn.id}/recall`, {
      clientKey: recallKey,
      reason: '制度内容调整',
    });
    expect(rec2.status).toBe(200);
    expect(rec2.body.replayed).toBe(true);

    // 撤回后：不可再编辑；员工端不可见、不可读、不可下附件、站内通知也隐藏；管理员仍可查附件
    const editAfter = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/oa/announcements/${deptAnn.id}`, {
      title: '再编辑',
      body: '不允许',
      pinned: false,
      version: rec1.body.announcement.version,
    });
    expect(editAfter.status).toBe(422);
    expect(code(editAfter)).toBe('ANNOUNCEMENT_RECALLED');

    expect((await api(ctx.app, frontCookie, 'GET', `/api/oa/announcements/${deptAnn.id}`)).status).toBe(404);
    expect((await api(ctx.app, frontCookie, 'POST', `/api/oa/announcements/${deptAnn.id}/read`, {})).status).toBe(404);
    expect((await api(ctx.app, frontCookie, 'GET', `/api/oa/attachments/${att.id}`)).status).toBe(404);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/oa/attachments/${att.id}`)).status).toBe(200);

    const afterRecall = await api<NotificationPage>(ctx.app, frontCookie, 'GET', '/api/oa/notifications');
    expect(afterRecall.body.items.some((n) => n.link === `/oa/announcements/${deptAnn.id}`)).toBe(false);

    // 审计留痕
    const audits = await ctx.sql<{ action: string }[]>`
      SELECT action FROM audit_logs WHERE target_type = 'oa_announcement' AND target_id = ${String(deptAnn.id)} ORDER BY id`;
    expect(audits.map((a) => a.action)).toEqual(['oa_announcement_published', 'oa_announcement_updated', 'oa_announcement_recalled']);
  });
});
