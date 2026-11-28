// 导航栏（src/utils/nav.ts）：高度按胶囊算，胶囊那一行的内容不伸进胶囊。

import { describe, expect, it } from 'vitest';
import { navMetricsOf, openPage } from '../src/utils/nav';

describe('导航栏', () => {
  it('iPhone：状态栏 47、胶囊上沿 51 高 32 左沿 281（屏宽 375）', () => {
    expect(navMetricsOf(47, 375, { top: 51, height: 32, left: 281 })).toEqual({ statusBar: 47, bar: 40, capsuleRight: 94, capsuleHeight: 32 });
  });

  it('取不到胶囊、胶囊位置不对：用常见的默认值', () => {
    expect(navMetricsOf(24, 360, null)).toMatchObject({ statusBar: 24, bar: 44 });
    expect(navMetricsOf(30, 360, { top: 10, height: 32, left: 260 })).toMatchObject({ statusBar: 30, bar: 44 });
  });
});

describe('打开一页', () => {
  it('Tab 页用 switchTab（去掉参数），别的用 navigateTo（带参数）', () => {
    const calls: string[] = [];
    (globalThis as unknown as { wx: unknown }).wx = {
      switchTab: (o: { url: string }) => calls.push(`tab ${o.url}`),
      navigateTo: (o: { url: string }) => calls.push(`nav ${o.url}`),
    };
    openPage('/pages/learn/index');
    openPage('/pages/learn/index?from=notice');
    openPage('/pages/academy-course/index?id=8');
    expect(calls).toEqual(['tab /pages/learn/index', 'tab /pages/learn/index', 'nav /pages/academy-course/index?id=8']);
  });
});
