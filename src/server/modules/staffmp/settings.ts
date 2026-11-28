// 员工小程序的开关（docs/STAFF_MP.md 第 8.3 节，SP12）：存在 settings 的 staffmp 一项，默认开（docs/CONVENTIONS.md 第 1 节）。
// 关了以后员工小程序端口上除了「info」都回「暂停使用」，已登录的也用不了；端口开不开另看 STAFFMP_PORT。

import type { Db } from '../../db';

export async function loadStaffMpEnabled(db: Db): Promise<boolean> {
  const [row] = await db<{ value: { enabled?: unknown } | null }[]>`SELECT value FROM settings WHERE key = 'staffmp'`;
  return row?.value?.enabled !== false;
}

export async function saveStaffMpEnabled(db: Db, enabled: boolean, staffId: number): Promise<void> {
  await db`
    INSERT INTO settings (key, value, updated_by) VALUES ('staffmp', ${db.json({ enabled })}, ${staffId})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
}
