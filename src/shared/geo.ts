// 打卡点选点的地图（店主 2026-11-24《考勤排班功能优化需求说明》第 1 条）：坐标换算与瓦片编号，页面与服务端共用。
// 打卡点存的是手机定位给的 WGS-84（打卡判定照旧按它算距离，不改）。高德的地址搜索结果与地图底图是 GCJ-02（国内地图的加偏坐标），
// 进来换成 WGS-84、画到高德底图上时再换回 GCJ-02；OpenStreetMap 本来就是 WGS-84，不用换。

export type LatLng = { lat: number; lng: number };

/** 地址搜索的一条结果（已经换成 WGS-84） */
export interface GeoPlace {
  name: string;
  address: string;
  lat: number;
  lng: number;
}
/** 页面要知道的：用哪家的底图、能不能搜 */
export interface GeoInfo {
  provider: 'amap' | 'osm' | 'mock' | 'off';
}

const A = 6378245.0;
const EE = 0.006693421622965943;
const outOfChina = (p: LatLng) => p.lng < 72.004 || p.lng > 137.8347 || p.lat < 0.8293 || p.lat > 55.8271;
function transformLat(x: number, y: number) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}
function transformLng(x: number, y: number) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return r;
}
function delta(p: LatLng): LatLng {
  let dLat = transformLat(p.lng - 105.0, p.lat - 35.0);
  let dLng = transformLng(p.lng - 105.0, p.lat - 35.0);
  const radLat = (p.lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: dLat, lng: dLng };
}

/** WGS-84（手机定位）→ GCJ-02（国内地图）；国外的不变 */
export function wgs84ToGcj02(p: LatLng): LatLng {
  if (outOfChina(p)) return p;
  const d = delta(p);
  return { lat: p.lat + d.lat, lng: p.lng + d.lng };
}

/** GCJ-02 → WGS-84：迭代几次反算，误差在厘米级（打卡半径是几十上百米） */
export function gcj02ToWgs84(p: LatLng): LatLng {
  if (outOfChina(p)) return p;
  let w = { lat: p.lat - delta(p).lat, lng: p.lng - delta(p).lng };
  for (let i = 0; i < 5; i++) {
    const g = wgs84ToGcj02(w);
    w = { lat: w.lat + (p.lat - g.lat), lng: w.lng + (p.lng - g.lng) };
  }
  return w;
}

/** 地图瓦片（Web 墨卡托）：经纬度 ↔ 第 z 级的像素坐标（每块瓦片 256 像素） */
export function toPixel(p: LatLng, z: number): { x: number; y: number } {
  const scale = 256 * 2 ** z;
  const sin = Math.sin((Math.max(-85.05, Math.min(85.05, p.lat)) * Math.PI) / 180);
  return { x: ((p.lng + 180) / 360) * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
}
export function fromPixel(x: number, y: number, z: number): LatLng {
  const scale = 256 * 2 ** z;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng };
}

/** 两点距离（米），与打卡判定同一个算法量级，只用来在页面上写「挪了几米」 */
export function metersBetween(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
