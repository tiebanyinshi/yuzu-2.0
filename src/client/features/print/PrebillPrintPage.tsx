import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { CheckoutPreview } from '@shared/checkout';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PrintedAt, PrintFrame, Row, Rule, SlipHeader, stamp, yuan } from './PrintFrame';

// 收银台「打单」（8.1.44《前台系统开发》第 9 条，docs/V8144_CASHIER.md）：80mm 预结单——几张手牌的已挂明细与按此刻估算的门票、
// 合计。只读：不收款、不扣会员余额、不释放手牌；数据就是结账对话框用的同一个核对接口（按打单这一刻计价），结账时按结账那一刻重算。
// 权益与优惠（券、会员折扣）在结账时选，预结单上不扣，写明「以结账为准」。

export function PrebillPrintPage() {
  const ids = (useParams().ids ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const q = useQuery({
    queryKey: ['print', 'prebill', ids.join(',')],
    queryFn: () => api.get<CheckoutPreview>(`/api/frontdesk/checkout-preview?ids=${ids.join(',')}`),
    enabled: ids.length > 0,
    refetchOnWindowFocus: false,
  });
  return (
    <PrintFrame title="预结单" ready={!!q.data} error={ids.length === 0 ? '没有要打的手牌' : q.error ? errorMessage(q.error) : null}>
      {q.data && <PrebillSlip d={q.data} />}
    </PrintFrame>
  );
}

function PrebillSlip({ d }: { d: CheckoutPreview }) {
  const session = useSession();
  const tz = session.timezone;
  return (
    <div data-testid="print-prebill">
      <SlipHeader title="预结单" />
      <p className="text-center font-bold">（不是结账单，未收款）</p>
      <Row left="手牌" right={d.visits.map((v) => v.tagCode).join('、')} />
      <Row left="计价时刻" right={stamp(d.pricedAt, tz)} />
      <Row left="收银" right={session.staff.displayName} />
      <Rule />
      {d.visits.map((v, i) => (
        <section key={v.visitId}>
          {i > 0 && <Rule />}
          <Row left={<span className="text-[13px] font-bold">手牌 {v.tagCode}</span>} right={v.memberName ? `会员 ${v.memberName}` : v.guestLabel || '散客'} />
          <p>入场 {stamp(v.checkedInAt, tz)}</p>
          <div className="mt-1 space-y-0.5">
            {v.lines.map((l) => (
              <Row key={l.id} left={`${l.name} × ${l.quantity}`} right={yuan(l.amount)} />
            ))}
            {v.ticket ? <Row left={`门票 · ${v.ticket.name}（${v.ticket.tierLabel}）`} right={yuan(v.ticket.amount)} /> : <Row left="门票（还没选票种，结账时选）" right="—" />}
          </div>
          <Row left="小计" right={yuan(v.amount)} strong />
        </section>
      ))}
      <Rule double />
      <Row left="应收合计" right={yuan(d.totalAmount)} big />
      <p className="mt-1">门票按打单这一刻的在店时长估算，结账时按结账那一刻重新计算；券、会员折扣与优惠在结账时扣，以结账单为准。</p>
      <PrintedAt />
    </div>
  );
}
