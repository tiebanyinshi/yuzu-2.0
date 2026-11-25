// 「券与会员权益 → 发放台账」（8.1.40，docs/V8140.md 第 3 节）：一张一张券查——谁发的、怎么发的（充值发的带充值单号）、
// 用了没有、几点用的、哪张结账单、抵了多少、从发出到用掉过了多久；按发放日期、券、怎么发的、状态、券号 / 会员筛，导出 CSV。

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { COUPON_ISSUE_KIND_LABELS, COUPON_ISSUE_KINDS } from '@shared/coupons';
import { COUPON_LEDGER_STATUS_LABELS, type CouponLedger, type CouponLedgerRow } from '@shared/coupon-ledger';
import { shiftDate } from '@shared/labels';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { downloadUrl, formatDateTime } from '../../lib/utils';
import { DataTable } from '../../components/DataTable';
import { Money } from '../../components/Money';
import { Button, Card, Input, Notice, SectionTitle, Select } from '../../components/ui';
import { useCouponTemplates } from '../coupons/queries';

interface Filter {
  from: string;
  to: string;
  kind: string;
  templateId: string;
  status: string;
  q: string;
}

const queryOf = (f: Filter) =>
  new URLSearchParams(Object.entries({ from: f.from, to: f.to, kind: f.kind, templateId: f.templateId, status: f.status, q: f.q.trim() }).filter(([, v]) => v !== '')).toString();

export function CouponLedgerCard() {
  const session = useSession();
  const templates = useCouponTemplates();
  const [f, setF] = useState<Filter>({ from: shiftDate(session.today, -29), to: session.today, kind: '', templateId: '', status: '', q: '' });
  const set = (patch: Partial<Filter>) => setF((cur) => ({ ...cur, ...patch }));
  const ledger = useQuery({
    queryKey: ['coupons', 'ledger', f] as const,
    queryFn: () => api.get<CouponLedger>(`/api/coupons/ledger?${queryOf(f)}`),
    placeholderData: keepPreviousData,
  });
  const s = ledger.data?.summary;
  return (
    <Card className="space-y-4 p-4" data-testid="coupon-ledger">
      <SectionTitle
        aside={
          <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} onClick={() => downloadUrl(`/api/coupons/ledger.csv?${queryOf(f)}`)} data-testid="coupon-ledger-export">
            导出 CSV
          </Button>
        }
      >
        发放台账
      </SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} className="w-[150px]" aria-label="发放日期从" />
        <span className="text-ink-3">至</span>
        <Input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} className="w-[150px]" aria-label="发放日期到" />
        <Select value={f.templateId} onChange={(e) => set({ templateId: e.target.value })} fullWidth={false} className="w-44" aria-label="券">
          <option value="">全部券</option>
          {(templates.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select value={f.kind} onChange={(e) => set({ kind: e.target.value })} fullWidth={false} className="w-36" aria-label="怎么发的">
          <option value="">全部发放方式</option>
          {COUPON_ISSUE_KINDS.map((k) => (
            <option key={k} value={k}>
              {COUPON_ISSUE_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        <Select value={f.status} onChange={(e) => set({ status: e.target.value })} fullWidth={false} className="w-28" aria-label="状态">
          <option value="">全部状态</option>
          {(['available', 'used', 'voided'] as const).map((k) => (
            <option key={k} value={k}>
              {COUPON_LEDGER_STATUS_LABELS[k]}
            </option>
          ))}
        </Select>
        <Input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="券号 / 会员" className="w-40" aria-label="券号或会员" data-testid="coupon-ledger-q" />
      </div>
      {ledger.error && <Notice tone="error" title={errorMessage(ledger.error)} />}
      {s && (
        <p className="text-[13px] text-ink-2" data-testid="coupon-ledger-summary">
          发出 <b className="num">{s.issued}</b> 张 · 已用 <b className="num">{s.used}</b> 张、抵 <Money cents={s.usedAmount} className="font-bold" /> · 作废 <b className="num">{s.voided}</b> 张
          {s.avgHoursToUse !== null && (
            <>
              {' '}
              · 用掉的平均发出后 <b className="num">{s.avgHoursToUse}</b> 小时
            </>
          )}
          {ledger.data?.truncated && <span className="text-ember"> · 超过 2000 张，只列最近的；全部请导出</span>}
        </p>
      )}
      <DataTable<CouponLedgerRow>
        rows={ledger.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={ledger.isPending}
        // 取不到时写取不到、给重试，不当成「没有发券」（合并前 Codex 审查 c79ca75）
        failed={ledger.isError && !ledger.data}
        onRetry={() => void ledger.refetch()}
        retrying={ledger.isFetching}
        failedTitle="发放台账没取到"
        empty="这段时间没有发券"
        columns={[
          { key: 'code', header: '券号', cell: (r) => <span className="num">{r.code}</span> },
          { key: 'name', header: '券', cell: (r) => r.templateName },
          { key: 'kind', header: '怎么发的', cell: (r) => `${r.kindLabel}${r.rechargeDocNo ? `（${r.rechargeDocNo}）` : ''}` },
          { key: 'issued', header: '发放', cell: (r) => `${formatDateTime(r.issuedAt)}${r.issuedByName ? ` ${r.issuedByName}` : ''}` },
          { key: 'member', header: '会员', cell: (r) => r.memberName ?? '无记名' },
          {
            key: 'status',
            header: '核销',
            cell: (r) =>
              r.status === 'used' ? (
                <span>
                  {formatDateTime(r.usedAt!)} · {r.checkoutNo} · <Money cents={r.usedAmount ?? 0} />
                </span>
              ) : r.status === 'voided' ? (
                `作废：${r.voidReason ?? ''}`
              ) : (
                `未用（到 ${r.validTo}）`
              ),
          },
          { key: 'hours', header: '发出到用掉', align: 'right', cell: (r) => (r.hoursToUse === null ? '—' : `${r.hoursToUse} 小时${r.status === 'used' ? '' : '（还没用）'}`) },
        ]}
      />
    </Card>
  );
}
