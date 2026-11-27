// 导航栏（src/utils/nav.ts）：高度按胶囊算，胶囊那一行的内容不伸进胶囊。

import { describe, expect, it } from 'vitest';
import { navMetricsOf } from '../src/utils/nav';

describe('导航栏', () => {
  it('iPhone：状态栏 47、胶囊上沿 51 高 32 左沿 281（屏宽 375）', () => {
    expect(navMetricsOf(47, 375, { top: 51, height: 32, left: 281 })).toEqual({ statusBar: 47, bar: 40, capsuleRight: 94, capsuleHeight: 32 });
  });

  it('取不到胶囊、胶囊位置不对：用常见的默认值', () => {
    expect(navMetricsOf(24, 360, null)).toMatchObject({ statusBar: 24, bar: 44 });
    expect(navMetricsOf(30, 360, { top: 10, height: 32, left: 260 })).toMatchObject({ statusBar: 30, bar: 44 });
  });
});
