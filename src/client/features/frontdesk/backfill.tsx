// 按实际时间补录纸质单（R1.9，店主 2026-10-29 决定要做；细则待确认，见 docs/PENDING_DECISIONS.md）。
//
// 值班经理及以上在前台打开「补录纸质单」：填纸质单号与纸质单上的实际时间后，接待、加项目、结账都按这个时间办理
// （门票按实际在店时长计算，营业日按实际时间归属）；每一步换成纸质单上对应的时间再办理。补录的结账不能用会员储值。
//
// 补单（8.2.3，docs/V8223_FRONTDESK.md 第 9 条）：同一个补录条换成「补单」模式——有「补单」权限的人选实际时间与出单员（单号选填），
// 收银台「加项目」按这个时间、出单员登记（餐饮不打厨房单，明细标「补单」）；接待、结账不能在补单模式下做。

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FilePenLine, NotebookPen, X } from 'lucide-react';
import { BACKFILL_WINDOW_HOURS, SLIP_NO_PATTERN, supplementSlipNo, type BackfillRequest } from '@shared/backfill';
import type { SupplementIssuer } from '@shared/frontdesk-v8223';
import { api } from '../../lib/api';
import { useCan } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { Button, Input, Notice, Select } from '../../components/ui';

interface BackfillState {
  active: boolean;
  slipNo: string;
  /** datetime-local 的值（门店电脑的本地时间） */
  at: string;
  /** paper 补录纸质单（默认）/ supplement 补单（8.2.3） */
  mode?: 'paper' | 'supplement';
  /** 补单的出单员 */
  issuerId?: number | null;
}

interface BackfillValue {
  state: BackfillState;
  setState: (next: BackfillState) => void;
  /** 补录模式下随请求提交的内容；平时为 null */
  request: BackfillRequest | null;
  /** 补录模式下还不能提交的原因（单号或时间没填对）；没有问题为 null */
  problem: string | null;
}

const INACTIVE: BackfillValue = { state: { active: false, slipNo: '', at: '' }, setState: () => {}, request: null, problem: null };
const BackfillContext = createContext<BackfillValue>(INACTIVE);

export function BackfillProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BackfillState>(INACTIVE.state);
  const value = useMemo<BackfillValue>(() => {
    if (!state.active) return { state, setState, request: null, problem: null };
    const supplement = state.mode === 'supplement';
    const at = state.at ? new Date(state.at) : null;
    // 补单的单号选填：没填按实际时间记 BD-月日-时分
    const slipNo = state.slipNo.trim() || (supplement && at && !Number.isNaN(at.getTime()) ? supplementSlipNo(at) : '');
    let problem: string | null = null;
    if (!SLIP_NO_PATTERN.test(slipNo)) problem = supplement ? '单号只能是字母、数字或短横线' : '请填写纸质单号（字母、数字或短横线）';
    else if (!at || Number.isNaN(at.getTime())) problem = supplement ? '请填写实际时间' : '请填写纸质单上的实际时间';
    else if (at.getTime() > Date.now() + 60_000) problem = '实际时间不能晚于现在';
    else if (Date.now() - at.getTime() > BACKFILL_WINDOW_HOURS * 3_600_000) problem = `只能补 ${BACKFILL_WINDOW_HOURS} 小时以内的`;
    else if (supplement && !state.issuerId) problem = '请选择出单员';
    const request = problem || !at ? null : { slipNo, at: at.toISOString(), ...(supplement ? { issuerId: state.issuerId! } : {}) };
    return { state, setState, request, problem };
  }, [state]);
  return <BackfillContext.Provider value={value}>{children}</BackfillContext.Provider>;
}

export const useBackfill = () => useContext(BackfillContext);

/** 请求体里的补录信息：平时不带 */
export const backfillBody = (b: BackfillValue) => (b.request ? { backfill: b.request } : {});
/** 待确认摘要里的补录说明 */
export const backfillSummary = (b: BackfillValue) =>
  b.request ? (b.request.issuerId ? `（补单，实际时间 ${formatDateTime(b.request.at)}）` : `（补录纸质单 ${b.request.slipNo}，实际时间 ${formatDateTime(b.request.at)}）`) : '';

/** 收银台顶上的「补单」开关（8.2.3）：有「补单」权限的人才有 */
export function SupplementToggle() {
  const can = useCan();
  const { state, setState } = useBackfill();
  if (!can('frontdesk.supplement')) return null;
  const on = state.active && state.mode === 'supplement';
  return (
    <Button
      size="sm"
      variant={on ? 'accent' : 'ghost'}
      icon={<NotebookPen className="size-4" />}
      aria-pressed={on}
      onClick={() => setState(on ? INACTIVE.state : { active: true, mode: 'supplement', slipNo: '', at: '', issuerId: null })}
      data-testid="supplement-toggle"
    >
      补单
    </Button>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
/** datetime-local 的取值格式（本地时间，到分钟） */
const localValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 前台顶部的补录条：纸质单号、实际时间、退出补录 */
export function BackfillBar() {
  const { state, setState, problem } = useBackfill();
  if (!state.active) return null;
  if (state.mode === 'supplement') return <SupplementBar />;
  const now = new Date();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-yuzu-deep/30 bg-yuzu-tint px-3.5 py-2.5" data-testid="backfill-bar">
      <span className="flex items-center gap-1.5 text-[14px] font-bold text-yuzu-deep">
        <FilePenLine className="size-4" /> 补录纸质单
      </span>
      <label className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
        纸质单号
        <Input
          value={state.slipNo}
          onChange={(e) => setState({ ...state, slipNo: e.target.value })}
          placeholder="如 P0012"
          maxLength={32}
          fullWidth={false}
          className="h-9 w-32"
          aria-label="纸质单号"
          data-testid="backfill-slip"
        />
      </label>
      <label className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
        实际时间
        <Input
          type="datetime-local"
          value={state.at}
          onChange={(e) => setState({ ...state, at: e.target.value })}
          min={localValue(new Date(now.getTime() - BACKFILL_WINDOW_HOURS * 3_600_000))}
          max={localValue(now)}
          fullWidth={false}
          className="h-9 w-[210px]"
          aria-label="实际时间"
          data-testid="backfill-at"
        />
      </label>
      <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => setState(INACTIVE.state)} data-testid="backfill-exit">
        退出补录
      </Button>
      <p className="w-full text-[12.5px] leading-relaxed text-ink-2">
        {problem ? <b className="text-clay">{problem}</b> : '接待、加项目、结账都按这个时间办理（门票按实际在店时长计算），每一步换成纸质单上对应的时间。补录的结账不能用会员储值。'}
      </p>
    </div>
  );
}

/** 补单条（8.2.3）：实际时间、出单员、单号（选填）、退出补单 */
function SupplementBar() {
  const { state, setState, problem } = useBackfill();
  const issuers = useQuery({ queryKey: ['frontdesk', 'supplement-issuers'], queryFn: () => api.get<SupplementIssuer[]>('/api/frontdesk/supplement/issuers'), staleTime: 60_000 });
  const now = new Date();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-lake/30 bg-lake-soft/50 px-3.5 py-2.5" data-testid="supplement-bar">
      <span className="flex items-center gap-1.5 text-[14px] font-bold text-lake">
        <NotebookPen className="size-4" /> 补单
      </span>
      <label className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
        实际时间
        <Input
          type="datetime-local"
          value={state.at}
          onChange={(e) => setState({ ...state, at: e.target.value })}
          min={localValue(new Date(now.getTime() - BACKFILL_WINDOW_HOURS * 3_600_000))}
          max={localValue(now)}
          fullWidth={false}
          className="h-9 w-[210px]"
          aria-label="实际时间"
          data-testid="supplement-at"
        />
      </label>
      <label className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
        出单员
        <Select
          value={state.issuerId ?? ''}
          onChange={(e) => setState({ ...state, issuerId: Number(e.target.value) || null })}
          fullWidth={false}
          className="h-9 w-36"
          aria-label="出单员"
          data-testid="supplement-issuer"
        >
          <option value="">{issuers.isPending ? '读取中…' : '请选择'}</option>
          {(issuers.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
        单号
        <Input
          value={state.slipNo}
          onChange={(e) => setState({ ...state, slipNo: e.target.value })}
          placeholder="选填"
          maxLength={32}
          fullWidth={false}
          className="h-9 w-28"
          aria-label="单号"
          data-testid="supplement-slip"
        />
      </label>
      <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => setState(INACTIVE.state)} data-testid="supplement-exit">
        退出补单
      </Button>
      <p className="w-full text-[12.5px] leading-relaxed text-ink-2">
        {problem ? <b className="text-clay">{problem}</b> : '「加项目」按这个时间、出单员补给在店客人（餐饮的菜不打厨房单，明细标「补单」）；补错了照常作废并写原因。接待、结账请先退出补单。'}
      </p>
    </div>
  );
}

/** 对话框里的补录提示：正在按纸质单补录；单号或时间没填好时说明原因（不能提交） */
export function BackfillNotice({ action }: { action: string }) {
  const b = useBackfill();
  if (!b.state.active) return null;
  if (b.state.mode === 'supplement') {
    if (action !== '挂账') {
      return (
        <Notice tone="error" icon={<NotebookPen className="size-4" />} title={`补单模式下不能${action}`}>
          补单只能补餐饮、项目；请先在顶上「退出补单」，再{action}。
        </Notice>
      );
    }
    return b.problem || !b.request ? (
      <Notice tone="error" icon={<NotebookPen className="size-4" />} title={`补单信息没填好：${b.problem ?? ''}`}>
        请在顶上的补单条里选好实际时间与出单员，再挂账。
      </Notice>
    ) : (
      <Notice tone="warning" icon={<NotebookPen className="size-4" />} title={`补单 · 实际时间 ${formatDateTime(b.request.at)}`}>
        本次挂账按实际时间与出单员登记，餐饮的菜不打厨房单，明细标「补单」。
      </Notice>
    );
  }
  if (b.problem || !b.request) {
    return (
      <Notice tone="error" icon={<FilePenLine className="size-4" />} title={`补录信息没填好：${b.problem ?? ''}`}>
        请在前台顶部的补录条里填好纸质单号与实际时间，再{action}。
      </Notice>
    );
  }
  return (
    <Notice tone="warning" icon={<FilePenLine className="size-4" />} title={`补录纸质单 ${b.request.slipNo} · 实际时间 ${formatDateTime(b.request.at)}`}>
      本次{action}按纸质单上的实际时间登记，单据与日结都标「补录」。
    </Notice>
  );
}
