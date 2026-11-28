// 发起申请（docs/STAFF_MP.md 第 2.4 节，SP07）：先选是哪一类（请假、补卡、工资条异议……，模板由后台定），再照模板的字段填表；
//   · 从考勤记录点「补卡」、工资条点「有异议」、假期余额点「请假」进来的，直接是那一类、带着预填；
//   · 填到一半的存在手机上（草稿，图片附件不存），提交成功删掉；
//   · 提交带操作编号，没收到结果的进「结果待确认」，只能原样重提（不会多出一张单）；
//   · 模板里有小程序画不了的字段的那一类，写「请在 WCP 网页上提交」。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import type { MyLeave, MySchedule } from '../../../../src/shared/oa';
import type { ApprovalPage, ApprovalSaved, ApprovalTemplate } from '../../../../src/shared/oa-approval';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import type { FieldView, OptionLists, PickedFile, Values } from '../../utils/approval-form';
import { applyChange, checkValues, clearDraft, fieldViews, prefillOf, readDraft, templateSupported, toForm, writeDraft } from '../../utils/approval-form';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import type { PendingOp } from '../../utils/pending';
import { loadPending, SAVE_FAILED, sendPending } from '../../utils/pending';
import { choosePhotos, uploadPhoto } from '../../utils/photo';
import { largeTextOn } from '../../utils/prefs';
import { uuid } from '../../utils/uuid';

let me: StaffMpMe | null = null;
let templates: ApprovalTemplate[] = [];
let template: ApprovalTemplate | null = null;
let values: Values = {};
let lists: OptionLists = { leaveTypes: [], shifts: [], refs: [] };
let query: Record<string, string | undefined> = {};
let error: { key: string; message: string } | null = null;
/** 页面还在（交上去以后 600 毫秒再跳；这期间按了返回就不跳） */
let alive = false;
/** 补卡选班次：日期连着改两次时只认最后一次 */
let shiftSeq = 0;
const EMPTY_LISTS: OptionLists = { leaveTypes: [], shifts: [], refs: [] };

/** 草稿不存图片附件（没用上的附件 24 小时后门店系统会清掉） */
const draftOf = (v: Values): Values => Object.fromEntries(Object.entries(v).filter(([, x]) => !Array.isArray(x)));

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    list: [] as { id: number; code: string; name: string; description: string }[],
    picked: false,
    name: '',
    description: '',
    supported: true,
    fields: [] as FieldView[],
    busy: false,
    uploading: false,
    submitError: '',
    pending: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    // 新开的一页：上一次（可能是上一位员工）留下的都不用
    query = q;
    templates = [];
    template = null;
    values = {};
    lists = EMPTY_LISTS;
    error = null;
    alive = true;
    this.setData({ large: largeTextOn() });
  },

  onUnload() {
    alive = false;
  },

  async onShow() {
    me = await requireMe();
    if (!me || this.data.state === 'ready') return;
    this.load();
  },

  async load() {
    try {
      templates = (await call<ApprovalTemplate[]>('GET', '/oa/approval/templates')).filter((t) => t.active);
      this.setData({ list: templates.map((t) => ({ id: t.id, code: t.code, name: t.name, description: t.description })), state: templates.length ? 'ready' : 'empty', error: '' });
      const code = query.code;
      const want = code ? templates.find((t) => t.code === code) : null;
      if (want) this.pick(want);
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  onTemplate(e: WechatMiniprogram.TouchEvent) {
    const t = templates.find((x) => x.id === Number(e.currentTarget.dataset.id));
    if (t) this.pick(t);
  },

  onBackToList() {
    template = null;
    this.setData({ picked: false, submitError: '', pending: '' });
  },

  pick(t: ApprovalTemplate) {
    template = t;
    error = null;
    lists = EMPTY_LISTS;
    // 预填（从别的页带过来的）盖在草稿上
    values = { ...(me ? (readDraft(me.staff.id, t.code) ?? {}) : {}), ...prefillOf(t, query) };
    this.setData({ picked: true, name: t.name, description: t.description, supported: templateSupported(t), submitError: '' });
    this.showPending();
    this.render();
    this.loadLists();
  },

  showPending() {
    const p = template && me ? loadPending(me.staff.id, 'approval_submit', template.id) : null;
    this.setData({ pending: p ? `${shortTime(new Date(p.at).toISOString())} 提交的「${p.label}」没收到门店系统的回复，可能已经交上了。再提交一次：交上了的会认出来，不会多一张。` : '' });
  },

  render() {
    if (!template) return;
    this.setData({ fields: fieldViews(template.fields, values, lists, error) });
  },

  /** 选项类字段要的列表：假种（假期余额接口带着）、那天的班次（我的排班）、能关联的已通过的单 */
  async loadLists() {
    const t = template;
    if (!t) return;
    try {
      if (t.fields.some((f) => f.type === 'leave_type') && !lists.leaveTypes.length) {
        const l = await call<MyLeave>('GET', '/oa/me/leave');
        lists = { ...lists, leaveTypes: l.types.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name })) };
      }
      const ref = t.fields.find((f) => f.type === 'ref');
      if (ref) {
        // 自己已通过的那个模板的单：一页 30 张，照 next 一页一页取完（与 WCP 网页的表单一样，最多 20 页）
        const all: ApprovalPage['items'] = [];
        let before: number | null = null;
        for (let i = 0; i < 20; i += 1) {
          const page: ApprovalPage = await call<ApprovalPage>('GET', `/oa/approvals?box=mine&status=approved&template=${ref.refTemplate ?? ''}${before ? `&before=${before}` : ''}`);
          all.push(...page.items);
          if (!page.next) break;
          before = page.next;
        }
        if (template !== t) return;
        lists = { ...lists, refs: all.map((x) => ({ id: x.id, name: `${x.title}（${x.submittedAt.slice(0, 10)}）` })) };
      }
      await this.loadShifts();
    } catch {
      // 选项没取到：那一项先空着，下拉刷新再取
    }
    this.render();
  },

  /** 补卡选班次：那一天自己排的班（日期改了重取） */
  async loadShifts() {
    const t = template;
    if (!t || !t.fields.some((f) => f.type === 'shift')) return;
    const date = typeof values.date === 'string' ? values.date : '';
    if (!date) {
      lists = { ...lists, shifts: [] };
      return;
    }
    const month = date.slice(0, 7);
    const mine = ++shiftSeq;
    const s = await call<MySchedule>('GET', `/oa/me/schedule?month=${month}`);
    if (mine !== shiftSeq || template !== t) return;
    const items = s.days.find((d) => d.date === date)?.items ?? [];
    lists = { ...lists, shifts: items.map((i) => ({ id: i.shiftId, name: i.name })) };
    if (typeof values.shiftId === 'number' && !items.some((i) => i.shiftId === values.shiftId)) values = { ...values, shiftId: null };
  },

  change(key: string, part: 'text' | 'date' | 'time' | 'half' | 'pick', raw: string | number) {
    if (!template) return;
    values = applyChange(template.fields, values, lists, key, part, raw);
    if (error && error.key === key) error = null;
    if (me) writeDraft(me.staff.id, template.code, draftOf(values));
    this.setData({ submitError: '' });
    this.render();
    if (key === 'date' && part === 'date')
      this.loadShifts().then(
        () => this.render(),
        () => undefined,
      );
  },

  onText(e: WechatMiniprogram.Input) {
    this.change(String(e.currentTarget.dataset.key), 'text', e.detail.value);
  },
  onDate(e: WechatMiniprogram.PickerChange) {
    this.change(String(e.currentTarget.dataset.key), 'date', String(e.detail.value));
  },
  onTime(e: WechatMiniprogram.PickerChange) {
    this.change(String(e.currentTarget.dataset.key), 'time', String(e.detail.value));
  },
  onHalf(e: WechatMiniprogram.TouchEvent) {
    this.change(String(e.currentTarget.dataset.key), 'half', String(e.currentTarget.dataset.half));
  },
  onPick(e: WechatMiniprogram.PickerChange) {
    this.change(String(e.currentTarget.dataset.key), 'pick', Number(e.detail.value));
  },

  async onAddPhotos(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key);
    const view = this.data.fields.find((f) => f.key === key);
    if (!view || !view.room || this.data.uploading) return;
    try {
      const paths = await choosePhotos(view.room, false);
      if (!paths.length) return;
      this.setData({ uploading: true, submitError: '' });
      for (const path of paths) {
        const a = await uploadPhoto(path, 'photo');
        const cur = Array.isArray(values[key]) ? (values[key] as PickedFile[]) : [];
        values = { ...values, [key]: [...cur, { id: a.id, fileName: a.fileName, path }] };
        this.render();
      }
    } catch (err) {
      this.setData({ submitError: messageOf(err) });
    } finally {
      this.setData({ uploading: false });
    }
  },

  onRemoveFile(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key);
    const id = Number(e.currentTarget.dataset.id);
    const cur = Array.isArray(values[key]) ? (values[key] as PickedFile[]) : [];
    values = { ...values, [key]: cur.filter((x) => x.id !== id) };
    this.render();
  },

  async onSubmit() {
    const t = template;
    if (!t || !me || this.data.busy || this.data.uploading) return;
    error = checkValues(t.fields, values);
    if (error) {
      this.render();
      this.setData({ submitError: error.message });
      return;
    }
    const body: Record<string, unknown> = { clientKey: uuid(), templateId: t.id, form: toForm(t.fields, values) };
    await this.send({ staffId: me.staff.id, kind: 'approval_submit', ref: t.id, key: String(body.clientKey), path: '/oa/approvals', body, at: Date.now(), label: t.name });
  },

  async send(op: PendingOp) {
    const t = template;
    if (!t) return;
    this.setData({ busy: true, submitError: '' });
    let done = false;
    try {
      const r = await sendPending<ApprovalSaved>(op);
      if (r.status === 'not_sent') return this.setData({ submitError: SAVE_FAILED });
      if (r.status === 'signed_out') return toLogin();
      if (r.status === 'blocked') {
        this.showPending();
        return this.setData({ submitError: '上一次提交还没确定：先点「再提交一次」，拿到结果再说' });
      }
      if (r.status === 'ok') {
        // 交上了：按钮一直不能再点（不然再点一下是一张新单），表单清空，盖一层不让点，跳到这张单
        done = true;
        values = {};
        if (me) clearDraft(me.staff.id, t.code);
        wx.showToast({ title: '交上去了', icon: 'success', duration: 1500, mask: true });
        setTimeout(() => {
          if (alive) wx.redirectTo({ url: `/pages/approval/index?id=${r.data.approval.id}` });
        }, 600);
        return;
      }
      if (r.status === 'confirmed') {
        // 门店系统查到那一次已经交上了：与交上了一样（表单清空、去那张单；没有编号的去我的申请）
        done = true;
        values = {};
        if (me) clearDraft(me.staff.id, t.code);
        wx.showToast({ title: '已经交上了', icon: 'success', duration: 1500, mask: true });
        const url = r.refId ? `/pages/approval/index?id=${r.refId}` : '/pages/approvals/index';
        setTimeout(() => {
          if (alive) wx.redirectTo({ url });
        }, 600);
        return;
      }
      if (r.status === 'rejected') {
        this.setData({ submitError: messageOf(r.error) });
        this.showPending();
        return;
      }
      this.showPending();
    } finally {
      if (!done) this.setData({ busy: false });
    }
  },

  async onResend() {
    const p = template && me ? loadPending(me.staff.id, 'approval_submit', template.id) : null;
    if (p) await this.send(p);
  },

  async onPullDownRefresh() {
    if (template) await this.loadLists();
    else await this.load();
    wx.stopPullDownRefresh();
  },
});
