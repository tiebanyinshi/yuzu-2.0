// 汤崎学堂 · 每日一练、我的、待我签核（docs/ACADEMY.md 第 5 节）：
//   · 每日一练：一题一张卡；客观题选完「交」看对错与解析；问答卡先自己想，点「看答案」再按记得的程度评 1–4（FSRS 据此排下次复习）；
//   · 我的：等级与学分、证书（过期 / 撤销标出来）、各知识点掌握度（薄弱的在前）、每日一练连续天数；
//   · 待我签核（带教）：本部门员工在学的实操，逐项打勾、写评语，签「通过」或「再练」。

import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, CheckCircle2, ClipboardCheck, Flame, Sparkles } from 'lucide-react';
import type { AcademyCoachItem, AcademyDailyAnswer, AcademyDailyItem } from '@shared/academy';
import { FSRS_GRADE_LABELS, MASTERY_STATUS_LABELS, type FsrsGrade } from '@shared/academy-algo';
import { api, ApiError, errorMessage } from '../../lib/api';
import { cn, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Skeleton, Textarea } from '../../components/ui';
import { ChoiceList } from './ArticleView';
import { academyKeys, minutesText, sendAcademyOp, useAcademyDaily, useAcademyMe, useAcademyRefresh } from './data';
import { AcademyFrame, AcademyOpsPanel, ProgressBar } from './parts';

/** onAnswered：记上了（顶上「今天做了几题」马上跟着变）；onDone：看完对错、点了「下一题」（问答卡评完就算） */
function DailyCard({ item, onAnswered, onDone }: { item: AcademyDailyItem; onAnswered: (a: AcademyDailyAnswer) => void; onDone: (a: AcademyDailyAnswer) => void }) {
  const [chosen, setChosen] = useState<number[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [answer, setAnswer] = useState<AcademyDailyAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => uuid());
  const toast = useToast();
  const qc = useQueryClient();
  const send = async (body: { choice?: number[]; grade?: FsrsGrade }) => {
    setBusy(true);
    try {
      const r = await sendAcademyOp<AcademyDailyAnswer>({
        key,
        method: 'POST',
        url: '/api/academy/daily/answer',
        body: { clientKey: key, questionId: item.questionId, version: item.version, ...body },
        summary: `每日一练「${item.stem.slice(0, 16)}」`,
      });
      setAnswer(r);
      onAnswered(r);
      if (item.kind === 'recall') onDone(r);
    } catch (e) {
      toast({ tone: 'error', title: '没记上', body: errorMessage(e) });
      // 题刚被改过、今天已经练过：重新取今天的题，不卡在这一题上
      if (e instanceof ApiError && (e.code === 'ACADEMY_CHANGED' || e.code === 'ACADEMY_DAILY_GONE')) void qc.invalidateQueries({ queryKey: academyKeys.daily });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-4" data-testid="academy-daily-card">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={item.isNew ? 'lake' : 'yuzu'}>{item.isNew ? '新题' : '复习'}</Badge>
        <span className="truncate text-[12px] text-ink-3">
          {item.courseTitle} · {item.skill}
        </span>
      </div>
      <p className="text-[16px] leading-relaxed font-semibold text-ink">{item.stem}</p>
      {item.kind === 'recall' ? (
        revealed ? (
          <>
            <div className="rounded-md bg-pine-tint p-3 text-[15px] leading-relaxed text-ink" data-testid="academy-daily-answer">
              {item.answerText}
            </div>
            <p className="text-[13px] text-ink-3">刚才想得起来吗？</p>
            <div className="grid grid-cols-4 gap-2">
              {([1, 2, 3, 4] as FsrsGrade[]).map((g) => (
                <Button
                  key={g}
                  size="sm"
                  variant={g === 1 ? 'danger' : g === 3 ? 'primary' : 'secondary'}
                  loading={busy}
                  onClick={() => void send({ grade: g })}
                  data-testid={`academy-daily-grade-${g}`}
                >
                  {FSRS_GRADE_LABELS[g]}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <Button className="w-full" onClick={() => setRevealed(true)} data-testid="academy-daily-reveal">
            看答案
          </Button>
        )
      ) : (
        <>
          <ChoiceList q={{ kind: item.kind, options: item.options, answer: answer?.answer }} chosen={chosen} onChange={setChosen} reveal={!!answer} testId="academy-daily-choices" />
          {answer ? (
            <>
              <p className={cn('text-[15px] font-bold', answer.correct ? 'text-pine' : 'text-clay')}>{answer.correct ? '答对了' : '答错了，明天再练一次'}</p>
              {answer.explanation && <p className="text-[14px] text-ink-2">解析：{answer.explanation}</p>}
              <Button variant="primary" className="w-full" onClick={() => onDone(answer)} data-testid="academy-daily-next">
                下一题
              </Button>
            </>
          ) : (
            <Button variant="primary" className="w-full" disabled={!chosen.length} loading={busy} onClick={() => void send({ choice: chosen })} data-testid="academy-daily-submit">
              提交
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

export function DailyPage() {
  const daily = useAcademyDaily();
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<AcademyDailyAnswer | null>(null);
  const qc = useQueryClient();
  const refresh = useAcademyRefresh();
  const d = daily.data;
  const item = d?.items[index];
  return (
    <AcademyFrame title="每日一练" back={{ to: '/oa/academy', label: '学堂' }} testId="academy-daily">
      <AcademyOpsPanel />
      {daily.isError && !d ? (
        <LoadFailed title="今天的题没有取回来" onRetry={() => void daily.refetch()} />
      ) : !d ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <Card className="flex items-center gap-3 p-4">
            <Flame className="size-8 shrink-0 text-ember" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-bold text-ink">连续 {d.streak} 天</p>
              <p className="text-[12px] text-ink-3">每天 {d.target} 题，到期该复习的先出（按你记忆的快慢排），练完得 1 学分</p>
            </div>
            <span className="text-[16px] font-bold text-ink tabular-nums" data-testid="academy-daily-count">
              {done?.doneToday ?? d.doneToday}/{d.target}
            </span>
          </Card>
          {item ? (
            <DailyCard
              key={item.questionId}
              item={item}
              onAnswered={setDone}
              onDone={() => {
                if (index + 1 < d.items.length) setIndex(index + 1);
                else {
                  setIndex(0);
                  void qc.invalidateQueries({ queryKey: academyKeys.daily });
                  void refresh();
                }
              }}
            />
          ) : (
            <EmptyState
              title={d.credited ? '今天的练完了' : '今天没有要练的题'}
              description={d.credited ? '明天再来，记得更牢' : '先去学一门课，学过的课的题会出现在这里'}
              art="calm"
              testId="academy-daily-empty"
            />
          )}
        </>
      )}
    </AcademyFrame>
  );
}

export function MePage() {
  const me = useAcademyMe();
  const m = me.data;
  return (
    <AcademyFrame title="证书与成长" back={{ to: '/oa/academy', label: '学堂' }} testId="academy-me">
      {me.isError && !m ? (
        <LoadFailed title="没有取回来" onRetry={() => void me.refetch()} />
      ) : !m ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <Card className="p-4">
            <p className="text-[16px] font-bold text-ink">{m.me.name}</p>
            <p className="text-[13px] text-ink-3">{[m.me.storeName, m.me.departmentName, m.me.positionTitle].filter(Boolean).join(' · ')}</p>
            <div className="mt-3 flex items-center gap-2">
              <Badge tone="yuzu">{`LV${m.me.level.level} ${m.me.level.title}`}</Badge>
              <span className="text-[13px] text-ink-3">
                {m.me.credits} 学分 · 累计学习 {minutesText(m.me.seconds)} · 每日一练连续 {m.streak} 天
              </span>
            </div>
            {m.me.nextLevel && <ProgressBar className="mt-2" tone="yuzu" done={m.me.credits - m.me.level.min} total={m.me.nextLevel.min - m.me.level.min} />}
          </Card>
          {m.canCoach && (
            <Link to="/oa/academy/coach" className="mo-lift flex items-center gap-3 rounded-lg border border-line bg-card p-3.5" data-testid="academy-coach-link">
              <ClipboardCheck className="size-6 text-lake" aria-hidden />
              <span className="flex-1 text-[15px] font-bold text-ink">待我签核的实操</span>
            </Link>
          )}
          <section className="space-y-2" data-testid="academy-certs">
            <h2 className="flex items-center gap-1.5 text-[16px] font-bold text-ink">
              <Award className="size-4 text-ember" aria-hidden />
              我的证书
            </h2>
            {m.certificates.length ? (
              m.certificates.map((c) => (
                <Card key={c.id} className={cn('flex items-center gap-3 p-3.5', (c.revoked || c.expired) && 'opacity-60')}>
                  <Award className="size-8 shrink-0 text-yuzu-deep" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-bold text-ink">{c.title}</p>
                    <p className="text-[12px] text-ink-3">
                      {c.certNo} · {c.issuedOn} 颁发{c.expiresOn ? ` · ${c.expiresOn} 到期` : ' · 长期有效'}
                    </p>
                  </div>
                  {c.revoked ? <Badge tone="clay">已撤销</Badge> : c.expired ? <Badge tone="ember">已过期</Badge> : <Badge tone="pine">有效</Badge>}
                </Card>
              ))
            ) : (
              <p className="text-[13px] text-ink-4">学完一张学习地图就发证书。</p>
            )}
          </section>
          <section className="space-y-2" data-testid="academy-mastery">
            <h2 className="flex items-center gap-1.5 text-[16px] font-bold text-ink">
              <Sparkles className="size-4 text-lake" aria-hidden />
              知识点掌握度
            </h2>
            {m.mastery.length ? (
              <Card className="divide-y divide-line">
                {m.mastery.map((x) => (
                  <div key={x.skill} className="flex items-center gap-3 px-3.5 py-2.5">
                    <span className="w-28 shrink-0 truncate text-[14px] font-semibold text-ink">{x.skill}</span>
                    <ProgressBar className="flex-1" done={Math.round(x.pKnown * 100)} total={100} tone={x.status === 'weak' ? 'yuzu' : x.status === 'mastered' ? 'pine' : 'lake'} />
                    <Badge tone={x.status === 'weak' ? 'clay' : x.status === 'mastered' ? 'pine' : 'lake'}>{MASTERY_STATUS_LABELS[x.status]}</Badge>
                  </div>
                ))}
              </Card>
            ) : (
              <p className="text-[13px] text-ink-4">做过测验、每日一练以后，这里会按知识点算出你掌握得怎么样。</p>
            )}
          </section>
        </>
      )}
    </AcademyFrame>
  );
}

function SignDialog({ item, onClose }: { item: AcademyCoachItem; onClose: () => void }) {
  const [checks, setChecks] = useState<boolean[]>(item.items.map(() => false));
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => uuid());
  const toast = useToast();
  const qc = useQueryClient();
  const sign = async (result: 'pass' | 'retry') => {
    setBusy(true);
    try {
      await sendAcademyOp({
        key,
        method: 'POST',
        url: '/api/academy/signoffs',
        body: { clientKey: key, staffId: item.staffId, lessonId: item.lessonId, lessonVersion: item.lessonVersion, checks, result, comment },
        summary: `给 ${item.name} 签实操「${item.lessonTitle}」`,
      });
      toast({ tone: 'success', title: result === 'pass' ? `${item.name} 的实操签了通过` : '记下了「再练」' });
      await qc.invalidateQueries({ queryKey: academyKeys.coach });
      onClose();
    } catch (e) {
      toast({ tone: 'error', title: '没签上', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${item.name} · ${item.lessonTitle}`}
      footer={
        <>
          <Button variant="secondary" loading={busy} onClick={() => void sign('retry')} data-testid="academy-sign-retry">
            再练
          </Button>
          <Button variant="primary" loading={busy} disabled={checks.some((c) => !c)} onClick={() => void sign('pass')} data-testid="academy-sign-pass">
            通过
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[13px] text-ink-3">在岗看过一遍，逐项打勾；全部达标才能签「通过」。</p>
      <div className="space-y-1.5">
        {item.items.map((it, i) => (
          <label key={i} className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line p-2.5 text-[15px]">
            <input type="checkbox" className="mt-1 size-4" checked={checks[i]} onChange={(e) => setChecks((c) => c.map((x, j) => (j === i ? e.target.checked : x)))} />
            <span>{it}</span>
          </label>
        ))}
      </div>
      <Textarea className="mt-3" rows={2} maxLength={300} placeholder="评语（选填）：哪里好、哪里要再练" value={comment} onChange={(e) => setComment(e.target.value)} />
    </Dialog>
  );
}

export function CoachPage() {
  const queue = useQuery({ queryKey: academyKeys.coach, queryFn: () => api.get<AcademyCoachItem[]>('/api/academy/coach') });
  const [open, setOpen] = useState<AcademyCoachItem | null>(null);
  return (
    <AcademyFrame title="待我签核" back={{ to: '/oa/academy/me', label: '我的' }} testId="academy-coach">
      <AcademyOpsPanel />
      {queue.isError && !queue.data ? (
        <LoadFailed title="没有取回来" onRetry={() => void queue.refetch()}>
          {errorMessage(queue.error)}
        </LoadFailed>
      ) : !queue.data ? (
        <Skeleton className="h-40" />
      ) : queue.data.length ? (
        <div className="space-y-2">
          {queue.data.map((x) => (
            <button
              key={`${x.staffId}-${x.lessonId}`}
              type="button"
              onClick={() => setOpen(x)}
              className="mo-lift flex w-full items-center gap-3 rounded-lg border border-line bg-card p-3.5 text-left"
              data-testid={`academy-coach-${x.staffId}-${x.lessonId}`}
            >
              <CheckCircle2 className="size-6 shrink-0 text-ink-4" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-bold text-ink">
                  {x.name} · {x.lessonTitle}
                </p>
                <p className="truncate text-[12px] text-ink-3">
                  {x.courseTitle}
                  {x.departmentName ? ` · ${x.departmentName}` : ''}
                </p>
              </div>
              {x.last && <Badge tone={x.last.result === 'retry' ? 'ember' : 'pine'}>{x.last.result === 'retry' ? '上次：再练' : '通过'}</Badge>}
            </button>
          ))}
        </div>
      ) : (
        <EmptyState title="现在没有要签的实操" description="本部门同事学到实操课时以后会出现在这里" art="calm" />
      )}
      {open && <SignDialog item={open} onClose={() => setOpen(null)} />}
    </AcademyFrame>
  );
}
