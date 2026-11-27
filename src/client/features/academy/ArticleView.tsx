// 汤崎学堂 · 图文互动课件的渲染（docs/ACADEMY.md 第 6 节）：员工端的课时页与后台编辑时的手机预览共用。
// 块照 Adapt Learning 的「块—组件」与 H5P 的翻牌卡、分支情景的做法：要点 / 注意 / 禁忌卡、步骤、记忆卡（点一下翻面）、
// 表格、情景（选一个做法看反馈）、课中小测（选完「核对」看对错与解析，不计分、不记录）。

import { useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleX, Lightbulb, OctagonAlert, RotateCw } from 'lucide-react';
import type { AcademyBlock, AcademyCalloutTone, AcademyQuestionDraft } from '@shared/academy-markup';
import { splitBold } from '@shared/academy-markup';
import { DataTable } from '../../components/DataTable';
import { Button } from '../../components/ui';
import { cn } from '../../lib/utils';

/** 正文里的 **加粗** */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {splitBold(text).map((s, i) =>
        s.bold ? (
          <strong key={i} className="font-bold text-ink">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

const TONE: Record<AcademyCalloutTone, { box: string; icon: ReactNode; label: string }> = {
  tip: { box: 'border-pine/25 bg-pine-tint', icon: <Lightbulb className="size-4 text-pine" aria-hidden />, label: '要点' },
  warn: { box: 'border-ember/30 bg-ember-soft', icon: <CircleAlert className="size-4 text-ember-deep" aria-hidden />, label: '注意' },
  ban: { box: 'border-clay/30 bg-clay-soft', icon: <OctagonAlert className="size-4 text-clay" aria-hidden />, label: '禁忌' },
};

function Cards({ title, cards }: { title: string; cards: { front: string; back: string }[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  return (
    <div data-testid="academy-block-cards">
      {title && <p className="mb-2 text-[14px] font-bold text-ink">{title}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {cards.map((c, i) => {
          const flipped = open.has(i);
          return (
            <button
              key={i}
              type="button"
              onClick={() => setOpen((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))}
              className={cn('tap relative min-h-20 rounded-lg border p-3 text-left transition-colors', flipped ? 'border-lake/30 bg-lake-soft' : 'border-line bg-card hover:bg-paper-2')}
              aria-pressed={flipped}
            >
              <span className="block text-[12px] font-semibold text-ink-4">{flipped ? '背面' : '点一下翻面'}</span>
              <span className={cn('mt-1 block text-[15px] leading-relaxed', flipped ? 'text-ink' : 'font-bold text-ink')}>
                <Rich text={flipped ? c.back : c.front} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Scenario({ title, situation, options }: { title: string; situation: string; options: { text: string; feedback: string; best: boolean }[] }) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className="rounded-lg border border-line bg-paper-2 p-4" data-testid="academy-block-scenario">
      <p className="text-[12px] font-bold text-lake">情景{title ? ` · ${title}` : ''}</p>
      <p className="mt-1 text-[15px] leading-relaxed text-ink">
        <Rich text={situation} />
      </p>
      <div className="mt-3 space-y-2">
        {options.map((o, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setPicked(i)}
            className={cn(
              'tap relative w-full rounded-md border px-3 py-2.5 text-left text-[14px] leading-relaxed transition-colors',
              picked === i ? (o.best ? 'border-pine bg-pine-soft' : 'border-clay bg-clay-soft') : 'border-line bg-card hover:bg-paper-3',
            )}
          >
            <Rich text={o.text} />
            {picked === i && (
              <span className={cn('mt-1.5 flex items-start gap-1.5 text-[13px]', o.best ? 'text-pine' : 'text-clay')}>
                {o.best ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />}
                <span>{o.feedback}</span>
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 选项作答（课中小测、测验、每日一练共用）：单选 / 判断点一个，多选可以点几个 */
export function ChoiceList({
  q,
  chosen,
  onChange,
  reveal,
  testId,
}: {
  q: Pick<AcademyQuestionDraft, 'kind' | 'options'> & { answer?: number[] };
  chosen: number[];
  onChange: (next: number[]) => void;
  /** 交了以后：标出对的、选错的 */
  reveal?: boolean;
  testId?: string;
}) {
  const multi = q.kind === 'multi';
  return (
    <div className="space-y-2" data-testid={testId} role={multi ? 'group' : 'radiogroup'}>
      {q.options.map((o, i) => {
        const on = chosen.includes(i);
        const right = reveal && q.answer?.includes(i);
        const wrong = reveal && on && !q.answer?.includes(i);
        return (
          <button
            key={i}
            type="button"
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={on}
            disabled={reveal}
            onClick={() => onChange(multi ? (on ? chosen.filter((x) => x !== i) : [...chosen, i].sort((a, b) => a - b)) : [i])}
            className={cn(
              'tap relative flex w-full items-start gap-2.5 rounded-md border px-3 py-2.5 text-left text-[15px] leading-relaxed transition-colors',
              right ? 'border-pine bg-pine-soft' : wrong ? 'border-clay bg-clay-soft' : on ? 'border-lake bg-lake-soft' : 'border-line bg-card hover:bg-paper-2',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center border text-[12px] font-bold',
                multi ? 'rounded-sm' : 'rounded-full',
                on ? 'border-lake bg-lake text-paper' : 'border-line-strong text-ink-4',
              )}
            >
              {String.fromCharCode(65 + i)}
            </span>
            <span className="min-w-0 flex-1">{o}</span>
            {right && <CircleCheck className="mt-0.5 size-4 shrink-0 text-pine" aria-label="正确答案" />}
            {wrong && <CircleX className="mt-0.5 size-4 shrink-0 text-clay" aria-label="选错了" />}
          </button>
        );
      })}
    </div>
  );
}

function Check({ q }: { q: AcademyQuestionDraft }) {
  const [chosen, setChosen] = useState<number[]>([]);
  const [shown, setShown] = useState(false);
  const right = shown && chosen.length === q.answer.length && chosen.every((c) => q.answer.includes(c));
  return (
    <div className="rounded-lg border border-yuzu/40 bg-yuzu-tint p-4" data-testid="academy-block-check">
      <p className="text-[12px] font-bold text-yuzu-deep">课中小测{q.kind === 'multi' ? ' · 多选' : ''}</p>
      <p className="mt-1 mb-3 text-[15px] leading-relaxed font-semibold text-ink">
        <Rich text={q.stem} />
      </p>
      <ChoiceList q={q} chosen={chosen} onChange={setChosen} reveal={shown} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!shown ? (
          <Button size="sm" variant="primary" disabled={!chosen.length} onClick={() => setShown(true)}>
            核对
          </Button>
        ) : (
          <>
            <span className={cn('text-[14px] font-bold', right ? 'text-pine' : 'text-clay')}>{right ? '答对了' : '再想想'}</span>
            <Button
              size="sm"
              icon={<RotateCw className="size-3.5" />}
              onClick={() => {
                setChosen([]);
                setShown(false);
              }}
            >
              重做
            </Button>
          </>
        )}
      </div>
      {shown && q.explanation && <p className="mt-2 text-[14px] leading-relaxed text-ink-2">解析：{q.explanation}</p>}
    </div>
  );
}

export function ArticleView({ blocks }: { blocks: AcademyBlock[] }) {
  return (
    <div className="space-y-4 text-[16px] leading-[1.8] text-ink-2" data-testid="academy-article">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading':
            return (
              <h3 key={i} className="pt-2 text-[18px] font-bold text-ink">
                {b.text}
              </h3>
            );
          case 'paragraph':
            return (
              <p key={i}>
                <Rich text={b.text} />
              </p>
            );
          case 'quote':
            return (
              <blockquote key={i} className="border-l-4 border-line-strong pl-3 text-ink-3">
                <Rich text={b.text} />
              </blockquote>
            );
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i} className={cn('space-y-1 pl-5', b.ordered ? 'list-decimal' : 'list-disc')}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Rich text={it} />
                  </li>
                ))}
              </Tag>
            );
          }
          case 'callout': {
            const t = TONE[b.tone];
            return (
              <div key={i} className={cn('rounded-lg border p-3.5', t.box)} data-testid={`academy-block-${b.tone}`}>
                <p className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
                  {t.icon}
                  {b.title || t.label}
                </p>
                <div className="mt-1.5 space-y-1 text-[15px]">
                  {b.lines.map((l, j) =>
                    l.bullet ? (
                      <p key={j} className="flex gap-2">
                        <span aria-hidden>·</span>
                        <span>
                          <Rich text={l.text} />
                        </span>
                      </p>
                    ) : (
                      <p key={j}>
                        <Rich text={l.text} />
                      </p>
                    ),
                  )}
                </div>
              </div>
            );
          }
          case 'steps':
            return (
              <div key={i} data-testid="academy-block-steps">
                {b.title && <p className="mb-2 text-[14px] font-bold text-ink">{b.title}</p>}
                <ol className="space-y-2">
                  {b.steps.map((s, j) => (
                    <li key={j} className="flex gap-3">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-pine text-[13px] font-bold text-paper">{j + 1}</span>
                      <span className="min-w-0 flex-1 pt-0.5">
                        <span className="font-bold text-ink">{s.title}</span>
                        {s.detail && <span className="block text-[15px] text-ink-3">{s.detail}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            );
          case 'cards':
            return <Cards key={i} title={b.title} cards={b.cards} />;
          case 'table':
            return (
              <div key={i}>
                {b.title && <p className="mb-2 text-[14px] font-bold text-ink">{b.title}</p>}
                <DataTable columns={b.head.map((h, c) => ({ key: String(c), header: h, cell: (r: string[]) => <Rich text={r[c] ?? ''} /> }))} rows={b.rows} rowKey={(_, r) => String(r)} />
              </div>
            );
          case 'scenario':
            return <Scenario key={i} title={b.title} situation={b.situation} options={b.options} />;
          case 'check':
            return <Check key={i} q={b.question} />;
          case 'question':
            return null;
        }
      })}
    </div>
  );
}
