// OA-07 后台「考勤设置 → 人脸审核」（docs/OA.md 第 10 节，hr.attendance）：待审核的一份份看 3 张照片，通过或退回（写原因）；
// 已通过的可以停用（写原因）。只列这家门店的员工。审核结果服务端发站内通知、记审计。
// 再点一次同样的决定照常成功（已经是那个状态）；别人先处理过的提示刷新。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Undo2, X } from 'lucide-react';
import { FACE_NOTE_MAX, FACE_PHOTO_LABELS, type FaceEnrollment } from '@shared/oa';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Notice, Segmented, Skeleton, Textarea } from '../../components/ui';

type Tab = 'pending' | 'approved';
type Decision = 'approve' | 'reject' | 'revoke';

export function FaceReviewTab() {
  const [tab, setTab] = useState<Tab>('pending');
  const q = useQuery({ queryKey: ['oa', 'face-enrollments', tab], queryFn: () => api.get<FaceEnrollment[]>(`/api/oa/face/enrollments?status=${tab}`) });
  const [asking, setAsking] = useState<{ row: FaceEnrollment; decision: Exclude<Decision, 'approve'> } | null>(null);
  const { busy, decide } = useDecide();
  return (
    <Card className="p-5" data-testid="att-faces">
      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        ariaLabel="人脸录入"
        options={[
          { value: 'pending', label: '待审核' },
          { value: 'approved', label: '已通过' },
        ]}
      />
      <div className="mt-4">
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="人脸录入没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : q.data!.length === 0 ? (
          <EmptyState title={tab === 'pending' ? '没有待审核的人脸录入' : '还没有已通过的人脸录入'} />
        ) : (
          <ul className="space-y-3">
            {q.data!.map((row) => (
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
                        <Button size="sm" variant="primary" icon={<Check className="size-4" />} loading={busy} onClick={() => void decide(row, 'approve')} data-testid={`face-approve-${row.staffId}`}>
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
      </div>
      <NoteDialog
        target={asking}
        busy={busy}
        onClose={() => setAsking(null)}
        onDone={async (note) => {
          if (asking && (await decide(asking.row, asking.decision, note))) setAsking(null);
        }}
      />
    </Card>
  );
}

function useDecide() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const decide = async (row: FaceEnrollment, decision: Decision, note?: string): Promise<boolean> => {
    setBusy(true);
    try {
      await api.post<FaceEnrollment>(`/api/oa/face/enrollments/${row.id}/review`, { decision, ...(note ? { note } : {}) });
      toast({ tone: 'success', title: `${row.staffName}的人脸录入${decision === 'approve' ? '已通过' : decision === 'reject' ? '已退回' : '已停用'}` });
      return true;
    } catch (e) {
      // 结果不确定的重新载入核对（再点一次同样的决定照常成功）
      toast({ tone: e instanceof UncertainError ? 'info' : 'error', title: errorMessage(e), body: e instanceof UncertainError ? '已重新载入，请核对是不是已经处理好' : undefined });
      return e instanceof UncertainError;
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['oa', 'face-enrollments'] });
    }
  };
  return { busy, decide };
}

function NoteDialog({ target, busy, onClose, onDone }: { target: { row: FaceEnrollment; decision: 'reject' | 'revoke' } | null; busy: boolean; onClose: () => void; onDone: (note: string) => void }) {
  const [note, setNote] = useState('');
  const verb = target?.decision === 'revoke' ? '停用' : '退回';
  return (
    <Dialog
      open={!!target}
      onClose={() => {
        setNote('');
        onClose();
      }}
      title={target ? `${verb}${target.row.staffName}的人脸录入` : ''}
      description={target?.decision === 'revoke' ? '停用以后，考勤组要人脸的打不了卡，要重新录入、审核。' : '员工会收到通知，看到原因后重新录入。'}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={busy} disabled={!note.trim()} onClick={() => onDone(note.trim())} data-testid="face-note-done">
            {verb}
          </Button>
        </>
      }
    >
      <Field label="原因" htmlFor="face-note">
        <Textarea id="face-note" rows={2} maxLength={FACE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} data-testid="face-note" />
      </Field>
      {target?.decision === 'revoke' && (
        <Notice tone="warning" className="mt-3">
          停用后这位员工要重新录入。
        </Notice>
      )}
    </Dialog>
  );
}
