// OA-07 人脸比对（docs/OA.md 第 10 节；需求文档四（四）第 3 条「预留 FaceVerifyService 接口便于替换」）。
//   · 只定接口：供应商按现有系统可用的服务接入时实现一个 FaceVerifyService，在 faceVerifier() 里按运行环境选上就行。
//   · 模拟（INTEGRATIONS_MOCK=true，只许开发、测试实例，见 integrations/config.ts）不出网：自拍的文件名里带「mismatch」算不通过，其余算通过。
//   · 正式环境还没接供应商：返回 unavailable，打卡照常、记「人脸待人工核对」（不因为服务没接上就打不了卡）。
//   · 在事务外调用（不在事务里等外部服务，8.1.3）。照片按原样交给比对服务，不在这里落盘、不记日志。

export interface FacePhoto {
  fileName: string;
  mime: string;
  data: Buffer;
}
/** pass：是同一人；fail：不是；unavailable：服务没配置、连不上或出错（打卡照常，记待人工核对） */
export type FaceVerdict = { result: 'pass'; score?: number } | { result: 'fail'; score?: number } | { result: 'unavailable'; reason: string };

export interface FaceVerifyService {
  /** 自拍与这个人已通过审核的几张录入照片比对 */
  verify(input: { enrolled: FacePhoto[]; probe: FacePhoto }): Promise<FaceVerdict>;
}

const mockVerifier: FaceVerifyService = {
  async verify({ probe }) {
    return /mismatch/i.test(probe.fileName) ? { result: 'fail', score: 0.1 } : { result: 'pass', score: 0.99 };
  },
};

const unconfigured: FaceVerifyService = {
  async verify() {
    return { result: 'unavailable', reason: '人脸比对服务还没接入' };
  },
};

/** 按运行环境选比对服务：模拟模式用模拟，其余还没有供应商（返回 unavailable） */
export function faceVerifier(cfg: { mock: boolean }): FaceVerifyService {
  return cfg.mock ? mockVerifier : unconfigured;
}

/** 调比对服务：出错、超时一律当 unavailable（不让比对服务的故障挡住打卡） */
export async function verifyFace(service: FaceVerifyService, input: { enrolled: FacePhoto[]; probe: FacePhoto }, timeoutMs = 10_000): Promise<FaceVerdict> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      service.verify(input),
      new Promise<FaceVerdict>((resolve) => {
        timer = setTimeout(() => resolve({ result: 'unavailable', reason: '人脸比对服务没有及时回应' }), timeoutMs);
      }),
    ]);
  } catch {
    return { result: 'unavailable', reason: '人脸比对服务出错' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
