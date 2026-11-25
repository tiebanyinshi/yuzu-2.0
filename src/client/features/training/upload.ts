// 员工培训的分块上传（docs/TRAINING.md 第 5 节）：开始（带操作编号）→ 一块块传（已在服务器上的块跳过）→ 完成。
// 同一个操作编号重新来一遍就是「接着传」：开始返回已经传到的块，完成对同一次上传只登记一次。
// 没收到「完成」的结果时先查回这次上传（GET uploads/:id）：已经登记了就当成功，不会再建一份。

import { TRAINING_CHUNK_BYTES, trainingMimeOf } from '@shared/training';
import { api, isRejected, UncertainError } from '../../lib/api';
import { bytesToBase64 } from '../../lib/import-file';

export interface UploadTarget {
  folderId?: number;
  fileId?: number;
  title?: string;
  description?: string;
  note?: string;
}

interface UploadState {
  uploadId: number;
  chunkCount: number;
  received: number[];
  status: 'open' | 'done';
  fileId: number | null;
  versionId: number | null;
}

/** 传一个文件；progress 0–1。clientKey 由调用方保管：失败了用同一个编号再调一次就是接着传 */
export async function uploadTrainingFile(file: File, clientKey: string, target: UploadTarget, progress: (p: number) => void): Promise<{ fileId: number; versionId: number }> {
  const mime = trainingMimeOf(file.name);
  if (!mime) throw new Error(`「${file.name}」的格式不支持：只能传 PDF、图片、视频、音频、Excel、PPT、Word`);
  const start = await api.post<UploadState>('/api/admin/training/uploads', { clientKey, fileName: file.name, mime, sizeBytes: file.size });
  if (start.status === 'done') {
    progress(1);
    return { fileId: start.fileId!, versionId: start.versionId! };
  }
  const have = new Set(start.received);
  let done = have.size;
  for (let seq = 0; seq < start.chunkCount; seq++) {
    if (have.has(seq)) continue;
    const part = await file.slice(seq * TRAINING_CHUNK_BYTES, (seq + 1) * TRAINING_CHUNK_BYTES).arrayBuffer();
    // 一块传不上去先原样再试两次（同一块重传不会重复存）
    for (let attempt = 0; ; attempt++) {
      try {
        await api.put(`/api/admin/training/uploads/${start.uploadId}/chunks/${seq}`, { data: bytesToBase64(part) }, { timeoutMs: 120_000 });
        break;
      } catch (e) {
        if (attempt >= 2 || isRejected(e)) throw e;
      }
    }
    done += 1;
    progress((done / start.chunkCount) * 0.95);
  }
  const body = { folderId: target.folderId ?? null, fileId: target.fileId ?? null, title: target.title ?? '', description: target.description ?? '', note: target.note ?? '' };
  try {
    const r = await api.post<{ fileId: number; versionId: number }>(`/api/admin/training/uploads/${start.uploadId}/complete`, body, { timeoutMs: 180_000 });
    progress(1);
    return r;
  } catch (e) {
    if (!(e instanceof UncertainError)) throw e;
    // 没收到结果：查回这次上传，已经登记了就当成功
    const state = await api.get<UploadState>(`/api/admin/training/uploads/${start.uploadId}`);
    if (state.status === 'done') {
      progress(1);
      return { fileId: state.fileId!, versionId: state.versionId! };
    }
    throw e;
  }
}
