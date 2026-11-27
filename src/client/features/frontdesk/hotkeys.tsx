// 发卡台、收银台的一键快捷键（8.2.1，docs/V8221_CASHIER.md 第 2 节；会议纪要「收银系统功能评审」一）。
//
// 原来的问题（店里说「要先把鼠标移到按钮上才行」）：
//   · 两个台各自在 window 上听 keydown，只有 F2 / F4 / F6 / F8 / F9 几个键；买单以外的打单、充卡、组合拆分、备注都没有键，只能移鼠标去点；
//   · 没打开手牌时按了什么也不发生，有对话框开着时也什么都不发生——不提示，店员以为键坏了，只好去点按钮；
//   · 别的页面元素（例如账单里的输入框、读卡器的牌号框）先吃掉按键时 window 上的冒泡监听收不到。
// 现在：
//   · 一张表管两个台的键（DESK_HOTKEYS），按钮上写键位，按「?」或「快捷键」看一览；
//   · 在捕获阶段听（先于页面里的输入框），只认 F 键（打字时不会误触），「?」在输入框里不算；
//   · 没打开手牌时先弹「选手牌」（刷牌或输牌号，回车），选好了接着做；有对话框开着时提示先关掉，不再无声无息。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Link2, LogOut } from 'lucide-react';
import { matchTags, normalizeTagCode, uniqueTagMatch, type BoardTag, type VisitDetail } from '@shared/frontdesk';
import { api, errorMessage } from '../../lib/api';
import { composing, dialogFkeyButton, openDialog } from '../../lib/keymap';
import { isTypingTarget } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Kbd, Notice } from '../../components/ui';
import type { Desk } from './BillPanel';
import { InStoreTagInput, JoinGroupDialog } from './VisitDialogs';

export type DeskAction = 'recharge' | 'checkin' | 'remark' | 'add' | 'buy' | 'group' | 'preview' | 'checkout' | 'print';

/** 两个台的快捷键：F1–F10（F5 是浏览器刷新，不占）。needsVisit：要先有打开的手牌，没有时先选手牌 */
export const DESK_HOTKEYS: readonly { key: string; action: DeskAction; label: string; desks: readonly Desk[]; needsVisit: boolean }[] = [
  { key: 'F1', action: 'recharge', label: '充卡（会员充值）', desks: ['issue', 'cashier'], needsVisit: true },
  { key: 'F2', action: 'checkin', label: '接待发牌', desks: ['issue'], needsVisit: false },
  { key: 'F3', action: 'remark', label: '备注', desks: ['issue', 'cashier'], needsVisit: true },
  { key: 'F4', action: 'add', label: '加项目', desks: ['cashier'], needsVisit: true },
  { key: 'F6', action: 'buy', label: '买角（敲数字代号）', desks: ['cashier'], needsVisit: true },
  { key: 'F7', action: 'group', label: '组合 / 拆分同行手牌', desks: ['issue', 'cashier'], needsVisit: true },
  { key: 'F8', action: 'preview', label: '预结账', desks: ['cashier'], needsVisit: true },
  { key: 'F9', action: 'checkout', label: '买单（结账）', desks: ['issue', 'cashier'], needsVisit: true },
  { key: 'F10', action: 'print', label: '打单（打预结单）', desks: ['issue', 'cashier'], needsVisit: true },
];

/** 按钮上写的键位 */
export const hotkeyOf = (action: DeskAction) => DESK_HOTKEYS.find((h) => h.action === action)?.key;

/** 打单（8.1.44）：这位客人与同组在店的手牌一起打一张预结单，新窗口打开、读到数据自动调出打印；被浏览器拦下返回 false */
export function openPrebill(visit: VisitDetail): boolean {
  const mates = visit.group?.mates.filter((m) => m.status === 'open').map((m) => m.visitId) ?? [];
  const ids = mates.length ? mates : [visit.id];
  return !!window.open(`/print/prebill/${ids.join(',')}?auto=1`, '_blank', 'popup,width=420,height=760');
}

/** 备注：把光标放进账单里的备注框 */
export function focusRemark(): boolean {
  const el = document.querySelector<HTMLTextAreaElement>('[data-testid="remark-note"]');
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus();
  return true;
}

/**
 * 接上一个台的快捷键。perform 在手牌已经打开（visit 已取到）时调用；没打开时先弹选手牌，选好、取到以后再调用。
 * allowed 返回 false 的动作（岗位没有权限）提示一句、不做。返回要放进页面的弹窗（选手牌、一览）
 */
export function useDeskHotkeys(o: {
  desk: Desk;
  tags: BoardTag[];
  /** 已经取到的那位客人（打开的手牌）；没有为 null */
  visit: VisitDetail | null;
  onSelect: (visitId: number) => void;
  perform: (action: DeskAction, visit: VisitDetail | null) => void;
  allowed: (action: DeskAction) => boolean;
}): { node: ReactNode; trigger: (action: DeskAction) => void; openHelp: () => void } {
  const toast = useToast();
  const [picking, setPicking] = useState<DeskAction | null>(null);
  const [queued, setQueued] = useState<{ action: DeskAction; visitId: number } | null>(null);
  const [help, setHelp] = useState(false);
  const latest = useRef(o);
  latest.current = o;

  const trigger = useCallback(
    (action: DeskAction) => {
      const { visit, allowed, perform } = latest.current;
      const def = DESK_HOTKEYS.find((h) => h.action === action)!;
      if (!allowed(action)) {
        toast({ tone: 'error', title: `当前岗位不能${def.label}` });
        return;
      }
      if (!def.needsVisit) return perform(action, visit);
      if (visit && visit.status === 'open') return perform(action, visit);
      setPicking(action);
    },
    [toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || composing(e)) return;
      const def = DESK_HOTKEYS.find((h) => h.key === e.key && h.desks.includes(latest.current.desk));
      const wantsHelp = e.key === '?' && !isTypingTarget(e.target);
      const open = openDialog();
      // 8.2.12：对话框里写了这个 F 键的按钮（买单对话框的「确认结清」= F9）就点它
      const inDialog = open && /^F([1-9]|1[0-2])$/.test(e.key) ? dialogFkeyButton(open, e.key) : null;
      if (inDialog) {
        e.preventDefault();
        e.stopPropagation();
        inDialog.click();
        return;
      }
      // 8.2.12：不在输入框、没有对话框时按 ↓ / ↑ 进到账单明细（第一行 / 最后一行），再用 ↑↓、Del、/ 操作
      if (!open && !isTypingTarget(e.target) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const rows = [...document.querySelectorAll<HTMLElement>('[data-line-row]')];
        if (rows.length && !rows.includes(document.activeElement as HTMLElement)) {
          e.preventDefault();
          rows[e.key === 'ArrowDown' ? 0 : rows.length - 1]!.focus();
        }
        return;
      }
      if (!def && !wantsHelp) return;
      if (open) {
        // 弹窗里不再叠一个：F 键提示先关掉；「?」交给弹窗自己（可能在输入）
        if (def) {
          e.preventDefault();
          toast({ tone: 'info', title: `先关掉现在的对话框（Esc），再按 ${def.key} ${def.label}` });
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (wantsHelp) setHelp(true);
      else trigger(def!.action);
    };
    // 捕获阶段：先于页面里的输入框、读卡器的牌号框（它们会吃掉回车等按键）
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toast, trigger]);

  // 选好手牌、取到这位客人以后接着做
  useEffect(() => {
    if (!queued || !o.visit || o.visit.id !== queued.visitId) return;
    setQueued(null);
    o.perform(queued.action, o.visit);
  }, [queued, o]);

  const node = (
    <>
      <PickTagDialog
        open={picking !== null}
        action={picking}
        tags={o.tags}
        onClose={() => setPicking(null)}
        onPick={(visitId) => {
          const action = picking!;
          setPicking(null);
          o.onSelect(visitId);
          setQueued({ action, visitId });
        }}
      />
      <HotkeyHelpDialog open={help} desk={o.desk} onClose={() => setHelp(false)} />
    </>
  );
  return { node, trigger, openHelp: () => setHelp(true) };
}

/** 没打开手牌时按了快捷键：先选手牌（刷牌或输牌号，回车），再接着做 */
function PickTagDialog({ open, action, tags, onClose, onPick }: { open: boolean; action: DeskAction | null; tags: BoardTag[]; onClose: () => void; onPick: (visitId: number) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCode('');
      setError(null);
    }
  }, [open]);
  const inStore = useMemo(() => tags.filter((t) => t.visit), [tags]);
  const c = normalizeTagCode(code);
  const unique = c ? uniqueTagMatch(inStore, c) : null;
  const candidates = c && !unique ? matchTags(inStore, c).slice(0, 12) : [];
  const def = DESK_HOTKEYS.find((h) => h.action === action);
  const go = (t: BoardTag | null | undefined) => {
    if (!t?.visit) {
      setError(c ? `手牌 ${c} 现在没有在店的客人` : '请刷牌或输入牌号');
      return;
    }
    onPick(t.visit.id);
  };
  return (
    <Dialog open={open} onClose={onClose} title={`选手牌 · 再${def?.label ?? ''}`} description="刷手牌，或输入牌号（末位即可）回车；选好了接着做，不用再按一次">
      <div data-testid="hotkey-pick-tag">
        <InStoreTagInput
          value={code}
          onChange={(v) => {
            setCode(v);
            setError(null);
          }}
          onCard={(found) => found.visit && onPick(found.visit.id)}
          onEnter={(e) => {
            e.preventDefault();
            go(unique);
          }}
          autoFocus
          placeholder="牌号"
          ariaLabel="选手牌"
          inputClassName="num text-[20px] font-bold"
          testId="hotkey-pick-input"
        />
        {candidates.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {candidates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => go(t)}
                className="tap relative num h-8 rounded-full border border-line bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-pine hover:text-pine"
              >
                {t.code}
              </button>
            ))}
          </div>
        )}
        {error && <Notice tone="error" title={error} className="mt-3" />}
      </div>
    </Dialog>
  );
}

/** 快捷键一览（按「?」或点「快捷键」） */
function HotkeyHelpDialog({ open, desk, onClose }: { open: boolean; desk: Desk; onClose: () => void }) {
  const keys = DESK_HOTKEYS.filter((h) => h.desks.includes(desk));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Keyboard className="size-5 text-pine" /> {desk === 'issue' ? '发卡台' : '收银台'}快捷键
        </span>
      }
      description="按一下就弹出，不用先移鼠标；没打开手牌时先让你选手牌。苹果笔记本上 F 键要同时按住 fn。"
    >
      <ul className="space-y-1.5" data-testid="hotkey-help">
        {keys.map((h) => (
          <li key={h.key} className="flex items-center gap-3 text-[14px]">
            <Kbd className="min-w-9">{h.key}</Kbd>
            <span>{h.label}</span>
          </li>
        ))}
        <li className="flex items-center gap-3 text-[14px]">
          <Kbd className="min-w-9">?</Kbd>
          <span>这张一览</span>
        </li>
        <li className="flex items-center gap-3 text-[14px] text-ink-3">
          <Kbd className="min-w-9">0–9</Kbd>
          <span>在页面任意位置直接敲牌号，回车打开</span>
        </li>
      </ul>
      {/* 8.2.12：其余的键（收银 demo 的键盘走完全流程） */}
      <h3 className="mt-4 text-[13px] font-bold text-ink-2">账单明细</h3>
      <ul className="mt-1.5 space-y-1.5" data-testid="hotkey-help-lines">
        {(
          [
            ['↓ / ↑', '进到账单明细，再在明细之间移动'],
            ['Del', '作废这一项（餐饮是退菜）'],
            ['/', '给这一项打折'],
          ] as const
        ).map(([k, t]) => (
          <li key={k} className="flex items-center gap-3 text-[14px]">
            <Kbd className="min-w-9">{k}</Kbd>
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <h3 className="mt-4 text-[13px] font-bold text-ink-2">买单对话框</h3>
      <ul className="mt-1.5 space-y-1.5">
        {(
          [
            ['⌥1–9', '加第几种收款方式（按钮上写着），光标落到金额'],
            ['F9', '确认结清；找零超过 ¥500 或实给超过应收两倍时再按一次'],
            ['Esc', '关掉对话框'],
          ] as const
        ).map(([k, t]) => (
          <li key={k} className="flex items-center gap-3 text-[14px]">
            <Kbd className="min-w-9">{k}</Kbd>
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <h3 className="mt-4 text-[13px] font-bold text-ink-2">哪里都能用</h3>
      <ul className="mt-1.5 space-y-1.5">
        {(
          [
            ['⌥1–9', '跳到左边导航的第几个入口（Windows 是 Alt）'],
            ['⌥0', '全部功能：搜名字，↑↓ 选、回车打开'],
            ['⌥N', '系统通知'],
          ] as const
        ).map(([k, t]) => (
          <li key={k} className="flex items-center gap-3 text-[14px]">
            <Kbd className="min-w-9">{k}</Kbd>
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12.5px] text-ink-3">输入法开着时敲的全角数字、字母（８２０１、Ａ０２３）也认。</p>
    </Dialog>
  );
}

/**
 * 组合 / 拆分同行（F7，两个台都有）：这位客人有同行组时问「移出同行组」（回车确认）或改为与别的客人同行；
 * 没有时直接选另一张在店的手牌组成同行（就是发卡台原来的「与在店客人同行」）
 */
export function GroupDialog({ open, visit, tags, onClose, onDone }: { open: boolean; visit: VisitDetail; tags: BoardTag[]; onClose: () => void; onDone: (v: VisitDetail, message: string) => void }) {
  const [join, setJoin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setJoin(!visit.group);
      setError(null);
    }
  }, [open, visit.group]);
  if (join || !visit.group) {
    return <JoinGroupDialog open={open} visit={visit} tags={tags} onClose={onClose} onDone={(v) => onDone(v, `${v.tag.code} 已加入同行组 ${v.group?.groupNo ?? ''}`)} />;
  }
  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<VisitDetail>(`/api/frontdesk/visits/${visit.id}/group`, { action: 'leave' }), `${visit.tag.code} 已退出同行组`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const mates = visit.group.mates.filter((m) => m.status === 'open' && m.visitId !== visit.id);
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`${visit.tag.code} · 同行 ${visit.group.groupNo}`}
      description={`同组在店：${mates.map((m) => m.tagCode).join('、') || '只剩这一张'}。移出以后单独结账、单独打单。`}
      footer={
        <>
          <Button variant="ghost" icon={<Link2 className="size-4" />} className="mr-auto" disabled={busy} onClick={() => setJoin(true)} data-testid="group-rejoin">
            改为与别的客人同行
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" data-autofocus icon={<LogOut className="size-4" />} loading={busy} onClick={leave} data-testid="group-leave">
            移出同行组（回车）
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2">账单不动：移出的这张手牌照旧是自己的账单，同组的其余手牌照旧在一起。</p>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
