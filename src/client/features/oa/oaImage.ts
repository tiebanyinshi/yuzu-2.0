// OA 员工端拍的照片（外勤照片、人脸录入、打卡自拍）：在浏览器里压成长边 1600 像素以内的 JPEG，另出一张 320 像素的缩略图，
// 传成 OA-03 附件（附件服务不做图像处理，单个上限 10MB）。上传带操作编号：没收到结果时用同一个编号原样重传返回原来那一个。

import { ATTACHMENT_MAX_BYTES, type OaAttachment } from '@shared/oa';
import { api } from '../../lib/api';
import { uuid } from '../../lib/utils';

async function compress(file: File): Promise<{ data: string; thumb: string; size: number }> {
  const bitmap = await createImageBitmap(file);
  const draw = (max: number, quality: number) => {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', quality);
    return url.slice(url.indexOf(',') + 1);
  };
  const data = draw(1600, 0.82);
  const thumb = draw(320, 0.7);
  bitmap.close();
  return { data, thumb, size: Math.floor((data.length * 3) / 4) };
}

/** 压缩并上传一张照片，返回附件 */
export async function uploadPhoto(file: File, fileName: string): Promise<OaAttachment> {
  const img = await compress(file);
  if (img.size > ATTACHMENT_MAX_BYTES) throw new Error('照片太大，请重拍');
  return api.post<OaAttachment>('/api/oa/attachments', { clientKey: uuid(), fileName, mime: 'image/jpeg', data: img.data, thumb: img.thumb });
}
