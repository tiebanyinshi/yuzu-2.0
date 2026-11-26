import { useEffect, useRef, useState } from 'react';
import { formatQty, parseQty } from '@shared/quantity';
import { cn } from '../lib/utils';

/**
 * 数量输入（店主 2026-11-14 的需求 1）：加减按钮中间的数可以直接点进去输，手机上弹数字键盘——
 * 把 1 改成 20 不用点 19 下加号。只收 min–max 的整数：
 *   · 输空了、输 0 先不动原来的数，离开输入框时回到原来的数并提示；
 *   · 超过上限按上限算并提示（上限可以是 99，也可以是今天还剩的份数）；
 *   · 带了小数点、负号、字母这些：整个不采用，数量回到点进来之前的数并提示，框里照样显示输的东西（标红），
 *     改成整数就采用、离开输入框就恢复。不能把这些字符删掉再算——「1.5」会变成 15、「-3」会变成 3，
 *     数量被悄悄改掉（测试会话 2026-11-14 在 5545835 上报的）。
 * 提示交给外面显示（onHint：有话说时给文字，输对了给 null）；数量的规矩（1–99、余量、服务端核对）都不变。
 */
export function QtyInput({
  value,
  min = 1,
  max = 99,
  onChange,
  onHint,
  label,
  disabled,
  className,
  testId,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
  onHint?: (text: string | null) => void;
  /** 读屏与用例用，例如「足疗 45 分钟 的数量」 */
  label: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  // 输到一半（空的、比下限小）时的草稿；别处改了数量（点加减）草稿作废
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  // 带了数字以外字符的那一串：只是显示着，不算数
  const [bad, setBad] = useState<string | null>(null);
  /** 点进输入框时的数量：输了不算数的东西就回到它 */
  const start = useRef(value);
  const range = `${min}–${max}`;
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      aria-label={label}
      aria-invalid={bad !== null}
      disabled={disabled}
      value={bad ?? draft ?? String(value)}
      onFocus={(e) => {
        start.current = value;
        e.target.select();
      }}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (/[^0-9]/.test(raw)) {
          // 之前清空过留下的空草稿一并作废：不然离开输入框时不算数的那一串清掉了，框里却还是空的
          //（先清空、再输字母、再移开，测试会话 2026-11-14 在 524a371 上报的）
          setDraft(null);
          setBad(raw.slice(0, 8));
          if (value !== start.current) onChange(start.current);
          onHint?.(`数量只能填 ${range} 的整数，「${raw.slice(0, 8)}」没有采用，仍按 ${start.current} 算`);
          return;
        }
        setBad(null);
        const text = raw.slice(0, 4);
        if (text === '') return setDraft('');
        const n = Number(text);
        if (n < min) return setDraft(text);
        setDraft(null);
        // 先改数、再给提示：外面改数的时候可能顺手把旧提示清掉，提示要留到最后
        if (n > max) {
          onChange(max);
          onHint?.(`数量最多 ${max}，已按 ${max} 算`);
          return;
        }
        onChange(n);
        onHint?.(null);
      }}
      onBlur={() => {
        // 不算数的那一串：离开就恢复成数量（提示留着，说明刚才那一串没有采用）
        if (bad !== null) {
          setBad(null);
          setDraft(null);
          return;
        }
        if (draft === null) return;
        setDraft(null);
        onHint?.(`数量请填 ${range} 的整数，已保留原来的 ${value}`);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={cn('num bg-transparent text-center font-bold outline-none focus:bg-yuzu-tint/60 disabled:opacity-60', bad !== null && 'text-clay', className)}
      data-testid={testId}
    />
  );
}

/**
 * 采购/物料数量输入（与 QtyInput 同一套交互与防误改约定，支持最多 3 位小数，内部全程整数 milli）：
 *   · 输空、0 或输入中的小数（如 "1."、"0.0"）先留在草稿里不动原值，失焦恢复并提示；
 *   · 超过 maxMilli 按 maxMilli 截断并给一致的超限提示；
 *   · 含非数字、多余小数点或超精度小数位：不采用，标红并回到焦点进入前的原值，失焦恢复。
 */
export function MilliQtyInput({
  id,
  valueMilli,
  minMilli = 1,
  maxMilli = 1_000_000_000,
  decimals = 3,
  onChange,
  onHint,
  label,
  disabled,
  className,
  testId,
}: {
  id?: string;
  valueMilli: number;
  minMilli?: number;
  maxMilli?: number;
  decimals?: 0 | 1 | 2 | 3;
  onChange: (nextMilli: number) => void;
  onHint?: (text: string | null) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const start = useRef(valueMilli);
  const lastCommitted = useRef(valueMilli);
  // 外部步进/一键达标改变 valueMilli 时清掉未提交草稿；自己刚提交的带尾零输入不强行打断
  useEffect(() => {
    if (valueMilli !== lastCommitted.current) {
      lastCommitted.current = valueMilli;
      setDraft(null);
      setBad(null);
    }
  }, [valueMilli]);

  const minLabel = formatQty(minMilli);
  const maxLabel = formatQty(maxMilli);
  const range = `${minLabel}–${maxLabel}`;
  const commit = (next: number, keepDraft: string | null) => {
    lastCommitted.current = next;
    setDraft(keepDraft);
    onChange(next);
  };

  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={bad !== null}
      disabled={disabled}
      value={bad ?? draft ?? formatQty(valueMilli)}
      onFocus={(e) => {
        start.current = valueMilli;
        e.target.select();
      }}
      onChange={(e) => {
        const raw = e.target.value.trim().replace(/[,，\s]/g, '');
        if (raw === '') {
          setBad(null);
          setDraft('');
          return;
        }
        const partialOk = decimals === 0 ? /^\d{1,9}$/.test(raw) : new RegExp(`^\\d{1,9}(?:\\.\\d{0,${decimals}})?$`).test(raw);
        if (!partialOk) {
          setDraft(null);
          const snippet = raw.slice(0, 14);
          setBad(snippet);
          if (valueMilli !== start.current) commit(start.current, null);
          onHint?.(`数量只能填 ${range}${decimals > 0 ? `（最多 ${decimals} 位小数）` : ' 的整数'}，「${snippet}」没有采用，仍按 ${formatQty(start.current)} 算`);
          return;
        }
        setBad(null);
        if (raw.endsWith('.')) {
          setDraft(raw);
          return;
        }
        const parsed = parseQty(raw, decimals);
        if (parsed === null || parsed < minMilli) {
          setDraft(raw);
          return;
        }
        if (parsed > maxMilli) {
          commit(maxMilli, null);
          onHint?.(`数量最多 ${maxLabel}，已按 ${maxLabel} 算`);
          return;
        }
        const keepDraft = raw.includes('.') && raw.endsWith('0') ? raw : null;
        commit(parsed, keepDraft);
        onHint?.(null);
      }}
      onBlur={() => {
        if (bad !== null) {
          setBad(null);
          setDraft(null);
          return;
        }
        if (draft === null) return;
        const parsed = draft.endsWith('.') ? parseQty(draft.slice(0, -1), decimals) : parseQty(draft, decimals);
        setDraft(null);
        if (parsed !== null && parsed >= minMilli) {
          if (parsed > maxMilli) {
            commit(maxMilli, null);
            onHint?.(`数量最多 ${maxLabel}，已按 ${maxLabel} 算`);
          } else {
            commit(parsed, null);
            onHint?.(null);
          }
          return;
        }
        onHint?.(`数量请填 ${range}${decimals > 0 ? `（最多 ${decimals} 位小数）` : ' 的整数'}，已保留原来的 ${formatQty(valueMilli)}`);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={cn(
        'num rounded-md border border-line-strong bg-card px-2.5 text-center font-bold text-ink outline-none transition-[border-color,box-shadow] focus:border-pine focus:shadow-[0_0_0_3px_rgb(36_73_58/0.12)] disabled:bg-paper-2 disabled:opacity-60',
        bad !== null && 'border-clay text-clay',
        className,
      )}
      data-testid={testId}
    />
  );
}
