// OA-11 六类审批模板（docs/OA.md 第 14 节）：请假（按排班算时长、不在考勤组的按日历天、不跨年、要证明的带附件、管余额的扣掉审批中的再核对、
// 超过 3 天加签）、加班（算分钟、最长 24 小时）、出差（算天数）、报销（关联自己已通过的出差单、超过 5000 元加签）、补卡（30 天内、自己排了的班）；
// 审批中心的「待我审批」数加上办公审批；转交选人。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalPerson, ApprovalSaved, ApprovalTemplate } from '../src/shared/oa-approval';
import type { AttendanceSetup, LeaveType } from '../src/shared/oa';
import { shiftDate } from '../src/shared/labels';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { localMinute } from '../src/server/modules/oa/punches';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Emp = { id: number; cookie: string };
const emp: Record<string, Emp> = {};
const tpl: Record<string, ApprovalTemplate> = {};
let shiftId: number;
let annual: LeaveType;
let sick: LeaveType;
let today: string;
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const hire = async (username: string, position: string): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const post = (who: Emp, code: string, form: object) => api<ApprovalSaved>(ctx.app, who.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: tpl[code]!.id, form });
const ok = async (who: Emp, code: string, form: object) => {
  const r = await post(who, code, form);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.approval;
};
const schedule = (who: Emp, ...dates: string[]) =>
  Promise.all(dates.map((d) => ctx.sql`INSERT INTO oa_schedules (staff_id, work_date, shift_id, created_by, updated_by) VALUES (${who.id}, ${d}, ${shiftId}, ${ctx.ownerId}, ${ctx.ownerId})`));
const leave = (typeId: number, start: [string, 'am' | 'pm'], end: [string, 'am' | 'pm'], extra: object = {}) => ({
  leaveTypeId: typeId,
  start: { date: start[0], half: start[1] },
  end: { date: end[0], half: end[1] },
  reason: '家里有事',
  ...extra,
});

beforeAll(async () => {
  ctx = await setup();
  emp.staff = await hire('at_staff', 'front.staff');
  emp.free = await hire('at_free', 'front.staff'); // 不在考勤组
  emp.lead = await hire('at_lead', 'front.lead');
  emp.gmo = await hire('at_gmo', 'gmo');
  for (const t of (await api(ctx.app, emp.staff!.cookie, 'GET', '/api/oa/approval/templates')).body as ApprovalTemplate[]) tpl[t.code] = t;
  const types = (await api(ctx.app, emp.staff!.cookie, 'GET', '/api/oa/leave/types')).body as LeaveType[];
  annual = types.find((t) => t.name === '年假')!;
  sick = types.find((t) => t.name === '病假')!;
  const s = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, name: '白班', startMinute: 540, endMinute: 1080 });
  shiftId = (s.body as AttendanceSetup).shifts.find((x) => x.name === '白班')!.id;
  const g = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, name: '前厅', gpsRequired: false, memberIds: [emp.staff!.id] });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  today = localMinute(new Date(), ctx.config.timezone).date;
});
afterAll(async () => {
  await ctx.close();
});

describe('OA-11 六类审批模板', () => {
  it('六个模板都在：通用、请假、加班、出差、报销、补卡', () => {
    expect(Object.keys(tpl).sort()).toEqual(['expense', 'general', 'leave', 'makeup', 'overtime', 'trip']);
    expect(tpl.leave!.conditions).toEqual({ leave_over_3_days: true });
    expect(tpl.expense!.conditions).toEqual({ expense_over_5000: true });
  });

  it('请假：时长按排班算（休息日不算、半天）；不在考勤组的按日历天；全是休息日的不用请；不跨年；病假要证明附件', async () => {
    // 2031-03-03（一）～03-07（五）排了班，周末没排
    await schedule(emp.staff!, '2031-03-03', '2031-03-04', '2031-03-05', '2031-03-06', '2031-03-07');
    // 年假还没有余额
    expect(code(await post(emp.staff!, 'leave', leave(annual.id, ['2031-03-04', 'pm'], ['2031-03-09', 'am'])))).toBe('LEAVE_BALANCE_SHORT');
    await api(ctx.app, ctx.owner, 'POST', '/api/oa/leave/adjust', {
      clientKey: randomUUID(),
      storeId: DEFAULT_STORE_ID,
      staffId: emp.staff!.id,
      leaveTypeId: annual.id,
      year: 2031,
      halves: 10,
      reason: '测试发放',
    });
    const b = await ok(emp.staff!, 'leave', leave(annual.id, ['2031-03-04', 'pm'], ['2031-03-09', 'am']));
    // 04 下午半天 + 05、06、07 三天；08、09 没排班
    expect(b.form.durationHalves).toBe(7);
    expect(b.title).toBe('请假 · 年假 3.5 天');
    expect(b.steps.map((s) => s.approverId)).toEqual([emp.lead!.id, emp.gmo!.id]); // 超过 3 天加签上级部门主管
    expect(code(await post(emp.staff!, 'leave', leave(annual.id, ['2031-03-08', 'am'], ['2031-03-09', 'pm'])))).toBe('LEAVE_NO_SCHEDULE');
    expect(code(await post(emp.staff!, 'leave', leave(annual.id, ['2031-03-05', 'pm'], ['2031-03-05', 'am'])))).toBe('FORM_INVALID');
    expect(code(await post(emp.staff!, 'leave', leave(annual.id, ['2031-12-31', 'am'], ['2032-01-02', 'pm'])))).toBe('FORM_INVALID');
    // 不在考勤组：按日历天
    const c = await ok(emp.free!, 'leave', leave(sick.id, ['2031-03-08', 'am'], ['2031-03-09', 'pm'], { attachments: [await upload(emp.free!)] }));
    expect(c.form.durationHalves).toBe(4);
    expect(c.steps.map((s) => s.approverId)).toEqual([emp.lead!.id]);
    // 病假要证明附件
    const noProof = await post(emp.free!, 'leave', leave(sick.id, ['2031-03-10', 'am'], ['2031-03-10', 'pm']));
    expect(code(noProof)).toBe('FORM_INVALID');
    expect((noProof.body as unknown as { error: { message: string } }).error.message).toContain('证明');
  });

  it('请假余额：剩余减去审批中的同假种请假，不够不让提交；撤销以后又能请', async () => {
    // 上一条发了 5 天，审批中的占了 3.5 天，还剩 1.5 天
    const short = await post(emp.staff!, 'leave', leave(annual.id, ['2031-03-03', 'am'], ['2031-03-04', 'pm']));
    expect(code(short)).toBe('LEAVE_BALANCE_SHORT');
    expect((short.body as unknown as { error: { message: string } }).error.message).toContain('还能请 1.5 天');
    const one = await ok(emp.staff!, 'leave', leave(annual.id, ['2031-03-03', 'am'], ['2031-03-03', 'pm']));
    expect(one.form.durationHalves).toBe(2);
    await api(ctx.app, emp.staff!.cookie, 'POST', `/api/oa/approvals/${one.id}/act`, { clientKey: randomUUID(), action: 'withdraw' });
    expect((await post(emp.staff!, 'leave', leave(annual.id, ['2031-03-03', 'am'], ['2031-03-03', 'pm']))).status).toBe(201);
  });

  it('加班：算分钟，结束要晚于开始、最长 24 小时；出差：算天数', async () => {
    const a = await ok(emp.staff!, 'overtime', { start: '2031-03-08T09:00', end: '2031-03-08T12:30', kind: '休息日', reason: '盘点' });
    expect(a.form.minutes).toBe(210);
    expect(a.title).toBe('加班 · 休息日 3.5 小时');
    expect(code(await post(emp.staff!, 'overtime', { start: '2031-03-08T12:00', end: '2031-03-08T09:00', kind: '工作日', reason: 'x' }))).toBe('FORM_INVALID');
    expect(code(await post(emp.staff!, 'overtime', { start: '2031-03-08T09:00', end: '2031-03-09T09:30', kind: '工作日', reason: 'x' }))).toBe('FORM_INVALID');
    expect(code(await post(emp.staff!, 'overtime', { start: '2031-03-08 09:00', end: '2031-03-08T12:00', kind: '工作日', reason: 'x' }))).toBe('FORM_INVALID');
    const t = await ok(emp.staff!, 'trip', { destination: '杭州', startDate: '2031-04-01', endDate: '2031-04-03', transport: '火车', reason: '考察' });
    expect(t.form.days).toBe(3);
    expect(t.title).toBe('出差 · 杭州 3 天');
  });

  it('报销：发票必填；关联出差单只能是自己已通过的；超过 5000 元加签总经办', async () => {
    const inv = await upload(emp.staff!);
    expect(code(await post(emp.staff!, 'expense', { category: '交通', amount: 12_000, occurredOn: '2031-04-03', invoices: [] }))).toBe('FORM_INVALID');
    const trip = await ok(emp.staff!, 'trip', { destination: '上海', startDate: '2031-05-01', endDate: '2031-05-02', transport: '火车', reason: '培训' });
    expect(code(await post(emp.staff!, 'expense', { category: '交通', amount: 12_000, occurredOn: '2031-05-02', invoices: [inv], tripId: trip.id }))).toBe('FORM_INVALID');
    await api(ctx.app, emp.lead!.cookie, 'POST', `/api/oa/approvals/${trip.id}/act`, { clientKey: randomUUID(), action: 'approve', stepId: trip.pendingStepId });
    const e = await ok(emp.staff!, 'expense', { category: '交通', amount: 12_000, occurredOn: '2031-05-02', invoices: [inv], tripId: trip.id });
    expect(e.title).toBe('报销 · 交通 ¥120.00');
    expect(e.steps.map((s) => s.approverId)).toEqual([emp.lead!.id]);
    const big = await ok(emp.staff!, 'expense', { category: '招待', amount: 600_000, occurredOn: '2031-05-02', invoices: [await upload(emp.staff!)] });
    expect(big.steps.map((s) => s.approverId)).toEqual([emp.lead!.id, emp.gmo!.id]);
    // 关联单的候选按模板在服务端筛（Codex 审查 03e17aa：只取第一页再在页面上筛会漏掉较早的出差单）
    const refs = (await api(ctx.app, emp.staff!.cookie, 'GET', '/api/oa/approvals?box=mine&status=approved&template=trip')).body as { items: { id: number; templateCode: string }[] };
    expect(refs.items.map((x) => x.id)).toEqual([trip.id]);
    expect((await api(ctx.app, emp.staff!.cookie, 'GET', '/api/oa/approvals?box=mine&template=Trip!')).status).toBe(400);
    // 别人的出差单不能关联
    expect(code(await post(emp.free!, 'expense', { category: '交通', amount: 100, occurredOn: '2031-05-02', invoices: [await upload(emp.free!)], tripId: trip.id }))).toBe('FORM_INVALID');
  });

  it('补卡：今天及以前 30 天内、自己那天排了的班', async () => {
    const d = shiftDate(today, -2);
    await schedule(emp.staff!, d);
    const m = await ok(emp.staff!, 'makeup', { date: d, shiftId, kind: '下班卡', reason: '忘了打' });
    expect(m.title).toBe(`补卡 · ${d} 白班下班卡`);
    expect(code(await post(emp.staff!, 'makeup', { date: shiftDate(today, -3), shiftId, kind: '上班卡', reason: 'x' }))).toBe('FORM_INVALID');
    expect(code(await post(emp.staff!, 'makeup', { date: shiftDate(today, 1), shiftId, kind: '上班卡', reason: 'x' }))).toBe('FORM_INVALID');
    expect(code(await post(emp.staff!, 'makeup', { date: shiftDate(today, -31), shiftId, kind: '上班卡', reason: 'x' }))).toBe('FORM_INVALID');
  });

  it('审批中心的「待我审批」加上办公审批；转交选人只列在职员工', async () => {
    const counts = await api(ctx.app, ctx.owner, 'GET', '/api/approvals/count');
    expect(counts.status).toBe(200);
    expect((counts.body as { office: number }).office).toBe(0);
    await ctx.sql`UPDATE oa_approval_steps SET approver_id = ${ctx.ownerId} WHERE status = 'pending' AND approval_id = (SELECT max(approval_id) FROM oa_approval_steps WHERE status = 'pending')`;
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/approvals/count')).body as { office: number }).office).toBe(1);
    const people = (await api(ctx.app, emp.staff!.cookie, 'GET', '/api/oa/approval/people')).body as ApprovalPerson[];
    expect(people.find((p) => p.id === emp.lead!.id)).toMatchObject({ name: 'at_lead', department: '前厅部' });
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${emp.free!.id}`;
    expect(((await api(ctx.app, emp.staff!.cookie, 'GET', '/api/oa/approval/people')).body as ApprovalPerson[]).some((p) => p.id === emp.free!.id)).toBe(false);
  });
});

async function upload(who: Emp) {
  const r = await api<{ id: number }>(ctx.app, who.cookie, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: '证明.jpg', mime: 'image/jpeg', data: JPEG.toString('base64') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id;
}
