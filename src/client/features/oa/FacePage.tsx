// OA-07 员工「办公 → 人脸录入」（docs/OA.md 第 10 节）：拍 3 张不同角度的正脸照（正面、稍向左、稍向右），交人事审核。
// 状态：没录、待审核、已通过、被退回（写了原因，可以重新提交）。已通过的再提交一份新的：新的通过以前照旧用旧的。
// 提交带操作编号、先记在本机再发（sendErpOp）；没收到结果的在页面上方查回、原样重提或作废，确认前不让再提交。只看本人的。

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, ScanFace } from 'lucide-react';
import { FACE_PHOTO_COUNT, FACE_PHOTO_LABELS, FACE_STATUS_LABELS, type FaceEnrollSaved, type MyFace } from '@shared/oa';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, Skeleton } from '../../components/ui';
import { uploadPhoto } from './oaImage';

const FACE_KEY = ['oa', 'my-face'] as const;
type Shot = { file: File; preview: string };

export function FacePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const q = useQuery({ queryKey: FACE_KEY, queryFn: () => api.get<MyFace>('/api/oa/face/me') });
  const mine = (op: { staffId?: number }) => op.staffId === session.staff.id;
  const pending = useErpRecorded(['oa_face_enroll']).filter(mine);
  const [shots, setShots] = useState<(Shot | null)[]>(() => Array.from({ length: FACE_PHOTO_COUNT }, () => null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  // 换掉、离开页面时放掉预览
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const setShot = (i: number, file: File) => {
    const preview = URL.createObjectURL(file);
    previews.current.push(preview);
    setShots((s) => s.map((x, k) => (k === i ? { file, preview } : x)));
  };
  const ready = shots.every(Boolean);

  const submit = async () => {
    if (pending.length) {
      setError('上一次提交结果待确认：请先在页面上方查回、按原内容重新提交或作废');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const photoIds: number[] = [];
      for (const [i, s] of shots.entries()) photoIds.push((await uploadPhoto(s!.file, `人脸-${FACE_PHOTO_LABELS[i]}.jpg`)).id);
      const key = uuid();
      await sendErpOp<FaceEnrollSaved>({
        key,
        type: 'oa_face_enroll',
        url: '/api/oa/face/enroll',
        body: { clientKey: key, photoIds },
        summary: '人脸录入（3 张）',
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: '已提交，等人事审核' });
      setShots(shots.map(() => null));
      void qc.invalidateQueries({ queryKey: FACE_KEY });
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'info', title: '提交结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废。' });
      else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const data = q.data;
  const canSubmit = data && data.latest?.status !== 'pending';
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="人脸录入" subtitle="考勤组要人脸的，人脸录入通过审核以后才能打卡" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:space-y-4 md:p-7">
        <h1 className="text-[17px] font-bold text-ink md:hidden">人脸录入</h1>
        <ErpPendingPanel types={['oa_face_enroll']} filter={mine} className="space-y-2" onFound={() => void qc.invalidateQueries({ queryKey: FACE_KEY })} />
        {q.isPending ? (
          <Skeleton className="h-60" />
        ) : q.isError && !data ? (
          <LoadFailed title="人脸录入没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <>
            <Card className="p-5" data-testid="face-status">
              <div className="flex flex-wrap items-center gap-2">
                <ScanFace className="size-5 text-pine" />
                <span className="font-semibold text-ink">现在：</span>
                {data!.status === 'approved' ? (
                  <Badge tone="pine">已通过</Badge>
                ) : data!.status === 'pending' ? (
                  <Badge tone="yuzu">待审核</Badge>
                ) : data!.status === 'rejected' ? (
                  <Badge tone="clay">被退回</Badge>
                ) : (
                  <Badge tone="neutral">还没录</Badge>
                )}
              </div>
              {data!.latest?.status === 'rejected' && data!.latest.reviewNote && <p className="mt-2 text-[13px] text-clay">退回原因：{data!.latest.reviewNote}</p>}
              {data!.approved && data!.latest && data!.latest.id !== data!.approved.id && data!.latest.status === 'pending' && (
                <p className="mt-2 text-[13px] text-ink-3">新提交的一份{FACE_STATUS_LABELS[data!.latest.status]}；通过以前打卡照旧用已通过的那份。</p>
              )}
            </Card>
            {canSubmit ? (
              <Card className="space-y-4 p-5" data-testid="face-form">
                <p className="text-[13px] text-ink-3">
                  光线充足、不戴帽子口罩，各拍一张：{FACE_PHOTO_LABELS.join('、')}。{data!.status === 'approved' ? '再交一份新的，通过以后替换现在的。' : ''}
                </p>
                <div className="grid grid-cols-3 gap-3">
                  {shots.map((s, i) => (
                    <div key={i} className="flex flex-col items-center gap-2">
                      <button
                        type="button"
                        onClick={() => inputs.current[i]?.click()}
                        className="tap relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-dashed border-line-strong bg-paper"
                        data-testid={`face-shot-${i}`}
                      >
                        {s ? <img src={s.preview} alt={FACE_PHOTO_LABELS[i]} className="size-full object-cover" /> : <Camera className="size-7 text-ink-4" />}
                      </button>
                      <span className="text-[13px] text-ink-2">{FACE_PHOTO_LABELS[i]}</span>
                      <input
                        ref={(el) => {
                          inputs.current[i] = el;
                        }}
                        type="file"
                        accept="image/*"
                        capture="user"
                        className="hidden"
                        data-testid={`face-input-${i}`}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) setShot(i, f);
                        }}
                      />
                    </div>
                  ))}
                </div>
                {error && (
                  <Notice tone="error" data-testid="face-error">
                    {error}
                  </Notice>
                )}
                <div className="flex justify-end">
                  <Button variant="primary" loading={busy} disabled={busy || !ready} onClick={() => void submit()} data-testid="face-submit">
                    提交审核
                  </Button>
                </div>
              </Card>
            ) : (
              <Card className="p-5 text-[13px] text-ink-3">已经提交了一份，等人事审核完再提交新的。</Card>
            )}
          </>
        )}
      </div>
    </>
  );
}
