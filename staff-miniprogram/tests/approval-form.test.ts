// 发起申请（src/utils/approval-form.ts）：画得了哪些字段、页面上的值怎么变成表单、手机上先核对、预填（补卡、工资条异议）、每一项怎么画与怎么改。

import { describe, expect, it } from 'vitest';
import type { ApprovalField } from '../../src/shared/oa-approval';
import { applyChange, checkValues, fieldViews, prefillOf, templateSupported, toForm, valueText } from '../src/utils/approval-form';

const F = (over: Partial<ApprovalField> & Pick<ApprovalField, 'key' | 'type'>): ApprovalField => ({ label: over.key, ...over });
const lists = { leaveTypes: [{ id: 3, name: '年假' }], shifts: [{ id: 7, name: '早班' }], refs: [] };

describe('画得了哪些', () => {
  it('现有模板用到的类型都画得了；以后新加的类型整张单去网页', () => {
    expect(templateSupported({ fields: [F({ key: 'a', type: 'halfday' }), F({ key: 'b', type: 'leave_type' }), F({ key: 'c', type: 'ref' }), F({ key: 'd', type: 'money' })] })).toBe(true);
    expect(templateSupported({ fields: [F({ key: 'a', type: 'signature' as never })] })).toBe(false);
  });
});

describe('值 → 表单', () => {
  const fields = [
    F({ key: 'reason', type: 'textarea', required: true }),
    F({ key: 'amount', type: 'money' }),
    F({ key: 'days', type: 'number' }),
    F({ key: 'photos', type: 'attachments' }),
    F({ key: 'type', type: 'leave_type' }),
    F({ key: 'note', type: 'text' }),
  ];

  it('金额元 → 分、数字、附件编号、空的记 null / []', () => {
    const form = toForm(fields, { reason: ' 家里有事 ', amount: '12.5', days: '3', photos: [{ id: 4, fileName: 'a.jpg', path: 'p' }], type: 3, note: '' });
    expect(form).toEqual({ reason: '家里有事', amount: 1250, days: 3, photos: [4], type: 3, note: null });
  });

  it('手机上先核对：必填、字数、金额、数字、选项', () => {
    expect(checkValues(fields, {})).toEqual({ key: 'reason', message: '请填写reason' });
    expect(checkValues(fields, { reason: 'x', amount: '1.234' })?.key).toBe('amount');
    expect(checkValues(fields, { reason: 'x', days: '1.5' })?.message).toContain('整数');
    expect(checkValues([F({ key: 's', type: 'select', options: ['A'] })], { s: 'B' })?.message).toContain('选项');
    expect(checkValues([F({ key: 't', type: 'text', max: 3 })], { t: '四个字儿' })?.message).toContain('最多 3 个字');
    expect(checkValues([F({ key: 'h', type: 'halfday', required: true })], { h: { date: '', half: 'am' } })?.message).toContain('上午');
    expect(checkValues([F({ key: 'd', type: 'datetime' })], { d: '2026-11-27T25:00' })?.key).toBe('d');
    expect(checkValues(fields, { reason: '好的', amount: '100', days: '2', type: 3 })).toBeNull();
  });
});

describe('预填', () => {
  const makeup = {
    code: 'makeup',
    fields: [F({ key: 'date', type: 'date' }), F({ key: 'shiftId', type: 'shift' }), F({ key: 'kind', type: 'select', options: ['上班卡', '下班卡'] }), F({ key: 'reason', type: 'textarea' })],
  };
  it('补卡：日期、班次、哪张卡（in → 上班卡）', () => {
    expect(prefillOf(makeup, { date: '2026-11-20', shiftId: '7', kind: 'in' })).toEqual({ date: '2026-11-20', shiftId: 7, kind: '上班卡' });
    expect(prefillOf(makeup, { date: 'bad', shiftId: '0', kind: 'x' })).toEqual({});
  });
  it('工资条异议：f.<文字字段>', () => {
    const t = { code: 'payslip_objection', fields: [F({ key: 'payslip', type: 'text', max: 60 }), F({ key: 'content', type: 'textarea' })] };
    expect(prefillOf(t, { 'f.payslip': '2026 年 11 月 · 工资' })).toEqual({ payslip: '2026 年 11 月 · 工资' });
    // 跳转参数是编码过的：先解码再截
    expect(prefillOf(t, { 'f.payslip': encodeURIComponent('2026 年 11 月 · 工资') })).toEqual({ payslip: '2026 年 11 月 · 工资' });
    expect(prefillOf(t, { 'f.payslip': encodeURIComponent('长'.repeat(80)) }).payslip).toBe('长'.repeat(60));
  });
});

describe('每一项怎么画、怎么改', () => {
  const fields = [
    F({ key: 'start', type: 'halfday' }),
    F({ key: 'at', type: 'datetime' }),
    F({ key: 'type', type: 'leave_type' }),
    F({ key: 'kind', type: 'select', options: ['上班卡', '下班卡'] }),
    F({ key: 'photos', type: 'attachments', max: 2 }),
  ];

  it('半天、日期时间、下拉', () => {
    let v = applyChange(fields, {}, lists, 'start', 'date', '2026-11-28');
    v = applyChange(fields, v, lists, 'start', 'half', 'pm');
    v = applyChange(fields, v, lists, 'at', 'date', '2026-11-28');
    v = applyChange(fields, v, lists, 'at', 'time', '14:30');
    v = applyChange(fields, v, lists, 'type', 'pick', 0);
    v = applyChange(fields, v, lists, 'kind', 'pick', 1);
    expect(v).toEqual({ start: { date: '2026-11-28', half: 'pm' }, at: '2026-11-28T14:30', type: 3, kind: '下班卡' });
    const views = fieldViews(fields, { ...v, photos: [{ id: 1, fileName: 'a', path: 'p' }] }, lists, { key: 'kind', message: '错了' });
    expect(views.find((x) => x.key === 'start')).toMatchObject({ date: '2026-11-28', half: 'pm' });
    expect(views.find((x) => x.key === 'at')).toMatchObject({ date: '2026-11-28', time: '14:30' });
    expect(views.find((x) => x.key === 'type')).toMatchObject({ options: ['年假'], optionIndex: 0, display: '年假' });
    expect(views.find((x) => x.key === 'kind')).toMatchObject({ optionIndex: 1, error: '错了' });
    expect(views.find((x) => x.key === 'photos')).toMatchObject({ room: 1 });
  });

  it('只选时间、没选日期的日期时间先不算', () => {
    expect(applyChange(fields, {}, lists, 'at', 'time', '09:00')).toEqual({ at: null });
  });

  it('详情页的文字', () => {
    expect(valueText({ type: 'money' }, 128000)).toBe('1,280.00 元');
    expect(valueText({ type: 'halfday' }, { date: '2026-11-28', half: 'am' })).toBe('2026-11-28 上午');
    expect(valueText({ type: 'leave_type' }, 3, { leaveTypes: { 3: '年假' } })).toBe('年假');
    expect(valueText({ type: 'datetime' }, '2026-11-28T14:30')).toBe('2026-11-28 14:30');
    expect(valueText({ type: 'text' }, null)).toBe('—');
  });
});
