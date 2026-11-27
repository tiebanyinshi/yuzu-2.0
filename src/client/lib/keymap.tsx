// 8.2.12 全局快捷键（docs/V82212_HOTKEYS.md；店主 2026-11-27 的收银员工作台 demo：「把前台所有操作都能用快捷键解决」）。
//   · ⌥1–⌥9：跳到门店导航的第 n 个入口（顺序就是侧边栏的顺序）；⌥0：「全部功能」（搜索入口，↑↓ 选、回车打开）；⌥N：系统通知；
//     Windows 上是 Alt。按 e.code 认键（苹果电脑按住 Option 打出来的是特殊符号，e.key 认不出）；
//   · 输入法正在组字（isComposing）时一律不管；有对话框开着时不跳页（先把手上的事做完）；
//   · 对话框里的 F 键：对话框里写了 data-fkey="F9" 的按钮，按 F9 就点它（买单对话框里 F9 = 确认结清），没写的照旧提示先关掉；
//   · useListKeys：列表的 ↑↓ 选、1–9 直接选第几个、回车打开（全部功能、选原因这些列表共用）。
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { Search } from 'lucide-react';
import { useStoreNav, type StoreNavItem } from '../components/storeNav';
import { Dialog } from '../components/Overlay';
import { Input, Kbd } from '../components/ui';
import { useToast } from '../components/Toast';
import { cn } from './utils';

/** 现在开着的对话框（窄屏的账单 / 客人卡抽屉不算） */
export const PANEL_SHEETS = ['手牌账单', '客人卡'];
export const openDialog = (): HTMLElement | null => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => !PANEL_SHEETS.includes(d.getAttribute('aria-label') ?? '')) ?? null;

/** 对话框里写着这个 F 键的按钮（能点的） */
export function dialogFkeyButton(dialog: HTMLElement, key: string): HTMLButtonElement | null {
  const b = dialog.querySelector<HTMLButtonElement>(`button[data-fkey="${key}"]`);
  return b && !b.disabled ? b : null;
}

/** 组字中（中文输入法正在拼）的按键不算 */
export const composing = (e: KeyboardEvent | ReactKeyboardEvent) => ('isComposing' in e && e.isComposing) || e.keyCode === 229;

/** ⌥ / Alt + 数字、字母：按物理键认（Digit1 / KeyN） */
function altCode(e: KeyboardEvent): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || composing(e)) return null;
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^Numpad[0-9]$/.test(e.code)) return e.code.slice(6);
  if (e.code === 'KeyN') return 'N';
  return null;
}

/** 门店页面外壳里挂一个：⌥数字跳页、⌥0 全部功能、⌥N 通知 */
export function GlobalHotkeys() {
  // 侧边栏展开时从上到下的顺序（按业务域分组排）
  const domains = useStoreNav();
  const items = useMemo(() => domains.flatMap((d) => d.items), [domains]);
  const navigate = useNavigate();
  const toast = useToast();
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = altCode(e);
      // 有对话框开着时不跳页：⌥数字交给对话框自己（买单里是选收款方式）
      if (k === null || openDialog()) return;
      e.preventDefault();
      if (k === 'N') return void navigate('/oa/notifications');
      if (k === '0') return setPalette(true);
      const item = items[Number(k) - 1];
      if (item) navigate(item.to);
      else toast({ tone: 'info', title: `导航里没有第 ${k} 个入口（一共 ${items.length} 个）` });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [items, navigate, toast]);
  return <CommandPalette open={palette} items={items} onClose={() => setPalette(false)} onPick={(to) => (setPalette(false), navigate(to))} />;
}

/** 列表键盘：↑↓ 移、1–9 直接选第几个（filterTyping 为 true 时输入框里的数字不算）、回车选当前 */
export function useListKeys(count: number, onPick: (index: number) => void, opts: { digits?: boolean } = {}) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (active >= count) setActive(Math.max(0, count - 1));
  }, [active, count]);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (composing(e) || count === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onPick(Math.min(active, count - 1));
    } else if (opts.digits && /^[1-9]$/.test(e.key) && Number(e.key) <= count) {
      e.preventDefault();
      onPick(Number(e.key) - 1);
    }
  };
  return { active, setActive, onKeyDown };
}

/** 全部功能（⌥0）：搜名字或拼音首字母以外的关键字（按入口名、所在分组），↑↓ 选、回车打开 */
function CommandPalette({ open, items, onClose, onPick }: { open: boolean; items: StoreNavItem[]; onClose: () => void; onPick: (to: string) => void }) {
  const [q, setQ] = useState('');
  useEffect(() => {
    if (open) setQ('');
  }, [open]);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return items.map((it, i) => ({ it, n: i + 1 })).filter(({ it }) => !t || it.label.toLowerCase().includes(t) || it.to.toLowerCase().includes(t));
  }, [items, q]);
  const keys = useListKeys(list.length, (i) => onPick(list[i]!.it.to));
  return (
    <Dialog open={open} onClose={onClose} title="全部功能" description="输入名字筛选，↑↓ 选、回车打开；平时按 ⌥ / Alt + 数字直接跳到第几个">
      <div data-testid="command-palette">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              keys.setActive(0);
            }}
            onKeyDown={keys.onKeyDown}
            className="pl-9"
            placeholder="例如 收银、钟房、泡池"
            aria-label="搜索功能"
            data-autofocus
            data-testid="command-palette-input"
          />
        </div>
        <ul className="mt-3 max-h-[50vh] space-y-1 overflow-y-auto" role="listbox" aria-label="功能">
          {list.map(({ it, n }, i) => {
            const Icon = it.icon;
            return (
              <li key={it.to}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === keys.active}
                  onMouseEnter={() => keys.setActive(i)}
                  onClick={() => onPick(it.to)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left text-[15px]',
                    i === keys.active ? 'bg-pine-soft font-bold text-pine' : 'text-ink-2 hover:bg-paper-2',
                  )}
                >
                  <Icon className="size-4" />
                  <span className="flex-1">{it.label}</span>
                  {n <= 9 && <Kbd>⌥{n}</Kbd>}
                </button>
              </li>
            );
          })}
          {list.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">没有叫「{q}」的功能</li>}
        </ul>
      </div>
    </Dialog>
  );
}
