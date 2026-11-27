// 实例标识（AGENTS.md「环境隔离」）：登录页与导航栏常显（与网页同一套说法）；正式服用中性颜色，测试服、演示库等用提醒色（docs/STAFF_MP.md 第 2.2 节）。

import type { InstanceKind } from '../../../src/shared/instance';

const LABELS: Record<InstanceKind, string> = {
  prod: '正式服',
  shadow: '影子运行·不作数',
  test: '测试服·不作数',
  demo: '演示·不作数',
  dev: '开发环境',
  trial: '试用',
  unset: '未设置实例标识',
};

/** 正式服：标识用中性颜色（不是提醒） */
export const isProdInstance = (kind: InstanceKind | string | undefined) => kind === 'prod';

export function instanceTag(kind: InstanceKind | string | undefined): string {
  if (!kind) return '';
  return (LABELS as Record<string, string>)[kind] ?? String(kind);
}

/** 关于里写的版本：v + 版本号，有 SHA 时附前 7 位 */
export function versionText(version: string, commit: string): string {
  return commit ? `v${version} · ${commit.slice(0, 7)}` : `v${version}`;
}
