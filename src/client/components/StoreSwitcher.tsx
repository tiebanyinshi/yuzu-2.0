// 当前门店与换店（8.0.22，docs/MULTISTORE_V8022.md 第 2 节）：能进不止一家店的人在导航栏上看得到当前门店、点一下换店；
// 只能进一家店（含只有本店）的什么都不显示，与以往一样。换了以后整页重新加载（各页面的数据都换成那家店的）。

import { useState } from 'react';
import { Check, Store } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { cn } from '../lib/utils';
import { useToast } from './Toast';
import { MenuPanel, useDismissable, type MenuPlacement } from './UserMenu';

export async function switchStore(storeId: number) {
  await api.post('/api/auth/store', { storeId });
  window.location.reload();
}

/** 当前门店的代码，点开换店。门户页顶栏（placement="bar"，店主 2026-11-24）横排一枚小标签；门店侧栏最下面（rail）竖排 */
export function StoreSwitcher({ placement = 'rail' }: { placement?: MenuPlacement }) {
  const session = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const ref = useDismissable(open, setOpen);
  if (session.stores.length <= 1) return null;
  const pick = async (id: number) => {
    if (id === session.store.id) return setOpen(false);
    setBusy(id);
    try {
      await switchStore(id);
    } catch (e) {
      setBusy(null);
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  return (
    <div ref={ref} className={cn('relative', placement === 'rail' && 'mb-2 w-[64px]')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`当前门店：${session.store.name}（点一下换店）`}
        data-testid="store-switcher"
        className={cn(
          'font-bold transition',
          placement === 'rail'
            ? 'flex w-full flex-col items-center gap-0.5 rounded-md bg-white/10 px-1 py-1.5 text-[12px] leading-tight text-paper hover:bg-white/18'
            : 'flex h-8 items-center gap-1.5 rounded-full border border-line bg-card px-3 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink',
        )}
      >
        <Store className="size-4" />
        <span className="num truncate" data-testid="store-current">
          {session.store.code}
        </span>
      </button>
      {open && (
        <MenuPanel placement={placement} width="w-60">
          <p className="px-3 pt-2 pb-1.5 text-[12px] font-semibold text-ink-3">换门店</p>
          {session.stores.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => void pick(s.id)}
              data-testid={`store-pick-${s.code}`}
              className={cn(
                'tap relative flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-[14px] font-medium hover:bg-paper-2',
                s.id === session.store.id ? 'text-ink' : 'text-ink-2',
              )}
            >
              <span className="num w-10 shrink-0 text-[12.5px] text-ink-3">{s.code}</span>
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.id === session.store.id && <Check className="size-4 text-pine" />}
              {busy === s.id && <span className="text-[12px] text-ink-3">切换中…</span>}
            </button>
          ))}
        </MenuPanel>
      )}
    </div>
  );
}
