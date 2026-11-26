// 采购商城商品图（8.1.48，店主 2026-11-26：「淘宝、得物那样逛高级电商的感觉，好的商品图」，docs/MALL_V8148.md）。
// · ProductImage：封面图（没有图时按分类配一块柔和的渐变底 + 名字头一个字，不留空白格子）
// · ProductGallery：商品页的大图与缩略图
// · MaterialImagesEditor：物料主档里整组换商品图（上传、删、设为封面），带「看到的那一组」，别人先改过拒绝

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftToLine, Package } from 'lucide-react';
import { SHOP_MAX_MATERIAL_IMAGES, shopImageUrl } from '@shared/shop';
import type { ImageRef } from '@shared/requests';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { ImagePicker } from '../../components/Images';
import { useToast } from '../../components/Toast';
import { Button } from '../../components/ui';

/** 按分类给一个固定的色相：同一类的占位图颜色一样，扫一眼就分得开 */
function hueOf(text: string) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function ProductImage({
  imageIds,
  name,
  category,
  className,
  rounded = 'rounded-2xl',
  testId,
}: {
  imageIds: readonly number[];
  name: string;
  category: string;
  className?: string;
  rounded?: string;
  testId?: string;
}) {
  const [broken, setBroken] = useState(false);
  const cover = imageIds[0];
  if (cover !== undefined && !broken)
    return (
      <div className={cn('relative overflow-hidden bg-paper-2', rounded, className)} data-testid={testId}>
        <img src={shopImageUrl(cover)} alt={name} loading="lazy" decoding="async" onError={() => setBroken(true)} className="size-full object-cover" />
      </div>
    );
  const hue = hueOf(category || '未分类');
  return (
    <div
      className={cn('relative flex items-center justify-center overflow-hidden', rounded, className)}
      style={{ background: `radial-gradient(120% 90% at 20% 10%, hsl(${hue} 45% 96%), hsl(${hue} 30% 88%) 70%, hsl(${hue} 25% 82%))` }}
      aria-label={`${name}（还没有商品图）`}
      role="img"
      data-testid={testId}
      data-placeholder=""
    >
      <span className="flex flex-col items-center gap-2 px-3 text-center">
        <Package className="size-[clamp(22px,22%,56px)]" style={{ color: `hsl(${hue} 28% 38% / 0.5)` }} aria-hidden />
        <span className="line-clamp-2 text-[clamp(12px,1.6vw,14px)] font-semibold" style={{ color: `hsl(${hue} 24% 34% / 0.7)` }}>
          {name}
        </span>
      </span>
    </div>
  );
}

/** 商品页：大图 + 缩略图（点缩略图换大图） */
export function ProductGallery({ imageIds, name, category }: { imageIds: readonly number[]; name: string; category: string }) {
  const [at, setAt] = useState(0);
  const current = imageIds[at] ?? imageIds[0];
  return (
    <div className="space-y-3" data-testid="shop-gallery">
      <ProductImage
        imageIds={current === undefined ? [] : [current]}
        name={name}
        category={category}
        className="aspect-square w-full shadow-[0_24px_60px_-28px_rgb(28_35_31/0.45)]"
        rounded="rounded-3xl"
      />
      {imageIds.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {imageIds.map((id, i) => (
            <button
              key={id}
              type="button"
              onClick={() => setAt(i)}
              className={cn('tap relative size-16 shrink-0 overflow-hidden rounded-xl ring-2 transition', i === at ? 'ring-ink' : 'ring-transparent opacity-70 hover:opacity-100')}
              aria-label={`看第 ${i + 1} 张`}
              aria-pressed={i === at}
            >
              <img src={shopImageUrl(id)} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 物料主档：整组换商品图；第 1 张是封面 */
export function MaterialImagesEditor({ materialId, imageIds, canEdit }: { materialId: number; imageIds: number[]; canEdit: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [saved, setSaved] = useState<number[]>(imageIds);
  const [value, setValue] = useState<ImageRef[]>(() => imageIds.map((id) => ({ id, url: shopImageUrl(id) })));
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = value.map((v) => v.id).join(',') !== saved.join(',');
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put<{ imageIds: number[] }>(`/api/erp/shop/materials/${materialId}/images`, { imageIds: value.map((v) => v.id), expectedImageIds: saved });
      setSaved(r.imageIds);
      setValue(r.imageIds.map((id) => value.find((v) => v.id === id) ?? { id, url: shopImageUrl(id) }));
      void qc.invalidateQueries({ queryKey: ['shop'] });
      toast({ tone: 'success', title: '商品图已保存' });
    } catch (e) {
      toast({ tone: 'error', title: '商品图没有保存', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const toCover = (i: number) => setValue([value[i]!, ...value.filter((_, j) => j !== i)]);
  return (
    <div className="space-y-2 rounded-xl border border-line bg-paper-2/40 p-3" data-testid="shop-mat-images">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink">商品图</p>
        <span className="text-[12px] text-ink-3">最多 {SHOP_MAX_MATERIAL_IMAGES} 张，第 1 张是封面；建议正方形、白底或干净的背景</span>
      </div>
      {canEdit ? (
        <ImagePicker value={value} onChange={setValue} max={SHOP_MAX_MATERIAL_IMAGES} disabled={busy} onBusyChange={setUploading} testId="shop-mat-images-add" />
      ) : value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <img key={v.id} src={v.url} alt="" className="size-14 rounded-md border border-line object-cover" />
          ))}
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-3">还没有商品图</p>
      )}
      {canEdit && value.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {value.slice(1).map((v, k) => (
            <button
              key={v.id}
              type="button"
              onClick={() => toCover(k + 1)}
              className="tap relative inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-2 ring-1 ring-line hover:text-ink"
              data-testid={`shop-mat-images-cover-${k + 2}`}
            >
              <ArrowLeftToLine className="size-3" />第 {k + 2} 张设为封面
            </button>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" disabled={!dirty || uploading} loading={busy} onClick={() => void save()} data-testid="shop-mat-images-save">
            保存商品图
          </Button>
        </div>
      )}
    </div>
  );
}
