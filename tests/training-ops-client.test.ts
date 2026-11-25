// 员工培训后台「改资料」写操作的本机待确认记录（src/client/features/training/ops.ts，Codex 审查 f5de374）：
// 结果不明的原样重提，被拒绝时要能断定结果（409 / 404 / 400 / 422）才删；401、403、429 这类留着。
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn() }));
vi.mock('../src/client/lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number) {
      super('rejected');
    }
  }
  class UncertainError extends Error {}
  return { api: { post: mocks.post, put: mocks.put }, ApiError, UncertainError, isRejected: (e: unknown) => e instanceof ApiError && e.status < 500 };
});
import { ApiError, UncertainError } from '../src/client/lib/api';
import { sendTrainingOp } from '../src/client/features/training/ops';

let storage = new Map<string, string>();
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal('window', new EventTarget());
  vi.clearAllMocks();
});
const pending = () => JSON.parse(storage.get('yuzu.trainingOps.v1') ?? '[]') as { key: string }[];
const op = (key: string) => ({ key, method: 'PUT' as const, url: '/api/admin/training/folders/1', body: { name: '安保部', version: 1 }, summary: '修改文件夹' });

describe('sendTrainingOp', () => {
  it('第一次就被明确拒绝：删本机记录', async () => {
    mocks.put.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'x'));
    await expect(sendTrainingOp(op('a'))).rejects.toBeInstanceOf(ApiError);
    expect(pending()).toEqual([]);
  });
  it('结果不明后重提被 401 拒绝：留着（不能断定原来那次有没有生效）', async () => {
    mocks.put.mockRejectedValueOnce(new UncertainError('timeout'));
    await expect(sendTrainingOp(op('b'))).rejects.toBeInstanceOf(UncertainError);
    expect(pending().map((x) => x.key)).toEqual(['b']);
    for (const status of [401, 403, 429]) {
      mocks.put.mockRejectedValueOnce(new ApiError(status, 'REJECTED', 'x'));
      await expect(sendTrainingOp(op('b'))).rejects.toBeInstanceOf(ApiError);
      expect(pending().map((x) => x.key)).toEqual(['b']);
    }
  });
  it('重提被 409 拒绝（现在的内容不是要改成的）：能断定，删', async () => {
    mocks.put.mockRejectedValueOnce(new UncertainError('timeout'));
    await expect(sendTrainingOp(op('c'))).rejects.toBeInstanceOf(UncertainError);
    mocks.put.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'x'));
    await expect(sendTrainingOp(op('c'))).rejects.toBeInstanceOf(ApiError);
    expect(pending()).toEqual([]);
  });
  it('重提成功：删', async () => {
    mocks.put.mockRejectedValueOnce(new UncertainError('timeout'));
    await expect(sendTrainingOp(op('d'))).rejects.toBeInstanceOf(UncertainError);
    mocks.put.mockResolvedValueOnce({ ok: true });
    await expect(sendTrainingOp(op('d'))).resolves.toEqual({ ok: true });
    expect(pending()).toEqual([]);
  });
});
