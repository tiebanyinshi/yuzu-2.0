// 页面的几种状态（核对清单第 18、19 条）：加载（骨架，短于 300 毫秒不出）、空（写空的时候说什么）、
// 出错（写原因和怎么办，给「重新加载」）、连不上（没信号）。点「重新加载」发 retry 事件。

Component({
  properties: {
    /** loading | empty | error | offline */
    state: { type: String, value: 'loading' },
    title: { type: String, value: '' },
    message: { type: String, value: '' },
    /** 骨架几行 */
    rows: { type: Number, value: 3 },
  },
  data: { showSkeleton: false, lines: [] as number[] },
  observers: {
    'state, rows'(state: string, rows: number) {
      this.setData({ lines: Array.from({ length: Math.max(1, rows) }, (_, i) => i) });
      if (state !== 'loading') {
        this.setData({ showSkeleton: false });
        return;
      }
      // 短于 300 毫秒的加载不出骨架（不闪一下）
      setTimeout(() => {
        if (this.data.state === 'loading') this.setData({ showSkeleton: true });
      }, 300);
    },
  },
  methods: {
    onRetry() {
      this.triggerEvent('retry');
    },
  },
});
