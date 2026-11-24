// 打卡点的地图选点（店主 2026-11-24《考勤排班功能优化需求说明》第 1 条）：不引第三方地图库，直接拼瓦片——
// 拖动看周围、点一下把打卡点放在那里（标记跟着走），「+ / −」缩放，四个方向键每次挪 2 米微调。
// 进出的坐标都是 WGS-84（与手机定位、打卡判定一样）；高德底图是 GCJ-02，画的时候换过去、点的时候换回来。

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Crosshair, MapPin, Minus, Plus } from 'lucide-react';
import { fromPixel, gcj02ToWgs84, toPixel, wgs84ToGcj02, type GeoInfo, type LatLng } from '@shared/geo';
import { cn } from '../../lib/utils';

const TILE = 256;
const MIN_Z = 3;
const MAX_Z = 19;
/** 方向键每次挪的距离（米） */
const NUDGE_M = 2;

function tileUrl(provider: GeoInfo['provider'], x: number, y: number, z: number): string {
  if (provider === 'amap') return `https://webrd0${1 + ((x + y) % 4)}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`;
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

export function MapPicker({ value, onChange, provider, testId = 'att-map' }: { value: LatLng | null; onChange: (p: LatLng) => void; provider: GeoInfo['provider']; testId?: string }) {
  const amap = provider === 'amap';
  const toShow = (p: LatLng) => (amap ? wgs84ToGcj02(p) : p);
  const toSave = (p: LatLng) => (amap ? gcj02ToWgs84(p) : p);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 288 });
  const [z, setZ] = useState(17);
  const [center, setCenter] = useState<LatLng>(() => toShow(value ?? { lat: 31.230416, lng: 121.473701 }));
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 外面换了点（搜索选了一个、定位到了）：地图挪到那里
  const valueKey = value ? `${value.lat.toFixed(6)},${value.lng.toFixed(6)}` : '';
  const lastKey = useRef('');
  useEffect(() => {
    if (!value || valueKey === lastKey.current) return;
    lastKey.current = valueKey;
    setCenter(toShow(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  const c = toPixel(center, z);
  const left = c.x - size.w / 2;
  const top = c.y - size.h / 2;
  const n = 2 ** z;
  const tiles: { x: number; y: number; key: string }[] = [];
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + size.w) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + size.h) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      tiles.push({ x: tx, y: ty, key: `${z}/${tx}/${ty}` });
    }
  }
  const marker = value ? toPixel(toShow(value), z) : null;

  const set = (p: LatLng) => {
    const w = toSave(p);
    lastKey.current = `${w.lat.toFixed(6)},${w.lng.toFixed(6)}`;
    onChange({ lat: Number(w.lat.toFixed(6)), lng: Number(w.lng.toFixed(6)) });
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y, moved: false };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setCenter(fromPixel(d.cx - dx, d.cy - dy, z));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    // 点一下（没拖）：打卡点放在这里
    const r = box.current!.getBoundingClientRect();
    set(fromPixel(left + (e.clientX - r.left), top + (e.clientY - r.top), z));
  };
  const nudge = (east: number, north: number) => {
    if (!value) return;
    const dLat = (north * NUDGE_M) / 111_320;
    const dLng = (east * NUDGE_M) / (111_320 * Math.cos((value.lat * Math.PI) / 180));
    onChange({ lat: Number((value.lat + dLat).toFixed(6)), lng: Number((value.lng + dLng).toFixed(6)) });
  };
  const btn = 'flex size-9 items-center justify-center rounded-md border border-line-strong bg-card text-ink-2 shadow-sm hover:text-ink disabled:opacity-40';

  return (
    <div className="space-y-2">
      <div
        ref={box}
        className="relative h-72 w-full touch-none overflow-hidden rounded-lg border border-line bg-paper-2 select-none"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        role="application"
        aria-label="地图：拖动看周围，点一下把打卡点放在那里"
        data-testid={testId}
      >
        {tiles.map((t) => (
          <img
            key={t.key}
            src={tileUrl(provider, ((t.x % n) + n) % n, t.y, z)}
            alt=""
            draggable={false}
            className="pointer-events-none absolute size-64 max-w-none"
            style={{ left: t.x * TILE - left, top: t.y * TILE - top }}
          />
        ))}
        {marker && (
          <MapPin
            className="pointer-events-none absolute size-9 -translate-x-1/2 -translate-y-full fill-clay text-card drop-shadow"
            style={{ left: marker.x - left, top: marker.y - top }}
            aria-hidden
            data-testid={`${testId}-marker`}
          />
        )}
        <div className="absolute top-2 right-2 flex flex-col gap-1" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
          <button type="button" className={btn} onClick={() => setZ((v) => Math.min(MAX_Z, v + 1))} disabled={z >= MAX_Z} aria-label="放大">
            <Plus className="size-4" />
          </button>
          <button type="button" className={btn} onClick={() => setZ((v) => Math.max(MIN_Z, v - 1))} disabled={z <= MIN_Z} aria-label="缩小">
            <Minus className="size-4" />
          </button>
          <button type="button" className={btn} onClick={() => value && setCenter(toShow(value))} disabled={!value} aria-label="回到选的点">
            <Crosshair className="size-4" />
          </button>
        </div>
        <span className="pointer-events-none absolute right-1 bottom-0.5 rounded bg-card/80 px-1 text-[12px] text-ink-3">{amap ? '© 高德地图' : '© OpenStreetMap'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span>微调（每次 {NUDGE_M} 米）</span>
        {(
          [
            ['向北', 0, 1, ArrowUp],
            ['向南', 0, -1, ArrowDown],
            ['向西', -1, 0, ArrowLeft],
            ['向东', 1, 0, ArrowRight],
          ] as const
        ).map(([label, e, nn, Icon]) => (
          <button key={label} type="button" className={cn(btn, 'size-8')} onClick={() => nudge(e, nn)} disabled={!value} aria-label={label} title={label} data-testid={`${testId}-nudge-${label}`}>
            <Icon className="size-4" />
          </button>
        ))}
        <span className="text-ink-4">拖动地图看周围，点一下把打卡点放在那里</span>
      </div>
    </div>
  );
}
