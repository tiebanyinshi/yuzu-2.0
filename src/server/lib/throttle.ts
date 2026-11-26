// 「每分钟被调一次、隔一阵才真跑一次」的节流（8.1.48 后端评估，docs/BACKEND_REVIEW_V8148.md 第 4 节）：
// 原来每个任务各写一个模块级的 lastRun 变量与同样的比较，收成这一个。按进程计时（重启后第一次照跑）；
// 几个进程同时跑时靠各任务自己的去重键兜底，与以往一样。

/** every(ms)(now)：距上次放行满 ms 才放行（第一次总放行）并记下这一次 */
export function every(ms: number): (now?: number) => boolean {
  let last = -Infinity;
  return (now = Date.now()) => {
    if (now - last < ms) return false;
    last = now;
    return true;
  };
}
