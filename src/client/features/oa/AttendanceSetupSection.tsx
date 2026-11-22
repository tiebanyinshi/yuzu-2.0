// OA-04 后台「考勤设置」（docs/OA.md 第 7 节）：班次、打卡点、考勤组三个页签。
// 班次的时间与打卡窗口说不通的（窗口重叠、休息段不在班次里）不让存，与服务端同一个核对（shiftProblem）。
// 新建带操作编号（与批量开通一样走「结果待确认」：结果不确定的记在本机，在页面上方查回、按原内容重新提交或确认作废，确认前不能再建）；
// 修改带版本：别人先改过就提示并载入最新的；结果不确定的关掉对话框重新载入（旧请求晚到也会因为版本对不上被拒绝）。

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LocateFixed, Plus, Search } from 'lucide-react';
import {
  OA_LOCATION_RADIUS_DEFAULT,
  OA_SHIFT_NAME_MAX,
  SHIFT_WINDOW_DEFAULTS,
  shiftProblem,
  type AttendanceSetup,
  type AttendanceSetupSaved,
  type OaAttendanceGroup,
  type OaLocation,
  type OaShift,
  type OaShiftTimes,
} from '@shared/oa';
import { positionLabel } from '@shared/positions';
import { clockText, parseClock, shiftTimeText } from '@shared/technician-admin';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useActiveSubTab } from '../../components/SubNav';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, Notice, Skeleton } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { AttendanceMonthlyTab } from './AttendanceMonthlyTab';
import { AttendanceResultsTab } from './AttendanceResultsTab';
import { FaceReviewTab } from './FaceReviewTab';
import { HolidayTab } from './HolidayTab';
import { LeaveTab } from './LeaveTab';
import { PunchRecordsTab } from './PunchRecordsTab';
import { ScheduleTab } from './ScheduleTab';

const SETUP_KEY = ['oa', 'attendance-setup'] as const;
const TABS = [
  { key: 'shifts', label: <span data-testid="att-tab-shifts">班次</span> },
  { key: 'locations', label: <span data-testid="att-tab-locations">打卡点</span> },
  { key: 'groups', label: <span data-testid="att-tab-groups">考勤组</span> },
  { key: 'schedule', label: <span data-testid="att-tab-schedule">排班</span> },
  { key: 'punches', label: <span data-testid="att-tab-punches">打卡记录</span> },
  { key: 'results', label: <span data-testid="att-tab-results">考勤结果</span> },
  { key: 'monthly', label: <span data-testid="att-tab-monthly">考勤月报</span> },
  { key: 'leave', label: <span data-testid="att-tab-leave">假种与余额</span> },
  { key: 'holidays', label: <span data-testid="att-tab-holidays">节假日</span> },
  { key: 'faces', label: <span data-testid="att-tab-faces">人脸审核</span> },
] as const;
/** 只有「查看本部门的排班与考勤」的部门负责人：只有「排班」「打卡记录」两个页签，只看 */
const DEPT_TABS = [
  { key: 'schedule', label: <span data-testid="att-tab-schedule">排班</span> },
  { key: 'punches', label: <span data-testid="att-tab-punches">打卡记录</span> },
  { key: 'results', label: <span data-testid="att-tab-results">考勤结果</span> },
  { key: 'monthly', label: <span data-testid="att-tab-monthly">考勤月报</span> },
] as const;

export function AttendanceSetupSection() {
  const manage = useCan()('hr.attendance');
  const qc = useQueryClient();
  return (
    <AdminPage
      section="attendance"
      wide
      tabs={manage ? TABS : DEPT_TABS}
      description={
        manage
          ? '班次（上下班时间、跨天班、打卡窗口）、打卡点（经纬度与有效半径）、考勤组（用哪几个打卡点、要不要 GPS / 人脸、成员）、排班、打卡记录、考勤结果、考勤月报、假种与假期余额、人脸审核。排班与打卡都按这里的设置；不删只停用。'
          : '本部门员工的排班、打卡记录、考勤结果与考勤月报（只看）。'
      }
    >
      {/* 新建班次、打卡点、考勤组与保存排班没收到结果的：查回、按原内容重新提交或确认作废 */}
      {manage && (
        <ErpPendingPanel
          types={['oa_attendance_setup', 'oa_schedule_save']}
          className="mb-4 space-y-2"
          onFound={() => {
            void qc.invalidateQueries({ queryKey: SETUP_KEY });
            void qc.invalidateQueries({ queryKey: ['oa', 'schedule'] });
          }}
        />
      )}
      <SectionBody manage={manage} />
    </AdminPage>
  );
}

function SectionBody({ manage }: { manage: boolean }) {
  const tab = useActiveSubTab() ?? (manage ? 'shifts' : 'schedule');
  const q = useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => api.get<AttendanceSetup>('/api/oa/attendance/setup'),
    enabled: manage && (tab === 'shifts' || tab === 'locations' || tab === 'groups'),
  });
  if (tab === 'punches') return <PunchRecordsTab />;
  if (tab === 'results') return <AttendanceResultsTab />;
  if (tab === 'monthly') return <AttendanceMonthlyTab />;
  if (manage && tab === 'leave') return <LeaveTab />;
  if (manage && tab === 'holidays') return <HolidayTab />;
  if (manage && tab === 'faces') return <FaceReviewTab />;
  if (!manage || tab === 'schedule') return <ScheduleTab />;
  if (q.isPending) return <Skeleton className="h-60" />;
  if (q.isError && !q.data) return <LoadFailed title="考勤设置没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const setup = q.data!;
  return tab === 'locations' ? <LocationsCard setup={setup} /> : tab === 'groups' ? <GroupsCard setup={setup} /> : <ShiftsCard setup={setup} />;
}

/**
 * 保存：成功换上最新的设置。
 * 新建：带操作编号、先记在本机再发（sendErpOp）；结果不确定的关掉对话框，到页面上方查回、按原内容重新提交或确认作废，
 * 上一次新建还待确认时不让再建（Codex 审查 8e60b6b：查不到不能断定没建上，重新填一份可能两份都建出来）。
 * 修改：带版本；别人先改过、结果不确定的关掉对话框重新载入。
 */
function useSave(onClose: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  // 记在本机的都算，包括还在路上的（Codex 审查 56b128b：只看待确认的话，切个页签回来就能再建一份）
  const pending = useErpRecorded(['oa_attendance_setup']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (target: { create: string; summary: string } | { update: string }, body: object, ok: string) => {
    if ('create' in target && pending.length > 0) {
      setError('上一次新建结果待确认：请先关掉这个窗口，在页面上方查回、按原内容重新提交或作废');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let next: AttendanceSetupSaved;
      if ('create' in target) {
        const key = uuid();
        next = await sendErpOp<AttendanceSetupSaved>({
          key,
          type: 'oa_attendance_setup',
          url: target.create,
          body: { ...body, clientKey: key, storeId: session.store.id },
          summary: target.summary,
          staffName: session.staff.displayName,
        });
      } else next = await api.put<AttendanceSetupSaved>(target.update, body);
      qc.setQueryData(SETUP_KEY, next);
      toast({ tone: 'success', title: next.created?.replayed ? `${ok}（之前已经建好）` : ok });
      onClose();
    } catch (err) {
      if (err instanceof UncertainError) {
        const creating = 'create' in target;
        toast({
          tone: 'info',
          title: creating ? '新建结果待确认' : `${err.message}，不确定有没有保存上`,
          body: creating ? '已记在本机：请在页面上方查回、按原内容重新提交或作废，确认前不要重新填一份。' : '已重新载入，请核对列表里是不是已经改好，没改上再重新保存',
        });
        onClose();
        void qc.invalidateQueries({ queryKey: SETUP_KEY });
      } else if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        toast({ tone: 'info', title: errorMessage(err), body: '已载入最新内容，请核对后再改' });
        onClose();
        void qc.invalidateQueries({ queryKey: SETUP_KEY });
      } else if (err instanceof ErpPendingStoreError) setError(err.message);
      else setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, setError, run };
}

const StatusBadge = ({ active }: { active: boolean }) => (active ? <Badge tone="pine">启用</Badge> : <Badge tone="clay">已停用</Badge>);

function CardHead({ title, hint, onNew, newLabel, testId }: { title: string; hint: ReactNode; onNew: () => void; newLabel: string; testId: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-[16px] font-bold text-ink">{title}</h2>
        <p className="mt-0.5 text-[13px] text-ink-3">{hint}</p>
      </div>
      <Button variant="secondary" icon={<Plus className="size-4" />} onClick={onNew} data-testid={testId}>
        {newLabel}
      </Button>
    </div>
  );
}

// ───────────────────────── 班次 ─────────────────────────

const windowText = (s: OaShiftTimes) =>
  `上班卡提前 ${s.inAdvanceMinutes} 分、上班后 ${s.inAfterMinutes} 分内${s.lateGraceMinutes ? `（${s.lateGraceMinutes} 分内不算迟到）` : ''}；下班前 ${s.outBeforeMinutes} 分起、延后 ${s.outDelayMinutes} 分`;

function ShiftsCard({ setup }: { setup: AttendanceSetup }) {
  const [editing, setEditing] = useState<OaShift | 'new' | null>(null);
  const columns: DataColumn<OaShift>[] = [
    { key: 'name', header: '班次', cell: (s) => <span className="font-bold">{s.name}</span> },
    { key: 'time', header: '上下班', cell: (s) => <span className="num">{shiftTimeText(s)}</span> },
    { key: 'rest', header: '休息', cell: (s) => (s.restStartMinute === null ? '—' : <span className="num">{shiftTimeText({ startMinute: s.restStartMinute, endMinute: s.restEndMinute! })}</span>) },
    { key: 'window', header: '打卡窗口', cell: (s) => <span className="text-[12.5px] text-ink-2">{windowText(s)}</span>, className: 'max-md:hidden' },
    { key: 'status', header: '状态', cell: (s) => <StatusBadge active={s.active} /> },
    {
      key: 'edit',
      header: '',
      align: 'right',
      cell: (s) => (
        <Button size="sm" variant="ghost" onClick={() => setEditing(s)} data-testid={`att-shift-edit-${s.name}`}>
          编辑
        </Button>
      ),
    },
  ];
  return (
    <Card className="p-5" data-testid="att-shifts">
      <CardHead
        title="班次"
        hint="下班不晚于上班就是跨天班（如 22:00–次日 06:00）；三班倒的早、中、夜班各建一个。00:00 上班的班次，上班卡可以从前一天晚上打。"
        onNew={() => setEditing('new')}
        newLabel="新建班次"
        testId="att-shift-new"
      />
      <DataTable
        columns={columns}
        rows={setup.shifts}
        rowKey={(s) => s.id}
        empty="还没有班次"
        emptyDescription="先建班次（如早班 08:00–16:00、夜班 00:00–08:00），再到考勤组与排班里用。"
        testId="att-shift-list"
      />
      <ShiftDialog target={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

const minutesField = (v: string) => (/^\d{1,3}$/.test(v) ? Number(v) : null);

function ShiftDialog({ target, onClose }: { target: OaShift | 'new' | null; onClose: () => void }) {
  const existing = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [restStart, setRestStart] = useState('');
  const [restEnd, setRestEnd] = useState('');
  const [win, setWin] = useState<Record<keyof typeof SHIFT_WINDOW_DEFAULTS, string>>(() => stringify(SHIFT_WINDOW_DEFAULTS));
  const [active, setActive] = useState(true);
  const save = useSave(onClose);
  useResetOnOpen(
    !!target,
    () => {
      setName(existing?.name ?? '');
      setStart(existing ? clockText(existing.startMinute) : '08:00');
      setEnd(existing ? clockText(existing.endMinute) : '16:00');
      setRestStart(existing?.restStartMinute != null ? clockText(existing.restStartMinute) : '');
      setRestEnd(existing?.restEndMinute != null ? clockText(existing.restEndMinute) : '');
      setWin(stringify(existing ?? SHIFT_WINDOW_DEFAULTS));
      setActive(existing?.active ?? true);
      save.setError(null);
    },
    [target],
  );
  const startMinute = parseClock(start);
  const endMinute = parseClock(end);
  const restStartMinute = restStart.trim() ? parseClock(restStart) : null;
  const restEndMinute = restEnd.trim() ? parseClock(restEnd) : null;
  const nums = Object.fromEntries(Object.entries(win).map(([k, v]) => [k, minutesField(v)])) as Record<keyof typeof SHIFT_WINDOW_DEFAULTS, number | null>;
  const times =
    startMinute !== null && endMinute !== null && Object.values(nums).every((n) => n !== null)
      ? ({ startMinute, endMinute, restStartMinute, restEndMinute, ...(nums as Record<keyof typeof SHIFT_WINDOW_DEFAULTS, number>) } satisfies OaShiftTimes)
      : null;
  const problem = !name.trim()
    ? '请填写班次的名字'
    : startMinute === null || endMinute === null
      ? '上下班时间按 HH:MM 填'
      : (restStart.trim() && restStartMinute === null) || (restEnd.trim() && restEndMinute === null)
        ? '休息时间按 HH:MM 填'
        : !times
          ? '打卡窗口的时长填 0–999 的整数（分钟）'
          : shiftProblem(times);

  const submit = () => {
    if (!times || problem) return;
    const body = { name: name.trim(), ...times, active, version: existing?.version };
    void save.run(existing ? { update: `/api/oa/attendance/shifts/${existing.id}` } : { create: '/api/oa/attendance/shifts', summary: `新建班次「${body.name}」` }, body, `班次「${body.name}」已保存`);
  };
  const setW = (k: keyof typeof SHIFT_WINDOW_DEFAULTS) => (e: React.ChangeEvent<HTMLInputElement>) => setWin((w) => ({ ...w, [k]: e.target.value.replace(/\D/g, '') }));
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      width="max-w-2xl"
      title={existing ? `编辑班次 · ${existing.name}` : '新建班次'}
      description="上班窗口要在下班窗口开始之前结束，不然一次打卡分不清是上班还是下班。"
      footer={
        <>
          {(save.error || problem) && (
            <span className="mr-auto self-center text-[13px] text-clay" data-testid="att-shift-problem">
              {save.error ?? problem}
            </span>
          )}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={save.saving} disabled={!!problem} onClick={submit} data-testid="att-shift-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名字" className="sm:col-span-2">
          <Input value={name} maxLength={OA_SHIFT_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="如 早班、夜班" data-testid="att-shift-name" />
        </Field>
        <Field label="上班时间">
          <Input value={start} onChange={(e) => setStart(e.target.value)} placeholder="08:00" inputMode="numeric" data-testid="att-shift-start" />
        </Field>
        <Field label="下班时间" hint={startMinute !== null && endMinute !== null && endMinute <= startMinute ? '跨天班：下班在第二天' : undefined}>
          <Input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="16:00" inputMode="numeric" data-testid="att-shift-end" />
        </Field>
        <Field label="休息开始（可不填）">
          <Input value={restStart} onChange={(e) => setRestStart(e.target.value)} placeholder="12:00" inputMode="numeric" />
        </Field>
        <Field label="休息结束（可不填）">
          <Input value={restEnd} onChange={(e) => setRestEnd(e.target.value)} placeholder="13:00" inputMode="numeric" />
        </Field>
      </div>
      <p className="mt-5 mb-2 text-[13px] font-bold text-ink-2">打卡窗口（分钟）</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="上班卡可提前">
          <Input value={win.inAdvanceMinutes} onChange={setW('inAdvanceMinutes')} inputMode="numeric" data-testid="att-shift-in-advance" />
        </Field>
        <Field label="迟到弹性" hint="这几分钟内不算迟到">
          <Input value={win.lateGraceMinutes} onChange={setW('lateGraceMinutes')} inputMode="numeric" />
        </Field>
        <Field label="上班后再开" hint="过了算缺上班卡">
          <Input value={win.inAfterMinutes} onChange={setW('inAfterMinutes')} inputMode="numeric" data-testid="att-shift-in-after" />
        </Field>
        <Field label="下班前开始" hint="这段打的算早退">
          <Input value={win.outBeforeMinutes} onChange={setW('outBeforeMinutes')} inputMode="numeric" />
        </Field>
        <Field label="下班卡可延后" hint="过了算缺下班卡">
          <Input value={win.outDelayMinutes} onChange={setW('outDelayMinutes')} inputMode="numeric" />
        </Field>
      </div>
      {existing && (
        <div className="mt-4">
          <ConfirmCheck checked={!active} onChange={(v) => setActive(!v)} tone="clay">
            停用这个班次（已经排上的班照旧，之后不能再排）
          </ConfirmCheck>
        </div>
      )}
    </Dialog>
  );
}

function stringify(w: Record<keyof typeof SHIFT_WINDOW_DEFAULTS, number>): Record<keyof typeof SHIFT_WINDOW_DEFAULTS, string> {
  return {
    inAdvanceMinutes: String(w.inAdvanceMinutes),
    lateGraceMinutes: String(w.lateGraceMinutes),
    inAfterMinutes: String(w.inAfterMinutes),
    outBeforeMinutes: String(w.outBeforeMinutes),
    outDelayMinutes: String(w.outDelayMinutes),
  };
}

// ───────────────────────── 打卡点 ─────────────────────────

function LocationsCard({ setup }: { setup: AttendanceSetup }) {
  const [editing, setEditing] = useState<OaLocation | 'new' | null>(null);
  const columns: DataColumn<OaLocation>[] = [
    { key: 'name', header: '打卡点', cell: (l) => <span className="font-bold">{l.name}</span> },
    { key: 'address', header: '地址', cell: (l) => l.address || '—', className: 'max-md:hidden' },
    { key: 'pos', header: '经纬度', cell: (l) => <span className="num text-[12.5px]">{`${l.lat.toFixed(6)}, ${l.lng.toFixed(6)}`}</span> },
    { key: 'radius', header: '有效半径', numeric: true, cell: (l) => `${l.radiusM} 米` },
    { key: 'status', header: '状态', cell: (l) => <StatusBadge active={l.active} /> },
    {
      key: 'edit',
      header: '',
      align: 'right',
      cell: (l) => (
        <Button size="sm" variant="ghost" onClick={() => setEditing(l)} data-testid={`att-location-edit-${l.name}`}>
          编辑
        </Button>
      ),
    },
  ];
  return (
    <Card className="p-5" data-testid="att-locations">
      <CardHead
        title="打卡点"
        hint="员工打卡时上报位置，离哪个打卡点在有效半径以内就算在范围里；都不在范围里的可以转外勤打卡。"
        onNew={() => setEditing('new')}
        newLabel="新建打卡点"
        testId="att-location-new"
      />
      <DataTable columns={columns} rows={setup.locations} rowKey={(l) => l.id} empty="还没有打卡点" emptyDescription="在门店里用手机打开这一页，点「用当前位置」最省事。" testId="att-location-list" />
      <LocationDialog target={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function LocationDialog({ target, onClose }: { target: OaLocation | 'new' | null; onClose: () => void }) {
  const existing = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radius, setRadius] = useState('');
  const [active, setActive] = useState(true);
  const [locating, setLocating] = useState(false);
  // 每次打开、关闭都换一个号：定位晚到时对话框已经关了或换成了别的打卡点，就不填（Codex 审查 56b128b）
  const locateToken = useRef(0);
  const save = useSave(onClose);
  useResetOnOpen(
    !!target,
    () => {
      locateToken.current += 1;
      setLocating(false);
      setName(existing?.name ?? '');
      setAddress(existing?.address ?? '');
      setLat(existing ? existing.lat.toFixed(6) : '');
      setLng(existing ? existing.lng.toFixed(6) : '');
      setRadius(String(existing?.radiusM ?? OA_LOCATION_RADIUS_DEFAULT));
      setActive(existing?.active ?? true);
      save.setError(null);
    },
    [target],
  );
  const latN = Number(lat);
  const lngN = Number(lng);
  const radiusN = /^\d{1,4}$/.test(radius) ? Number(radius) : null;
  const problem = !name.trim()
    ? '请填写打卡点的名字'
    : !lat.trim() || !Number.isFinite(latN) || Math.abs(latN) > 90
      ? '纬度在 -90 到 90 之间'
      : !lng.trim() || !Number.isFinite(lngN) || Math.abs(lngN) > 180
        ? '经度在 -180 到 180 之间'
        : radiusN === null || radiusN < 10 || radiusN > 3000
          ? '有效半径填 10–3000 米'
          : null;
  const locate = () => {
    if (!('geolocation' in navigator)) {
      save.setError('这台设备取不到位置，请手动填写经纬度');
      return;
    }
    setLocating(true);
    const token = locateToken.current;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (token !== locateToken.current) return;
        setLat(pos.coords.latitude.toFixed(6));
        setLng(pos.coords.longitude.toFixed(6));
        setLocating(false);
      },
      () => {
        if (token !== locateToken.current) return;
        save.setError('没取到位置（没有授权或信号不好），请手动填写经纬度');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  const submit = () => {
    if (problem) return;
    const body = { name: name.trim(), address: address.trim(), lat: latN, lng: lngN, radiusM: radiusN, active, version: existing?.version };
    void save.run(
      existing ? { update: `/api/oa/attendance/locations/${existing.id}` } : { create: '/api/oa/attendance/locations', summary: `新建打卡点「${body.name}」` },
      body,
      `打卡点「${body.name}」已保存`,
    );
  };
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={existing ? `编辑打卡点 · ${existing.name}` : '新建打卡点'}
      description="经纬度用手机定位（WGS-84）取的数字；地图软件里复制来的坐标可能有几百米的偏差，填完可点「在地图上看看」核对。"
      footer={
        <>
          {(save.error || problem) && <span className="mr-auto self-center text-[13px] text-clay">{save.error ?? problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={save.saving} disabled={!!problem} onClick={submit} data-testid="att-location-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名字">
          <Input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder="如 总店大门" data-testid="att-location-name" />
        </Field>
        <Field label="有效半径（米）">
          <Input value={radius} onChange={(e) => setRadius(e.target.value.replace(/\D/g, ''))} inputMode="numeric" data-testid="att-location-radius" />
        </Field>
        <Field label="地址（可不填）" className="sm:col-span-2">
          <Input value={address} maxLength={100} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="纬度">
          <Input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" placeholder="31.230416" data-testid="att-location-lat" />
        </Field>
        <Field label="经度">
          <Input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" placeholder="121.473701" data-testid="att-location-lng" />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" icon={<LocateFixed className="size-4" />} loading={locating} onClick={locate}>
          用当前位置
        </Button>
        {!problem && (
          <a
            href={`https://www.openstreetmap.org/?mlat=${latN}&mlon=${lngN}#map=17/${latN}/${lngN}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[13px] font-bold text-lake hover:underline"
          >
            在地图上看看
          </a>
        )}
      </div>
      {existing && (
        <div className="mt-4">
          <ConfirmCheck checked={!active} onChange={(v) => setActive(!v)} tone="clay">
            停用这个打卡点（考勤组里不再用它判断范围）
          </ConfirmCheck>
        </div>
      )}
    </Dialog>
  );
}

// ───────────────────────── 考勤组 ─────────────────────────

function GroupsCard({ setup }: { setup: AttendanceSetup }) {
  const [editing, setEditing] = useState<OaAttendanceGroup | 'new' | null>(null);
  const ungrouped = setup.employees.filter((e) => e.groupId === null);
  const locName = (id: number) => setup.locations.find((l) => l.id === id)?.name ?? '—';
  const columns: DataColumn<OaAttendanceGroup>[] = [
    { key: 'name', header: '考勤组', cell: (g) => <span className="font-bold">{g.name}</span> },
    { key: 'members', header: '人数', numeric: true, cell: (g) => g.memberIds.length },
    { key: 'locations', header: '打卡点', cell: (g) => (g.locationIds.length ? g.locationIds.map(locName).join('、') : '—'), className: 'max-md:hidden' },
    {
      key: 'mode',
      header: '打卡方式',
      cell: (g) => (
        <span className="flex flex-wrap gap-1">
          {g.gpsRequired ? <Badge tone="lake">GPS</Badge> : <Badge>不限位置</Badge>}
          {g.faceRequired && <Badge tone="yuzu">人脸</Badge>}
        </span>
      ),
    },
    { key: 'status', header: '状态', cell: (g) => <StatusBadge active={g.active} /> },
    {
      key: 'edit',
      header: '',
      align: 'right',
      cell: (g) => (
        <Button size="sm" variant="ghost" onClick={() => setEditing(g)} data-testid={`att-group-edit-${g.name}`}>
          编辑
        </Button>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      {ungrouped.length > 0 && (
        <Notice tone="warning" title={`还有 ${ungrouped.length} 位员工没进考勤组`}>
          <span data-testid="att-ungrouped">{ungrouped.map((e) => e.name).join('、')}</span>：员工都要归属一个考勤组，才排得了班、打得了卡。
        </Notice>
      )}
      <Card className="p-5" data-testid="att-groups">
        <CardHead title="考勤组" hint="一群共用一套打卡规则的员工。一位员工只在一个组里；加到别的组会从原来的组挪过去。" onNew={() => setEditing('new')} newLabel="新建考勤组" testId="att-group-new" />
        <DataTable columns={columns} rows={setup.groups} rowKey={(g) => g.id} empty="还没有考勤组" emptyDescription="先建打卡点，再建考勤组、把员工加进来。" testId="att-group-list" />
      </Card>
      <GroupDialog setup={setup} target={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function GroupDialog({ setup, target, onClose }: { setup: AttendanceSetup; target: OaAttendanceGroup | 'new' | null; onClose: () => void }) {
  const existing = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [gps, setGps] = useState(true);
  const [face, setFace] = useState(false);
  const [active, setActive] = useState(true);
  const [locations, setLocations] = useState<number[]>([]);
  const [members, setMembers] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const save = useSave(onClose);
  useResetOnOpen(
    !!target,
    () => {
      setName(existing?.name ?? '');
      setGps(existing?.gpsRequired ?? true);
      setFace(existing?.faceRequired ?? false);
      setActive(existing?.active ?? true);
      setLocations(existing?.locationIds ?? []);
      setMembers(existing?.memberIds ?? []);
      setSearch('');
      save.setError(null);
    },
    [target],
  );
  const groupName = (id: number | null) => setup.groups.find((g) => g.id === id)?.name;
  const shown = useMemo(() => {
    const k = search.trim();
    return setup.employees.filter((e) => !k || e.name.includes(k) || positionLabel(e.position).includes(k));
  }, [setup.employees, search]);
  const activeLocations = locations.filter((id) => setup.locations.find((l) => l.id === id)?.active);
  const problem = !name.trim() ? '请填写考勤组的名字' : active && gps && activeLocations.length === 0 ? '要 GPS 打卡的考勤组至少选一个启用中的打卡点' : null;
  const toggle = (list: number[], id: number) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const submit = () => {
    if (problem) return;
    const body = { name: name.trim(), gpsRequired: gps, faceRequired: face, active, locationIds: locations, memberIds: members, version: existing?.version };
    void save.run(
      existing ? { update: `/api/oa/attendance/groups/${existing.id}` } : { create: '/api/oa/attendance/groups', summary: `新建考勤组「${body.name}」` },
      body,
      `考勤组「${body.name}」已保存`,
    );
  };
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      width="max-w-2xl"
      title={existing ? `编辑考勤组 · ${existing.name}` : '新建考勤组'}
      footer={
        <>
          {(save.error || problem) && <span className="mr-auto self-center text-[13px] text-clay">{save.error ?? problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={save.saving} disabled={!!problem} onClick={submit} data-testid="att-group-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="名字">
          <Input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="如 前厅组、夜班组" data-testid="att-group-name" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <ConfirmCheck checked={gps} onChange={setGps}>
            要 GPS：在打卡点范围里才算正常打卡
          </ConfirmCheck>
          <ConfirmCheck checked={face} onChange={setFace}>
            要人脸（人脸录入审核通过后生效）
          </ConfirmCheck>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-semibold text-ink-2">打卡点</p>
          {setup.locations.length === 0 ? (
            <p className="text-[13px] text-ink-3">还没有打卡点，先到「打卡点」页签建。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {setup.locations.map((l) => (
                <Chip key={l.id} on={locations.includes(l.id)} onClick={() => setLocations((x) => toggle(x, l.id))} testId={`att-group-loc-${l.name}`}>
                  {l.name}
                  {!l.active && '（已停用）'}
                </Chip>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <p className="text-[13px] font-semibold text-ink-2">成员（已选 {members.length} 人）</p>
            <div className="relative ml-auto w-full sm:w-56">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜姓名或岗位" className="pl-9" data-testid="att-group-search" />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
            {shown.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-ink-3">没有找到员工</p>
            ) : (
              shown.map((e) => {
                const other = e.groupId !== null && e.groupId !== existing?.id ? groupName(e.groupId) : undefined;
                const on = members.includes(e.staffId);
                return (
                  <label key={e.staffId} className={cn('flex cursor-pointer items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0', on && 'bg-pine-tint')}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setMembers((x) => toggle(x, e.staffId))}
                      className="size-4 accent-[var(--color-pine)]"
                      data-testid={`att-group-member-${e.name}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-[14px] font-medium text-ink">{e.name}</span>
                      <span className="ml-2 text-[12.5px] text-ink-3">{positionLabel(e.position)}</span>
                    </span>
                    {other && <span className="text-[12px] text-ember">{on ? `从「${other}」挪过来` : `在「${other}」`}</span>}
                  </label>
                );
              })
            )}
          </div>
        </div>
        {existing && (
          <ConfirmCheck checked={!active} onChange={(v) => setActive(!v)} tone="clay">
            停用这个考勤组（成员都移出，回到「没进考勤组」）
          </ConfirmCheck>
        )}
      </div>
    </Dialog>
  );
}

function Chip({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'tap relative h-10 rounded-full border px-4 text-[13px] font-semibold transition-colors',
        on ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong bg-card text-ink-2 hover:border-ink-4',
      )}
    >
      {children}
    </button>
  );
}
