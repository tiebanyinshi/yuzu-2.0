// 拍照或选图上传成附件（外勤打卡的照片、申请单的图片附件）：接口是 WCP 的附件上传（POST /api/oa/attachments，JSON 里带 base64），
// 原样挂在员工小程序端口上。上传带操作编号：同一个编号重提回原来那一个，不会多一份。只传图片（JPEG、PNG、WebP）。

import type { OaAttachment } from '../../../src/shared/oa';
import { apiError, call } from './api';
import { uuid } from './uuid';

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function mimeOfPath(path: string): { mime: string; ext: string } | null {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase();
  const mime = MIME[ext];
  return mime ? { mime, ext: ext === 'jpeg' ? 'jpg' : ext } : null;
}

/** 拍一张或从相册选；camera = 只能现场拍（外勤） */
export function choosePhotos(count: number, camera: boolean): Promise<string[]> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: Math.max(1, Math.min(9, count)),
      mediaType: ['image'],
      sourceType: camera ? ['camera'] : ['camera', 'album'],
      sizeType: ['compressed'],
      success: (r) => resolve(r.tempFiles.map((f) => f.tempFilePath)),
      fail: (e) => {
        // 自己点了取消：不算错
        if (/cancel/i.test(String((e as { errMsg?: string }).errMsg ?? ''))) resolve([]);
        else reject(apiError('PHOTO_FAILED', '没有拍到照片：请允许微信使用相机再试', 0));
      },
    });
  });
}

function readBase64(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      encoding: 'base64',
      success: (r) => resolve(String(r.data)),
      fail: () => reject(apiError('PHOTO_FAILED', '照片没读出来，请重拍一张', 0)),
    });
  });
}

/** 上传一张照片成附件 */
export async function uploadPhoto(path: string, name = 'photo'): Promise<OaAttachment> {
  const kind = mimeOfPath(path);
  if (!kind) throw apiError('PHOTO_FORMAT', '只能传 JPG、PNG、WebP 的照片', 0);
  const data = await readBase64(path);
  return call<OaAttachment>('POST', '/oa/attachments', { clientKey: uuid(), fileName: `${name}.${kind.ext}`, mime: kind.mime, data });
}
