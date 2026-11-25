// Design 素材库（docs/BOARDS.md 第 4 节）：各处读「这个用途现在用哪一版素材」。取不回来就当没设（照原来的样子显示），不打扰员工。

import { useQuery } from '@tanstack/react-query';
import { designFileUrl, type DesignCurrent, type DesignSlot } from '@shared/design';
import { api } from './api';

export const designCurrentKey = ['design', 'current'] as const;

/** 这个用途现在用的文件地址（没设、没取回来为空） */
export function useDesignSlot(slot: DesignSlot): string | null {
  const q = useQuery({ queryKey: designCurrentKey, queryFn: () => api.get<DesignCurrent>('/api/design/current'), staleTime: 60_000, retry: false });
  const id = q.data?.[slot] ?? null;
  return id ? designFileUrl(id) : null;
}
