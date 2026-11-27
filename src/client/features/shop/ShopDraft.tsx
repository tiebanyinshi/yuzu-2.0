// 自主申请的草稿（8.2.6，需求变更文档 v0.2「保存草稿」）：填到一半关了页面、换了页，回来还在。
// 只存在这台设备的浏览器里（按账号分开）；提交成功就清掉。草稿不进系统、别人看不到（docs/MALL_V826.md 偏差说明）

import { useCallback, useEffect, useState } from 'react';
import { emptyCustomItem, type CustomItemState } from './ShopPilot';

const keyOf = (staffId: number) => `yuzu.shop.customDraft.${staffId}`;

export function useCustomDraft(staffId: number) {
  const key = keyOf(staffId);
  const [item, setItem] = useState<CustomItemState>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return { ...emptyCustomItem(), ...(JSON.parse(raw) as Partial<CustomItemState>) };
    } catch {
      // 读不到（隐私模式、坏数据）就从空的开始
    }
    return emptyCustomItem();
  });
  useEffect(() => {
    try {
      if (JSON.stringify(item) === JSON.stringify(emptyCustomItem())) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(item));
    } catch {
      // 存不了不影响填写
    }
  }, [key, item]);
  const clear = useCallback(() => {
    try {
      localStorage.removeItem(key);
    } catch {
      // 同上
    }
  }, [key]);
  return [item, setItem, clear] as const;
}
