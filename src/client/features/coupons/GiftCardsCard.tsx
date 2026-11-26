// 礼品卡（8.1.40，docs/V8140.md 第 5 节）：先出卡、后绑手机号。一批礼品卡 = 一批匿名卡会员（会员号就是卡号），
// 生成以后导出卡号去印卡；送出去的在会员资料里「转实名」填手机号；要预存金额的按卡号照常充值。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { MAX_GIFT_CARD_BATCH, type GiftCardBatch } from '@shared/gift-cards';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { downloadUrl, formatDateTime, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { QtyInput } from '../../components/QtyInput';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Button, Card, Field, Input, Notice, SectionTitle, Skeleton } from '../../components/ui';

// 挂在 ['coupons'] 下面：发券页「结果待确认」查回以后刷新券的那一次（useInvalidateCoupons）连带刷新这一页
const key = ['coupons', 'gift-cards'] as const;

export function GiftCardsCard() {
  const q = useQuery({ queryKey: key, queryFn: () => api.get<GiftCardBatch[]>('/api/gift-cards') });
  const [creating, setCreating] = useState(false);
  // 上一次生成没收到结果：先在页面上方「结果待确认」里查回、重提或作废，处理好之前不再新开一批（Codex 审查 8a7023d）
  const pendingNew = useErpPending(['gift_card_batch']).length > 0;
  return (
    <Card className="space-y-3 p-4" data-testid="gift-cards">
      <SectionTitle
        aside={
          <Button
            size="sm"
            variant="primary"
            icon={<Plus className="size-3.5" />}
            onClick={() => setCreating(true)}
            disabled={pendingNew}
            title={pendingNew ? '上一次生成的结果待确认：先在页面上方查回、重提或作废' : undefined}
            data-testid="gift-cards-new"
          >
            生成一批
          </Button>
        }
      >
        礼品卡
      </SectionTitle>
      <p className="text-[12.5px] leading-relaxed text-ink-3">
        先出卡、后绑手机号：一张礼品卡就是一位匿名卡会员，会员号就是卡号。生成以后导出卡号去印卡；送出去以后在会员资料里「转实名」填客人的手机号；要预存金额的，按卡号照常充值。
      </p>
      {/* 取数中、取不到、真的没有分开写（合并前 Codex 审查 c79ca75）：没取到不说成「还没有生成过」 */}
      {q.error && q.data && <Notice tone="error" title={`刷新没成功，下面是之前取到的：${errorMessage(q.error)}`} />}
      {q.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="礼品卡批次没取到" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="gift-cards-failed">
          {errorMessage(q.error)}
        </LoadFailed>
      ) : (q.data ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">还没有生成过礼品卡</p>
      ) : (
        <ul className="divide-y divide-line/70 rounded-lg border border-line">
          {q.data!.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[13px]" data-testid={`gift-card-batch-${b.batchNo}`}>
              <span className="num font-bold">{b.batchNo}</span>
              <span className="font-semibold">{b.label}</span>
              <span className="text-ink-3">
                {b.quantity} 张 · 已绑手机号 {b.bound} 张 · 预存 <Money cents={b.principal} />
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-4">
                {formatDateTime(b.createdAt)} {b.createdByName}
                {b.note ? ` · ${b.note}` : ''}
              </span>
              <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => downloadUrl(`/api/gift-cards/${b.id}/cards.csv`)}>
                导出卡号
              </Button>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </Card>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [label, setLabel] = useState('礼品卡');
  const [n, setQty] = useState(10);
  /** 数量输入的提示（超过上限时夹到上限并说明，与别处的数量输入一样） */
  const [qtyHint, setQtyHint] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = label.trim().length >= 1 && Number.isInteger(n) && n >= 1 && n <= MAX_GIFT_CARD_BATCH;
  const submit = async () => {
    setBusy(true);
    setError(null);
    // 发出前把操作编号与原请求存在本机并读回核对（存不了就不发）：没收到结果时，关掉对话框、刷新以后也在页面上方「结果待确认」里，
    // 查回、按原内容重新提交（同一编号，不会多生成一批）或确认作废（与生成无记名券同一套，Codex 审查 8a7023d）
    const clientKey = uuid();
    try {
      const r = await sendErpOp<{ batch: GiftCardBatch }>({
        key: clientKey,
        type: 'gift_card_batch',
        url: '/api/gift-cards',
        body: { clientKey, label: label.trim(), quantity: n, note: note.trim() },
        summary: `${label.trim()} × ${n} 张`,
        staffName: session.staff.displayName,
      });
      void qc.invalidateQueries({ queryKey: key });
      toast({ tone: 'success', title: `已生成 ${r.batch.quantity} 张礼品卡（${r.batch.batchNo}）`, body: '导出卡号去印卡；送出去以后在会员资料里转实名、填手机号' });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({
          tone: 'info',
          title: '生成礼品卡：没收到结果',
          body: '可能已经生成，也可能没有。这笔记在页面上方「结果待确认」里（刷新、重新登录也在）：先查回；查不到就按原内容重新提交（不会多生成一批）或确认作废后再重新填写。',
        });
        onClose();
      } else setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: key });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title="生成一批礼品卡"
      description="不要手机号：一张卡就是一位匿名卡会员，会员号就是卡号。同一次提交断网重提只生成一批。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!ok} loading={busy} onClick={() => void submit()} data-testid="gift-cards-create">
            生成
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名称" htmlFor="gift-label" hint="会员资料里的姓名先写这个，转实名时改成客人的名字">
          <Input id="gift-label" value={label} maxLength={16} onChange={(e) => setLabel(e.target.value)} data-autofocus />
        </Field>
        <Field label="张数" hint={qtyHint ?? `一批最多 ${MAX_GIFT_CARD_BATCH} 张`}>
          {/* 共用的数量输入（docs/CONVENTIONS.md 第 4 节；合并前 Codex 审查 1c79c00）：超过上限夹到上限并提示 */}
          <QtyInput
            value={n}
            max={MAX_GIFT_CARD_BATCH}
            onChange={setQty}
            onHint={setQtyHint}
            label="张数"
            className="h-11 w-full rounded-md border border-line-strong bg-card text-[15px]"
            testId="gift-cards-qty"
          />
        </Field>
        <Field label="备注" htmlFor="gift-note" className="sm:col-span-2">
          <Input id="gift-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="例如 年会、合作单位采购" />
        </Field>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
