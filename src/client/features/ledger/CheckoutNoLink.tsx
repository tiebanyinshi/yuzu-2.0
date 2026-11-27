// 消费记录跳转明细（8.2.3，docs/V8223_FRONTDESK.md 第 7 条）：列出消费的地方（会员工作台的余额变动、流水）上的结账单号，
// 点一下在右侧打开那张结账单的明细（与「订单查询」同一个抽屉：逐行明细、收款、退款单）。看明细要「查看当日流水」，没有的只显示单号。
import { useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { OrderDrawer, type OrderTarget } from './OrderDrawer';

export function CheckoutNoLink({ checkoutId, checkoutNo, className }: { checkoutId: number; checkoutNo: string; className?: string }) {
  const can = useCan();
  const [open, setOpen] = useState<OrderTarget | null>(null);
  if (!can('ledger.readToday')) return <p className={cn('num text-[12.5px] text-ink-3', className)}>结账单 {checkoutNo}</p>;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen({ kind: 'checkout', id: checkoutId });
        }}
        className={cn('tap relative inline-flex items-center gap-1 text-[12.5px] font-semibold text-pine hover:underline', className)}
        data-testid={`checkout-link-${checkoutNo}`}
      >
        <ReceiptText className="size-3.5" /> 结账单 <span className="num">{checkoutNo}</span>
      </button>
      <OrderDrawer target={open} onClose={() => setOpen(null)} onOpen={setOpen} />
    </>
  );
}
