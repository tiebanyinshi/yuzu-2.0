// 数据库评估（8.1.47）的两处配置：迁移等锁的上限（MIGRATION_LOCK_TIMEOUT）、热表归档的保留天数（ARCHIVE_*_DAYS）。不要数据库，秒级。
import { describe, expect, it } from 'vitest';
import { loadArchiveConfig } from '../src/server/config';
import { migrationLockTimeout } from '../src/server/migrate';

describe('迁移等锁的上限', () => {
  it('默认 30 秒；认 PostgreSQL 的时长写法；写错的按默认（不拼进 SQL）', () => {
    expect(migrationLockTimeout(undefined)).toBe('30s');
    expect(migrationLockTimeout('2min')).toBe('2min');
    expect(migrationLockTimeout(' 500ms ')).toBe('500ms');
    expect(migrationLockTimeout('0')).toBe('0');
    expect(migrationLockTimeout("1s'; DROP TABLE x; --")).toBe('30s');
  });
});

describe('热表归档的保留天数', () => {
  it('默认 180 / 180 / 365；0 = 不归档；少于 30 天、不是整数的拒绝', () => {
    expect(loadArchiveConfig({})).toEqual({ locationDays: 180, integrationCallDays: 180, wecomPushDays: 365 });
    expect(loadArchiveConfig({ ARCHIVE_LOCATION_DAYS: '0', ARCHIVE_INTEGRATION_CALL_DAYS: '90', ARCHIVE_WECOM_PUSH_DAYS: '30' })).toEqual({
      locationDays: 0,
      integrationCallDays: 90,
      wecomPushDays: 30,
    });
    expect(() => loadArchiveConfig({ ARCHIVE_LOCATION_DAYS: '7' })).toThrow(/至少 30 天/);
    expect(() => loadArchiveConfig({ ARCHIVE_WECOM_PUSH_DAYS: '1.5' })).toThrow(/整数/);
  });
});
