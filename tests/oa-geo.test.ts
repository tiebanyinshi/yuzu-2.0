// 考勤排班优化第 1 条（店主 2026-11-24）：打卡点「搜索地址选点」——坐标换算（高德 GCJ-02 ↔ 手机定位 WGS-84）与服务端代查的接口。
// 打卡点存的、打卡判定用的照旧是 WGS-84；这里只验证换算准、接口只给管考勤的人、关掉时写明怎么办。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromPixel, gcj02ToWgs84, metersBetween, toPixel, wgs84ToGcj02, type GeoPlace } from '../src/shared/geo';
import { loadGeoConfig } from '../src/server/config';
import { api, setup, type TestContext } from './helpers';

describe('坐标换算', () => {
  it('WGS-84 → GCJ-02 在国内偏几百米，反算回来误差不到 1 米；国外不换', () => {
    for (const p of [
      { lat: 31.230416, lng: 121.473701 }, // 上海
      { lat: 39.908692, lng: 116.397477 }, // 北京
      { lat: 22.543096, lng: 114.057865 }, // 深圳
    ]) {
      const g = wgs84ToGcj02(p);
      const off = metersBetween(p, g);
      expect(off).toBeGreaterThan(100);
      expect(off).toBeLessThan(800);
      expect(metersBetween(gcj02ToWgs84(g), p)).toBeLessThan(1);
    }
    const tokyo = { lat: 35.6762, lng: 139.6503 };
    expect(wgs84ToGcj02(tokyo)).toEqual(tokyo);
  });

  it('瓦片像素与经纬度互换', () => {
    const p = { lat: 31.230416, lng: 121.473701 };
    const px = toPixel(p, 17);
    const back = fromPixel(px.x, px.y, 17);
    expect(metersBetween(back, p)).toBeLessThan(0.01);
  });

  it('选哪家：有高德 key 用高德；测试环境默认关；mock 只在开发、测试；指定高德没 key 起不来', () => {
    expect(loadGeoConfig({ AMAP_WEB_KEY: 'k' } as NodeJS.ProcessEnv, 'production')).toEqual({ provider: 'amap', amapKey: 'k' });
    expect(loadGeoConfig({} as NodeJS.ProcessEnv, 'production').provider).toBe('osm');
    expect(loadGeoConfig({} as NodeJS.ProcessEnv, 'test').provider).toBe('off');
    expect(loadGeoConfig({ GEO_PROVIDER: 'mock' } as NodeJS.ProcessEnv, 'development').provider).toBe('mock');
    expect(() => loadGeoConfig({ GEO_PROVIDER: 'mock' } as NodeJS.ProcessEnv, 'production')).toThrow();
    expect(() => loadGeoConfig({ GEO_PROVIDER: 'amap' } as NodeJS.ProcessEnv, 'production')).toThrow();
  });
});

describe('搜索地址的接口', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => ctx.close());

  it('关着：写明用定位或手输；开着（模拟）：给出 WGS-84 的地址；只给管考勤的人；关键词至少两个字', async () => {
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/geo')).body).toEqual({ provider: 'off' });
    const off = await api(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/geo/search?q=${encodeURIComponent('演示门店')}`);
    expect(off.status).toBe(503);
    expect(off.body.error).toMatchObject({ code: 'GEO_UNAVAILABLE' });
    expect(off.body.error.message).toContain('定位当前位置');
    ctx.config.geo.provider = 'mock';
    try {
      const r = await api(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/geo/search?q=${encodeURIComponent('演示门店')}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const places = (r.body as { places: GeoPlace[] }).places;
      expect(places.length).toBeGreaterThan(0);
      expect(places[0]).toMatchObject({ name: expect.any(String), lat: expect.any(Number), lng: expect.any(Number) });
      expect((await api(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/geo/search?q=a')).status).toBe(400);
      // 没有考勤管理权限的：拒绝
      expect((await api(ctx.app, ctx.clerk, 'GET', `/api/oa/attendance/geo/search?q=${encodeURIComponent('演示门店')}`)).status).toBe(403);
      expect((await api(ctx.app, ctx.clerk, 'GET', '/api/oa/attendance/geo')).status).toBe(403);
    } finally {
      ctx.config.geo.provider = 'off';
    }
  });
});
