// OA-07 后台「考勤设置 → 人脸审核」（docs/OA.md 第 10 节，hr.attendance）：待审核的一份份看 3 张照片，通过或退回（写原因）；
// 已通过的可以停用（写原因）。只列这家门店的员工。审核结果服务端发站内通知、记审计。
// 审核带操作编号、先记在本机再发（sendErpOp）：没收到结果的在页面上方查回、原样重提或确认作废，确认前不让再审核。
// 列表每页 50 份、可按姓名或登录名找（已通过的会越来越多，不能只看最近的）。

import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Undo2, X } from 'lucide-react';
import { FACE_PHOTO_LABELS, type FaceEnrollment, type FaceEnrollmentPage, type FaceReviewSaved } from '@shared/oa';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useReasons, useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Button, Card, Input, Notice, Segmented, Skeleton } from '../../components/ui';

type Tab = 'pending' | 'approved';
type Decision = 'approve' | 'reject' | 'revoke';

export function FaceReviewTab() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('pending');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['oa', 'face-enrollments', tab, term],
    queryFn: ({ pageParam }) => api.get<FaceEnrollmentPage>(`/api/oa/face/enrollments?status=${tab}${term ? `&q=${encodeURIComponent(term)}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [asking, setAsking] = useState<{ row: FaceEnrollment; decision: Exclude<Decision, 'approve'> } | null>(null);
  const { busy, decide, blocked } = useDecide();
  const rejectReasons = useReasons('faceRejectReasons');
  const revokeReasons = useReasons('faceRevokeReasons');
  return (
    <Card className="p-5" data-testid="att-faces">
      <ErpPendingPanel types={['oa_face_review']} className="mb-4 space-y-2" onFound={() => void qc.invalidateQueries({ queryKey: ['oa', 'face-enrollments'] })} />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          ariaLabel="人脸录入"
          options={[
            { value: 'pending', label: '待审核' },
            { value: 'approved', label: '已通过' },
          ]}
        />
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(search.trim());
          }}
        >
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="姓名或登录名" fullWidth={false} className="w-40" aria-label="找员工" data-testid="face-search" />
          <Button type="submit" variant="ghost" size="sm">
            找
          </Button>
        </form>
      </div>
      {blocked && (
        <Notice tone="warning" className="mt-3">
          上一次审核结果待确认：请先在上方查回、按原内容重新提交或作废，再审核。
        </Notice>
      )}
      <div className="mt-4">
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="人脸录入没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : rows.length === 0 ? (
          <EmptyState title={term ? '没有找到' : tab === 'pending' ? '没有待审核的人脸录入' : '还没有已通过的人脸录入'} />
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.id} className="rounded-lg border border-line p-4" data-testid={`face-row-${row.staffId}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p>
                    <span className="font-semibold text-ink">{row.staffName}</span>
                    <span className="ml-2 text-[13px] text-ink-3">提交于 {formatDateTime(row.submittedAt)}</span>
                    {row.reviewerName && <span className="ml-2 text-[13px] text-ink-3">· {row.reviewerName} 审核</span>}
                  </p>
                  <div className="flex gap-2">
                    {tab === 'pending' ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<X className="size-4" />}
                          disabled={busy}
                          onClick={() => setAsking({ row, decision: 'reject' })}
                          data-testid={`face-reject-${row.staffId}`}
                        >
                          退回
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          icon={<Check className="size-4" />}
                          loading={busy}
                          disabled={blocked}
                          onClick={() => void decide(row, 'approve')}
                          data-testid={`face-approve-${row.staffId}`}
                        >
                          通过
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Undo2 className="size-4" />}
                        disabled={busy}
                        onClick={() => setAsking({ row, decision: 'revoke' })}
                        data-testid={`face-revoke-${row.staffId}`}
                      >
                        停用
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-3 grid max-w-md grid-cols-3 gap-2">
                  {row.photos.map((p, i) => (
                    <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="block">
                      <img src={p.thumbUrl ?? p.url} alt={FACE_PHOTO_LABELS[i] ?? '人脸'} className="aspect-square w-full rounded-md object-cover" />
                      <span className="mt-1 block text-center text-[12px] text-ink-3">{FACE_PHOTO_LABELS[i] ?? ''}</span>
                    </a>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <Button variant="ghost" className="mt-3" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} data-testid="face-more">
            更早的
          </Button>
        )}
      </div>
      <ReasonDialog
        open={!!asking}
        title={asking ? `${asking.decision === 'revoke' ? '停用' : '退回'}${asking.row.staffName}的人脸录入` : ''}
        description={asking?.decision === 'revoke' ? '停用以后，考勤组要人脸的打不了卡，要重新录入、审核。' : '员工会收到通知，看到原因后重新录入。'}
        confirmLabel={asking?.decision === 'revoke' ? '停用' : '退回'}
        danger={asking?.decision === 'revoke'}
        busy={busy}
        reasons={asking?.decision === 'revoke' ? revokeReasons : rejectReasons}
        testId="face-note"
        onClose={() => setAsking(null)}
        onConfirm={async (note) => {
          if (asking && (await decide(asking.row, asking.decision, note))) setAsking(null);
        }}
      />
    </Card>
  );
}

function useDecide() {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const pending = useErpRecorded(['oa_face_review']);
  const [busy, setBusy] = useState(false);
  const decide = async (row: FaceEnrollment, decision: Decision, note?: string): Promise<boolean> => {
    if (pending.length) return false;
    setBusy(true);
    const verb = decision === 'approve' ? '通过' : decision === 'reject' ? '退回' : '停用';
    try {
      const key = uuid();
      await sendErpOp<FaceReviewSaved>({
        key,
        type: 'oa_face_review',
        url: `/api/oa/face/enrollments/${row.id}/review`,
        body: { clientKey: key, storeId: session.store.id, decision, ...(note ? { note } : {}) },
        summary: `${verb}${row.staffName}的人脸录入`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: `${row.staffName}的人脸录入已${verb}` });
      return true;
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '审核结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废。' });
        return true;
      }
      toast({ tone: 'error', title: e instanceof ErpPendingStoreError ? e.message : errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['oa', 'face-enrollments'] });
    }
  };
  return { busy, decide, blocked: pending.length > 0 };
}
