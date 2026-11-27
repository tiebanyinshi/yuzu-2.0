// 员工培训后台的「改资料」写操作（新建 / 修改文件夹、修改文件信息）的结果待确认（Codex 审查 a3f5310，AGENTS.md 开发约定）：
// 记录与重提的做法在 lib/localOps.ts（汤崎学堂共用）。没收到结果的在「WCP 设置 → 员工培训」顶上列出来，可以原样重提：
//   · 新建文件夹带操作编号，原样重提返回原来那个；
//   · 修改带页面看到的版本号，原样重提时服务端发现现在的内容就是这次要改成的，按改好了算。

import { createLocalOps, type LocalOp } from '../../lib/localOps';

export type TrainingOp = LocalOp;

const ops = createLocalOps('yuzu.trainingOps.v1');
export const useTrainingOps = ops.useOps;
export const sendTrainingOp = ops.send;
