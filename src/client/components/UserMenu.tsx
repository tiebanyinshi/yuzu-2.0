// 账号菜单（头像）：本机终端、网络与同步、外观、修改密码、退出登录。
// 门户页改造（店主 2026-11-24，docs/PORTAL.md）：头像在门户页顶栏右侧（placement="bar"，菜单往下展开）；
// 原来在门店侧栏最下面（placement="rail"，菜单往右展开）。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, MonitorSmartphone, Wifi } from 'lucide-react';
import { DUTY_LABELS, ROLE_LABELS } from '@shared/labels';
import { useTerminalState } from '../features/devices/terminal';
import { api } from '../lib/api';
import { useConnection } from '../lib/connection';
import { useExitGhost } from '../lib/motion';
import { useCan, useSession } from '../lib/session';
import { cn } from '../lib/utils';
import { useLocalPendingCount } from './LocalPendingNotice';
import { ThemeMenuRow } from './ThemeSwitch';

export type MenuPlacement = 'rail' | 'bar';

/** 点外面、按 Esc 收起的下拉菜单的开关 */
export function useDismissable(open: boolean, setOpen: (v: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open, setOpen]);
  return ref;
}

export function UserMenu({ placement = 'rail' }: { placement?: MenuPlacement }) {
  const session = useSession();
  const can = useCan();
  // 这台电脑现在设成了哪台终端（记在本机浏览器里；没设 = 不上报）
  const terminalCode = useTerminalState().terminal;
  const link = useConnection();
  const pendingCount = useLocalPendingCount();
  const [open, setOpen] = useState(false);
  const ref = useDismissable(open, setOpen);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login', { replace: true });
  };
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="user-menu"
        className={cn(
          'tap relative flex items-center justify-center rounded-full bg-yuzu font-bold text-on-bright transition',
          placement === 'rail' ? 'size-11 text-[15px] ring-2 ring-white/15 hover:ring-white/35 short:size-9 short:text-[14px]' : 'size-9 text-[14px] ring-2 ring-pine/10 hover:ring-pine/30',
        )}
        title={`${session.staff.displayName} · ${roleText(session.staff)}`}
      >
        {session.staff.displayName.slice(0, 1)}
      </button>
      {open && (
        <MenuPanel placement={placement}>
          <div className="px-3 pt-2 pb-2.5">
            <p className="text-[14px] font-bold">{session.staff.displayName}</p>
            <p className="text-[12px] text-ink-3">
              {roleText(session.staff)} · {session.staff.username}
            </p>
          </div>
          <div className="my-1 h-px bg-line" />
          {can('device.view') && (
            // 本机终端（8.0.19，IA 第 3.4 节）：这台电脑是哪台终端在门店「设备」页右边设；从哪一页都点得到
            <MenuItem icon={<MonitorSmartphone className="size-4" />} onClick={() => go('/crm/devices#terminal')} testId="user-menu-terminal">
              本机终端
              <span className="ml-auto max-w-[96px] truncate text-[12px] text-ink-3" data-testid="user-menu-terminal-current">
                {terminalCode ?? '未设置'}
              </span>
            </MenuItem>
          )}
          {/* 网络与同步（8.1.3 WL12）：连接、版本、这台电脑上的待确认、最近的问题 */}
          <MenuItem icon={<Wifi className="size-4" />} onClick={() => go('/network')} testId="user-menu-network">
            网络与同步
            <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3">
              {pendingCount > 0 && <span data-testid="user-menu-network-pending">{pendingCount} 笔待确认</span>}
              <span className={cn('size-2 rounded-full', link.state === 'offline' ? 'bg-clay' : link.updated ? 'bg-lake' : 'bg-pine')} />
            </span>
          </MenuItem>
          {/* 外观（8.1.15）：浅色 / 深色 / 跟随系统，记在这台设备上 */}
          <div className="my-1 h-px bg-line" />
          <ThemeMenuRow />
          <div className="my-1 h-px bg-line" />
          <MenuItem icon={<KeyRound className="size-4" />} onClick={() => go('/crm/password')}>
            修改密码
          </MenuItem>
          <MenuItem icon={<LogOut className="size-4" />} onClick={logout} testId="user-menu-logout">
            退出登录
          </MenuItem>
        </MenuPanel>
      )}
    </div>
  );
}

/** 菜单面板：从按钮的位置放大出来；关掉时留一个影子缩回去（8.0.16）。侧栏里往右展开，顶栏里往下、靠右对齐 */
export function MenuPanel({ children, placement = 'rail', width = 'w-56', className }: { children: ReactNode; placement?: MenuPlacement; width?: string; className?: string }) {
  const ref = useExitGhost<HTMLDivElement>();
  return (
    <div
      ref={ref}
      role="menu"
      data-mo-out="menu"
      className={cn(
        'absolute z-30 animate-menu-in rounded-lg border border-line bg-card p-1.5 text-ink shadow-pop',
        width,
        placement === 'rail' ? 'bottom-0 left-[calc(100%+12px)] origin-bottom-left' : 'top-[calc(100%+8px)] right-0 origin-top-right',
        className,
      )}
    >
      {children}
    </div>
  );
}

function roleText(staff: { role: keyof typeof ROLE_LABELS; duties: (keyof typeof DUTY_LABELS)[] }) {
  return [ROLE_LABELS[staff.role], ...staff.duties.map((d) => DUTY_LABELS[d].title)].join(' · ');
}

function MenuItem({ icon, children, onClick, testId }: { icon: ReactNode; children: ReactNode; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      data-testid={testId}
      className="tap relative flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-[14px] font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
    >
      {icon}
      {children}
    </button>
  );
}
