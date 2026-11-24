// 打卡点「搜索地址选点」（店主 2026-11-24《考勤排班功能优化需求说明》第 1 条）：后台「考勤设置 → 打卡点」里输关键词搜地址，
// 在地图上选点写入经纬度。搜索由服务端代查（key 不进页面），结果一律换成手机定位用的 WGS-84——打卡点存的、打卡判定用的照旧是 WGS-84，不改。
//   · amap：高德 Web 服务「关键字搜索」（AMAP_WEB_KEY），结果是 GCJ-02，换成 WGS-84；
//   · osm：OpenStreetMap Nominatim（不用 key）；
//   · mock：开发、测试环境的假数据（不出网）；off：不能搜。
// 只读、不进事务；对外调用有超时，失败时写明「用定位当前位置或手输经纬度」。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { gcj02ToWgs84, type GeoInfo, type GeoPlace } from '@shared/geo';
import { guard } from '../../auth/guard';
import type { Deps } from '../../lib/context';
import { AppError } from '../../lib/errors';
import { parse } from '../../lib/validate';

const manage = guard('hr.attendance');
const SEARCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 8;

const SearchQuery = z.object({
  q: z.string('请输入要搜的地址').trim().min(2, '至少输两个字').max(60, '最多 60 个字'),
  /** 城市（高德按城市搜得更准；不填全国） */
  city: z.string().trim().max(20).optional(),
});

const unavailable = (why: string) => new AppError(503, 'GEO_UNAVAILABLE', `${why}：请用「定位当前位置」或手动填写经纬度`);

/** 开发、测试环境的假数据：门店附近的两三个点 */
const MOCK: GeoPlace[] = [
  { name: '演示门店正门', address: '演示路 1 号', lat: 31.230416, lng: 121.473701 },
  { name: '演示门店停车场', address: '演示路 1 号地下', lat: 31.2309, lng: 121.4742 },
  { name: '演示员工通道', address: '演示路 3 号', lat: 31.2298, lng: 121.4731 },
];

async function searchAmap(key: string, q: string, city?: string): Promise<GeoPlace[]> {
  const url = new URL('https://restapi.amap.com/v3/place/text');
  url.searchParams.set('key', key);
  url.searchParams.set('keywords', q);
  url.searchParams.set('offset', String(MAX_RESULTS));
  url.searchParams.set('extensions', 'base');
  if (city) url.searchParams.set('city', city);
  const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw unavailable(`高德地址搜索出错（${res.status}）`);
  const body = (await res.json()) as {
    status?: string;
    info?: string;
    pois?: { name?: string; address?: string | unknown[]; pname?: string; cityname?: string; adname?: string; location?: string }[];
  };
  if (body.status !== '1') throw unavailable(`高德地址搜索没成功（${body.info ?? '未知原因'}）`);
  return (body.pois ?? [])
    .map((p) => {
      const [lng, lat] = (p.location ?? '').split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const w = gcj02ToWgs84({ lat: lat!, lng: lng! });
      const addr = [p.pname, p.cityname, p.adname, typeof p.address === 'string' ? p.address : ''].filter((x, i, a) => x && a.indexOf(x) === i).join('');
      return { name: String(p.name ?? ''), address: addr, lat: Number(w.lat.toFixed(6)), lng: Number(w.lng.toFixed(6)) };
    })
    .filter((p): p is GeoPlace => !!p && !!p.name);
}

async function searchOsm(q: string): Promise<GeoPlace[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(MAX_RESULTS));
  url.searchParams.set('accept-language', 'zh-CN');
  // Nominatim 要求带上可识别的客户端名；不带门店、个人信息
  const res = await fetch(url, { headers: { 'user-agent': 'yuzu-attendance-location-picker' }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw unavailable(`地址搜索出错（${res.status}）`);
  const body = (await res.json()) as { name?: string; display_name?: string; lat?: string; lon?: string }[];
  return body
    .map((p) => ({ name: p.name || (p.display_name ?? '').split(',')[0]!.trim(), address: p.display_name ?? '', lat: Number(Number(p.lat).toFixed(6)), lng: Number(Number(p.lon).toFixed(6)) }))
    .filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

export function registerOaGeoRoutes(app: FastifyInstance, deps: Deps) {
  const geo = deps.config.geo;
  app.get('/api/oa/attendance/geo', { preHandler: manage }, async (): Promise<GeoInfo> => ({ provider: geo.provider }));

  app.get('/api/oa/attendance/geo/search', { preHandler: manage }, async (req): Promise<{ places: GeoPlace[] }> => {
    const q = parse(SearchQuery, req.query ?? {});
    if (geo.provider === 'off') throw unavailable('这台服务器没开地址搜索');
    if (geo.provider === 'mock')
      return {
        places: MOCK.filter((p) => `${p.name}${p.address}`.includes(q.q.slice(0, 2)))
          .concat(MOCK)
          .slice(0, MAX_RESULTS),
      };
    try {
      return { places: geo.provider === 'amap' ? await searchAmap(geo.amapKey!, q.q, q.city) : await searchOsm(q.q) };
    } catch (e) {
      if (e instanceof AppError) throw e;
      req.log.warn({ err: e }, 'geo search failed');
      throw unavailable('地址搜索连不上或超时了');
    }
  });
}
