// 员工办公 v1.1 第 2 批（docs/OA_MOBILE.md 第 3–5 节；EO5 & 需求 5.2）：
//   · 排班「发布」才生效、才通知：草稿不影响员工「我的排班」/ 打卡 / 结算，修改已发布班次时发布前保留原排班，
//     草稿期间打了卡的班次发布删除被拦截，发布幂等与作废围栏、局部发布重叠拦截；
//   · 排班授权：考勤管理员与经核实的部门经理（含部门树）可授权，未核实自选负责人不可编排/授权；
//     五类范围（group / dept / dept_tree / staff / all_company）、仅 view/edit/publish 不可转授、
//     部门经理授考勤组带部门上限防跨部门提权、调岗即失效、有效期校验、撤销与全程审计、erp-ops 本人查回与作废。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttendanceSetup, MySchedule, NotificationPage, PunchToday, ScheduleAccessSummary, ScheduleGrantPage, ScheduleGrantSaved, SchedulePublishResult, ScheduleWeek } from '../src/shared/oa';
import { shiftDate } from '../src/shared/labels';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let earlyId: number;
let lateId: number;
let nightId: number;
let mixedGroupId: number;
type Emp = { id: number; cookie: string };
let frontLead: Emp;
let frontSup: Emp;
let frontStaff: Emp;
let engLead: Emp;
let engStaff: Emp;
let diningStaff: Emp;

const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const EMPTY = { shiftIds: [] as number[], consecutive: false };

const hire = async (username: string, position: string): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const createSetup = async (path: string, body: object) => {
  const r = await api(ctx.app, ctx.owner, 'POST', `/api/oa/attendance/${path}`, { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as AttendanceSetup;
};
const saveCells = (cookie: string, cells: object[], clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/oa/attendance/schedule', { clientKey, storeId: DEFAULT_STORE_ID, groupId: mixedGroupId, cells });
const publishRange = (cookie: string, from: string, to: string, extra: object = {}, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/oa/attendance/schedule/publish', { clientKey, storeId: DEFAULT_STORE_ID, groupId: mixedGroupId, from, to, ...extra });

beforeAll(async () => {
  ctx = await setup();
  frontLead = await hire('sg_front_lead', 'front.lead');
  frontSup = await hire('sg_front_sup', 'front.staff');
  frontStaff = await hire('sg_front_emp', 'front.staff');
  engLead = await hire('sg_eng_lead', 'eng.lead');
  engStaff = await hire('sg_eng_emp', 'eng.staff');
  diningStaff = await hire('sg_dining_emp', 'dining.staff');

  await createSetup('shifts', { name: '早班', startMinute: 480, endMinute: 960 });
  await createSetup('shifts', { name: '晚班', startMinute: 960, endMinute: 0, inAdvanceMinutes: 60, outDelayMinutes: 60 });
  const s = await createSetup('shifts', { name: '夜班', startMinute: 0, endMinute: 480 });
  earlyId = s.shifts.find((x) => x.name === '早班')!.id;
  lateId = s.shifts.find((x) => x.name === '晚班')!.id;
  nightId = s.shifts.find((x) => x.name === '夜班')!.id;

  const g = await createSetup('groups', { name: '前厅工程混编组', gpsRequired: false, memberIds: [frontSup.id, frontStaff.id, engStaff.id, diningStaff.id] });
  mixedGroupId = g.groups.find((x) => x.name === '前厅工程混编组')!.id;
  today = ((await api(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/schedule?groupId=${mixedGroupId}`)).body as ScheduleWeek).today;
});

afterAll(async () => ctx.close());

describe('员工办公 v1.1 第 2 批：排班发布与排班授权', () => {
  it('排班草稿与发布隔离：修改/清空已发布班次在发布前仍保留原线上排班；发布幂等、作废围栏与打卡冲突拦截', async () => {
    const d1 = shiftDate(today, 2);
    const d2 = shiftDate(today, 3);
    // 1. 先排早班并发布
    expect((await saveCells(ctx.owner, [{ staffId: frontStaff.id, date: d1, shiftIds: [earlyId], expected: EMPTY }])).status).toBe(200);
    const pubKey = randomUUID();
    const pub1 = await publishRange(ctx.owner, d1, d1, {}, pubKey);
    expect(pub1.status, JSON.stringify(pub1.body)).toBe(200);
    expect(pub1.body).toMatchObject({ staffCount: 1, cellCount: 1, replayed: false });
    const pubBody = pub1.body as SchedulePublishResult;
    expect(pubBody.publish?.cellCount).toBe(1);
    // 同一 clientKey 原样重提返回同一批次；换范围拒绝
    const replay = await publishRange(ctx.owner, d1, d1, {}, pubKey);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, cellCount: 1, saved: { id: pubBody.publish!.id } });
    expect(code(await publishRange(ctx.app ? ctx.owner : ctx.owner, d1, d2, {}, pubKey))).toBe('IDEMPOTENCY_CONFLICT');
    // 确认作废围栏拦住晚到的发布请求
    const fencedKey = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${fencedKey}/abandon`, { type: 'oa_schedule_publish', summary: '作废发布' })).status).toBe(200);
    expect(code(await publishRange(ctx.owner, d1, d1, {}, fencedKey))).toBe('OP_ABANDONED');

    // 2. 草稿中把 d1 从早班改成晚班：发布前员工「我的排班」仍看到原早班
    expect((await saveCells(ctx.owner, [{ staffId: frontStaff.id, date: d1, shiftIds: [lateId], expected: { shiftIds: [earlyId], consecutive: false } }])).status).toBe(200);
    const myBefore = (await api(ctx.app, frontStaff.cookie, 'GET', `/api/oa/me/schedule?month=${d1.slice(0, 7)}`)).body as MySchedule;
    expect(myBefore.days.find((x) => x.date === d1)!.items.map((x) => x.shiftId)).toEqual([earlyId]);

    // 3. 若草稿中把 d1 改成早班（撤回草稿变动），待发布标记自动消掉
    expect((await saveCells(ctx.owner, [{ staffId: frontStaff.id, date: d1, shiftIds: [earlyId], expected: { shiftIds: [lateId], consecutive: false } }])).status).toBe(200);
    const wkReverted = (await api(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/schedule?groupId=${mixedGroupId}&from=${d1}&days=7`)).body as ScheduleWeek;
    expect(wkReverted.cells.find((c) => c.staffId === frontStaff.id && c.date === d1)?.unpublished).toBeUndefined();

    // 4. 草稿中把 d1 清空为休息，但期间该班已有打卡记录 → 发布删除被 SCHEDULE_PUNCHED 拦下
    expect((await saveCells(ctx.owner, [{ staffId: frontStaff.id, date: d1, shiftIds: [], expected: { shiftIds: [earlyId], consecutive: false } }])).status).toBe(200);
    const wkPendingDel = (await api(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/schedule?groupId=${mixedGroupId}&from=${d1}&days=7`)).body as ScheduleWeek;
    expect(wkPendingDel.cells.find((c) => c.staffId === frontStaff.id && c.date === d1)).toEqual({
      staffId: frontStaff.id,
      date: d1,
      shiftIds: [],
      consecutive: false,
      unpublished: true,
    });
    await ctx.sql`
      INSERT INTO oa_punches (store_id, staff_id, punched_at, kind, business_date, shift_id, location_ok)
      VALUES (${DEFAULT_STORE_ID}, ${frontStaff.id}, now(), 'in', ${d1}::date, ${earlyId}, true)`;
    expect(code(await publishRange(ctx.owner, d1, d1))).toBe('SCHEDULE_PUNCHED');
    // 清掉演练打卡后再发布删除 → 线上删除生效
    await ctx.sql`DELETE FROM oa_punches WHERE staff_id = ${frontStaff.id} AND business_date = ${d1}::date`;
    const pubDel = await publishRange(ctx.owner, d1, d1);
    expect(pubDel.status, JSON.stringify(pubDel.body)).toBe(200);
    const myAfter = (await api(ctx.app, frontStaff.cookie, 'GET', `/api/oa/me/schedule?month=${d1.slice(0, 7)}`)).body as MySchedule;
    expect(myAfter.days.find((x) => x.date === d1)!.items).toEqual([]);

    // 5. 局部发布重叠防护：d1 已发晚班，草稿把 d1 改早班、d2 排夜班（草稿不重叠）；只发布 d2 会与线上 d1 晚班重叠 → 拒绝
    expect((await saveCells(ctx.owner, [{ staffId: frontStaff.id, date: d1, shiftIds: [lateId], expected: EMPTY }])).status).toBe(200);
    expect((await publishRange(ctx.owner, d1, d1)).status).toBe(200);
    expect(
      (
        await saveCells(ctx.owner, [
          { staffId: frontStaff.id, date: d1, shiftIds: [earlyId], expected: { shiftIds: [lateId], consecutive: false } },
          { staffId: frontStaff.id, date: d2, shiftIds: [nightId], expected: EMPTY },
        ])
      ).status,
    ).toBe(200);
    expect(code(await publishRange(ctx.owner, d2, d2))).toBe('SCHEDULE_OVERLAP');
    // 一起发布 d1..d2 则不重叠、成功
    expect((await publishRange(ctx.owner, d1, d2)).status).toBe(200);
    // 清理
    expect(
      (
        await saveCells(ctx.owner, [
          { staffId: frontStaff.id, date: d1, shiftIds: [], expected: { shiftIds: [earlyId], consecutive: false } },
          { staffId: frontStaff.id, date: d2, shiftIds: [], expected: { shiftIds: [nightId], consecutive: false } },
        ])
      ).status,
    ).toBe(200);
    expect((await publishRange(ctx.owner, d1, d2)).status).toBe(200);
  });

  it('部门经理授权主管（不可转授、考勤组范围带部门上限、erp-ops 自查自废、撤销与审计）', async () => {
    const d5 = shiftDate(today, 5);
    // 未授权时主管无排班权限
    const acc0 = (await api(ctx.app, frontSup.cookie, 'GET', '/api/oa/attendance/schedule-access')).body as ScheduleAccessSummary;
    expect(acc0).toMatchObject({ canView: false, canEdit: false, canPublish: false, canGrant: false, builtInRole: 'none' });
    expect((await api(ctx.app, frontSup.cookie, 'GET', '/api/oa/attendance/schedule-grants')).status).toBe(403);

    // 部门经理越界尝试：不能授全公司、不能授外部门、不能授给外部门员工、不能授给自己、不能授 grant
    expect(
      (
        await api(ctx.app, frontLead.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
          clientKey: randomUUID(),
          storeId: DEFAULT_STORE_ID,
          granteeStaffId: frontSup.id,
          permissions: ['view', 'edit'],
          scopeType: 'all_company',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(ctx.app, frontLead.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
          clientKey: randomUUID(),
          storeId: DEFAULT_STORE_ID,
          granteeStaffId: frontSup.id,
          permissions: ['view', 'edit'],
          scopeType: 'dept',
          scopeDeptKey: 'eng',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(ctx.app, frontLead.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
          clientKey: randomUUID(),
          storeId: DEFAULT_STORE_ID,
          granteeStaffId: engStaff.id,
          permissions: ['view'],
          scopeType: 'dept',
          scopeDeptKey: 'front',
        })
      ).status,
    ).toBe(403);
    expect(
      code(
        await api(ctx.app, frontLead.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
          clientKey: randomUUID(),
          storeId: DEFAULT_STORE_ID,
          granteeStaffId: frontLead.id,
          permissions: ['view'],
          scopeType: 'dept',
          scopeDeptKey: 'front',
        }),
      ),
    ).toBe('GRANT_SELF');
    expect(
      (
        await api(ctx.app, frontLead.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
          clientKey: randomUUID(),
          storeId: DEFAULT_STORE_ID,
          granteeStaffId: frontSup.id,
          permissions: ['grant'],
          scopeType: 'dept',
          scopeDeptKey: 'front',
        })
      ).status,
    ).toBe(400);

    // 部门经理授 frontSup「编排」权限（不含发布），范围选混编考勤组 mixedGroupId
    const grantKey = randomUUID();
    const gRes = await api<ScheduleGrantSaved>(ctx.app, frontLead.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
      clientKey: grantKey,
      storeId: DEFAULT_STORE_ID,
      granteeStaffId: frontSup.id,
      permissions: ['edit'],
      scopeType: 'group',
      scopeGroupId: mixedGroupId,
      note: '前厅排班主管',
    });
    expect(gRes.status, JSON.stringify(gRes.body)).toBe(201);
    expect(gRes.body.grant).toMatchObject({
      granteeStaffId: frontSup.id,
      permissions: ['view', 'edit'],
      scopeType: 'group',
      scopeCapDepts: ['front'],
      status: 'active',
    });
    // 幂等重提
    const gReplay = await api<ScheduleGrantSaved>(ctx.app, frontLead.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
      clientKey: grantKey,
      storeId: DEFAULT_STORE_ID,
      granteeStaffId: frontSup.id,
      permissions: ['edit'],
      scopeType: 'group',
      scopeGroupId: mixedGroupId,
      note: '前厅排班主管',
    });
    expect(gReplay.status).toBe(200);
    expect(gReplay.body.replayed).toBe(true);
    // 部门经理可查回自己的授权编号，别人不能查
    expect((await api(ctx.app, frontLead.cookie, 'GET', `/api/erp/ops/${grantKey}?type=oa_schedule_grant`)).body).toMatchObject({ found: true, refId: gRes.body.grant.id });
    expect((await api(ctx.app, engLead.cookie, 'GET', `/api/erp/ops/${grantKey}?type=oa_schedule_grant`)).status).toBe(403);

    // 主管获得查看+编排权限，但无发布权、无授权权（不可转授）
    const acc1 = (await api(ctx.app, frontSup.cookie, 'GET', '/api/oa/attendance/schedule-access')).body as ScheduleAccessSummary;
    expect(acc1).toMatchObject({ canView: true, canEdit: true, canPublish: false, canGrant: false });
    // 不可转授：主管尝试给 frontStaff 授权 → 403
    expect(
      (
        await api(ctx.app, frontSup.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
          clientKey: randomUUID(),
          storeId: DEFAULT_STORE_ID,
          granteeStaffId: frontStaff.id,
          permissions: ['view'],
          scopeType: 'staff',
          scopeStaffIds: [frontStaff.id],
        })
      ).status,
    ).toBe(403);

    // 考勤组虽然有 engStaff 和 diningStaff，但部门经理授出的范围受 scope_cap_depts=['front'] 限制，主管只看得到前厅员工、改不了外部门员工
    const wk = (await api(ctx.app, frontSup.cookie, 'GET', `/api/oa/attendance/schedule?groupId=${mixedGroupId}&from=${d5}&days=7`)).body as ScheduleWeek;
    expect(wk.members.map((m) => m.staffId).sort()).toEqual([frontSup.id, frontStaff.id].sort());
    expect((await saveCells(frontSup.cookie, [{ staffId: engStaff.id, date: d5, shiftIds: [earlyId], expected: EMPTY }])).status).toBe(403);
    // 编排前厅员工草稿成功，但尝试发布被拒（没有 publish 权限）
    const supSaveKey = randomUUID();
    expect((await saveCells(frontSup.cookie, [{ staffId: frontStaff.id, date: d5, shiftIds: [earlyId], expected: EMPTY }], supSaveKey)).status).toBe(200);
    expect((await publishRange(frontSup.cookie, d5, d5)).status).toBe(403);
    // 主管可以在 erp-ops 查回自己的 oa_schedule_save，外人不能查
    expect((await api(ctx.app, frontSup.cookie, 'GET', `/api/erp/ops/${supSaveKey}?type=oa_schedule_save`)).body).toMatchObject({ found: true, refId: mixedGroupId });
    expect((await api(ctx.app, frontStaff.cookie, 'GET', `/api/erp/ops/${supSaveKey}?type=oa_schedule_save`)).status).toBe(403);

    // 补授发布权后，主管可发布并记录 viaGrantIds 审计
    const gPub = await api<ScheduleGrantSaved>(ctx.app, frontLead.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
      clientKey: randomUUID(),
      storeId: DEFAULT_STORE_ID,
      granteeStaffId: frontSup.id,
      permissions: ['publish'],
      scopeType: 'staff',
      scopeStaffIds: [frontStaff.id],
    });
    expect(gPub.status, JSON.stringify(gPub.body)).toBe(201);
    const pubBySup = await publishRange(frontSup.cookie, d5, d5, { staffIds: [frontStaff.id] });
    expect(pubBySup.status, JSON.stringify(pubBySup.body)).toBe(200);
    expect(pubBySup.body).toMatchObject({ staffCount: 1, cellCount: 1 });
    const audits = await ctx.sql<{ detail: { viaGrantIds?: number[] } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'oa_schedule_published' AND staff_id = ${frontSup.id} ORDER BY id DESC LIMIT 1`;
    expect(audits[0]?.detail.viaGrantIds).toContain(gPub.body.grant.id);

    // 其他部门经理不能撤销 frontLead 授出的授权
    expect((await api(ctx.app, engLead.cookie, 'DELETE', `/api/oa/attendance/schedule-grants/${gRes.body.grant.id}`, { reason: '越权' })).status).toBe(403);
    // frontLead 撤销自己的两条授权，重复撤销报 409
    const rev1 = await api(ctx.app, frontLead.cookie, 'DELETE', `/api/oa/attendance/schedule-grants/${gRes.body.grant.id}`, { reason: '分工调整' });
    expect(rev1.status, JSON.stringify(rev1.body)).toBe(200);
    expect(code(await api(ctx.app, frontLead.cookie, 'DELETE', `/api/oa/attendance/schedule-grants/${gRes.body.grant.id}`, {}))).toBe('GRANT_ALREADY_REVOKED');
    expect((await api(ctx.app, frontLead.cookie, 'DELETE', `/api/oa/attendance/schedule-grants/${gPub.body.grant.id}`, { reason: '收回发布权' })).status).toBe(200);
    // 撤销后主管立刻失权，审计日志有建有撤
    expect((await api(ctx.app, frontSup.cookie, 'GET', `/api/oa/attendance/schedule?groupId=${mixedGroupId}`)).status).toBe(403);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_schedule_grant_created'`).length).toBeGreaterThanOrEqual(2);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_schedule_grant_revoked'`).length).toBeGreaterThanOrEqual(2);
    // 被授权人收到了授权站内通知
    const notifs = (await api(ctx.app, frontSup.cookie, 'GET', '/api/oa/notifications')).body as NotificationPage;
    expect(notifs.items.some((n) => n.title === '收到排班授权')).toBe(true);
  });

  it('调岗即失效、未生效有效期与未核实自选岗位限制；上级部门树 dept_tree 覆盖下级部门', async () => {
    const mover = await hire('sg_mover', 'front.staff');
    const g = ((await api(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/setup')).body as AttendanceSetup).groups.find((x) => x.id === mixedGroupId)!;
    expect(
      (await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/groups/${mixedGroupId}`, { name: g.name, gpsRequired: false, active: true, version: g.version, memberIds: [...g.memberIds, mover.id] }))
        .status,
    ).toBe(200);

    // 1. 有效期未开始（明天起）：状态为 pending，今日不生效
    const futureGrant = await api<ScheduleGrantSaved>(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/schedule-grants', {
      clientKey: randomUUID(),
      storeId: DEFAULT_STORE_ID,
      granteeStaffId: mover.id,
      permissions: ['view', 'edit'],
      scopeType: 'dept',
      scopeDeptKey: 'front',
      validFrom: shiftDate(today, 1),
      validTo: shiftDate(today, 30),
    });
    expect(futureGrant.status).toBe(201);
    expect(futureGrant.body.grant.status).toBe('pending');
    expect(((await api(ctx.app, mover.cookie, 'GET', '/api/oa/attendance/schedule-access')).body as ScheduleAccessSummary).canView).toBe(false);

    // 2. 今日生效的授权 → 有效；随后把 mover 调岗到 dining.staff → 立刻失效且列表显示 transferred
    const liveGrant = await api<ScheduleGrantSaved>(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/schedule-grants', {
      clientKey: randomUUID(),
      storeId: DEFAULT_STORE_ID,
      granteeStaffId: mover.id,
      permissions: ['view', 'edit', 'publish'],
      scopeType: 'dept',
      scopeDeptKey: 'front',
    });
    expect(liveGrant.status).toBe(201);
    expect(((await api(ctx.app, mover.cookie, 'GET', '/api/oa/attendance/schedule-access')).body as ScheduleAccessSummary).canEdit).toBe(true);
    // 调岗
    const staffUpdate = await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${mover.id}`, { displayName: 'sg_mover', position: 'dining.staff', active: true });
    expect(staffUpdate.status, JSON.stringify(staffUpdate.body)).toBe(200);
    // 调岗即失效：无需重新登录也立刻 403
    expect(((await api(ctx.app, mover.cookie, 'GET', '/api/oa/attendance/schedule-access')).body as ScheduleAccessSummary).canView).toBe(false);
    expect((await saveCells(mover.cookie, [{ staffId: frontStaff.id, date: shiftDate(today, 8), shiftIds: [earlyId], expected: EMPTY }])).status).toBe(403);
    const listPage = (await api(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/schedule-grants')).body as ScheduleGrantPage;
    expect(listPage.grants.find((x) => x.id === liveGrant.body.grant.id)?.status).toBe('transferred');

    // 3. 未经后台核实的自选 front.lead（position_chosen_at IS NOT NULL）：只能看本部门，不能编排/发布/授权
    const selfLead = await hire('sg_self_lead', 'front.lead');
    await ctx.sql`UPDATE staff SET position_chosen_at = now() WHERE id = ${selfLead.id}`;
    const selfAcc = (await api(ctx.app, selfLead.cookie, 'GET', '/api/oa/attendance/schedule-access')).body as ScheduleAccessSummary;
    expect(selfAcc).toMatchObject({ canView: true, canEdit: false, canPublish: false, canGrant: false, builtInRole: 'none' });
    expect((await api(ctx.app, selfLead.cookie, 'GET', '/api/oa/attendance/schedule-grants')).status).toBe(403);
    expect((await saveCells(selfLead.cookie, [{ staffId: frontStaff.id, date: shiftDate(today, 8), shiftIds: [earlyId], expected: EMPTY }])).status).toBe(403);

    // 4. 部门树 dept_tree：把 dining 设成 front 的下级部门，frontLead 自动可管 dining 员工，且授权 dept_tree 同样覆盖 dining
    const [diningDept] = await ctx.sql<{ version: number }[]>`SELECT version FROM org_departments WHERE key = 'dining'`;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/oa/org/departments/dining', { parentKey: 'front', headStaffId: null, version: diningDept!.version })).status).toBe(200);
    const leadAcc = (await api(ctx.app, frontLead.cookie, 'GET', '/api/oa/attendance/schedule-access')).body as ScheduleAccessSummary;
    expect(leadAcc.builtInDepts).toEqual(['dining', 'front']);
    const treeGrant = await api<ScheduleGrantSaved>(ctx.app, frontLead.cookie, 'POST', '/api/oa/attendance/schedule-grants', {
      clientKey: randomUUID(),
      storeId: DEFAULT_STORE_ID,
      granteeStaffId: frontSup.id,
      permissions: ['view', 'edit'],
      scopeType: 'dept_tree',
      scopeDeptKey: 'front',
    });
    expect(treeGrant.status, JSON.stringify(treeGrant.body)).toBe(201);
    const d9 = shiftDate(today, 9);
    // 覆盖到下级部门 diningStaff，但仍不覆盖外部门 engStaff
    expect((await saveCells(frontSup.cookie, [{ staffId: diningStaff.id, date: d9, shiftIds: [earlyId], expected: EMPTY }])).status).toBe(200);
    expect((await saveCells(frontSup.cookie, [{ staffId: engStaff.id, date: d9, shiftIds: [earlyId], expected: EMPTY }])).status).toBe(403);
    // 清理
    expect((await api(ctx.app, frontLead.cookie, 'DELETE', `/api/oa/attendance/schedule-grants/${treeGrant.body.grant.id}`, {})).status).toBe(200);
    // 未发布草稿对员工今天接口不可见
    const tdy = (await api(ctx.app, diningStaff.cookie, 'GET', '/api/oa/attendance/today')).body as PunchToday;
    expect(tdy.slots.some((s) => s.date === d9)).toBe(false);
  });
});
