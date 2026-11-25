// Design 素材库（docs/BOARDS.md 第 4 节）：各处读「这个用途现在用哪一版素材」。取不回来就当没设（照原来的样子显示），不打扰员工。
// 一直开着没人动的屏（对客导览大屏、门户）也要跟上别的电脑换的用途（Codex 审查）：每分钟重新取一次「现在用的」
// （lib/livePoll：页面在后台、断网时不取，回到页面、联网时马上取）；取不回来时留着上一次的，不闪。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { designFileUrl, type DesignCurrent, type DesignSlot } from '@shared/design';
import { api } from './api';
import { useLivePoll } from './livePoll';

export const designCurrentKey = ['design', 'current'] as const;
const REFRESH_MS = 60_000;

/**
 * 这个用途现在用哪一版：版本编号；没设、取不回来为 null；第一次还在取为 undefined（平板菜单字体等它定下来再取，免得先取一遍目录里的再换）
 */
export function useDesignSlotVersion(slot: DesignSlot): number | null | undefined {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: designCurrentKey, queryFn: () => api.get<DesignCurrent>('/api/design/current'), staleTime: REFRESH_MS, retry: false });
  useLivePoll(() => qc.invalidateQueries({ queryKey: designCurrentKey }), [qc], { intervalMs: REFRESH_MS });
  if (q.isPending) return undefined;
  return q.data?.[slot] ?? null;
}

/** 这个用途现在用的文件地址（没设、没取回来为空） */
export function useDesignSlot(slot: DesignSlot): string | null {
  const id = useDesignSlotVersion(slot);
  return id ? designFileUrl(id) : null;
}
