import { INSTANCE_LABELS, versionText, type InstanceKind } from '@shared/instance';
import { cn } from '../lib/utils';

// 实例标识与版本：登录页、导航栏常显，员工一眼分清正式服和「不作数」的测试服、影子库、演示库
const TONE: Record<InstanceKind, string> = {
  prod: 'bg-pine-soft text-pine',
  shadow: 'bg-ember text-white',
  test: 'bg-ember text-white',
  demo: 'bg-ember text-white',
  dev: 'bg-yuzu text-ink',
  trial: 'bg-yuzu text-ink',
  unset: 'bg-clay text-white',
};

// 前后端同一个镜像，不会出现未知的取值；万一出现也按「未设置」显示，不让页面出错
const labelOf = (instance: InstanceKind) => INSTANCE_LABELS[instance] ?? INSTANCE_LABELS.unset;
const toneOf = (instance: InstanceKind) => TONE[instance] ?? TONE.unset;

/** 登录页：一行标识 */
export function InstanceBadge({ instance, className }: { instance: InstanceKind; className?: string }) {
  return (
    <span data-testid="instance-badge" className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-[12.5px] leading-none font-bold', toneOf(instance), className)}>
      {labelOf(instance)}
    </span>
  );
}

/**
 * 门店侧栏最下面的「返回门户」（店主 2026-11-24，docs/PORTAL.md PT5）：环境标识、版本号移到了门户页顶栏，
 * 侧栏这一格按环境上色、写短标识（正式服之外一眼看得出「不作数」），悬停看完整标识与「版本 + SHA」
 */
export function InstanceTone({ instance, version, commit }: { instance: InstanceKind; version: string; commit: string }) {
  const short = labelOf(instance).split('·')[0]!;
  return (
    <span
      data-testid="instance-tag"
      title={`${labelOf(instance)} · ${versionText(version, commit)}`}
      className={cn('w-full truncate rounded-md px-1 py-0.5 text-center text-[12px] leading-tight font-bold', toneOf(instance))}
    >
      {short}
    </span>
  );
}
