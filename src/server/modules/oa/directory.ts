// OA-16 通讯录（docs/OA.md 第 19 节；需求文档六（二））：员工端「办公 → 通讯录」。
//   · 在职员工都能看（与即时通讯同一个名单），全公司一份、不分门店；部门按组织架构的上下级排成树，员工按岗位归部门。
//   · 手机号可见范围（OA19，经营设置 oa_directory_phone）：主管以上（默认）/ 所有员工 / 只有管组织架构的人；自己的总能看，看不到的给打码的。
//   · 每个部门标出有没有部门群、我能不能建（建群接口在 im-groups.ts）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_DIRECTORY_PHONE_SCOPE, maskPhone, type Directory, type DirectoryDepartment, type DirectoryPerson, type DirectoryPhoneScope } from '@shared/oa-directory';
import { can } from '@shared/permissions';
import { positionLabel, type OrgDepartment } from '@shared/positions';
import type { Db } from '../../db';
import { guardAny } from '../../auth/guard';
import type { Actor, Deps } from '../../lib/context';
import { writeAudit } from '../../lib/audit';
import { parse } from '../../lib/validate';
import { employeeOnly } from './im';
import { loadOrg } from './org';

const SETTING_KEY = 'oa_directory_phone';
const SettingsInput = z.object({ phoneScope: z.enum(['managers', 'all', 'hr']) });

const managesOrg = (actor: Actor) => can(actor, 'hr.org') || can(actor, 'staff.manage');

async function phoneScopeOf(db: Db): Promise<DirectoryPhoneScope> {
  const [row] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${SETTING_KEY}`;
  const v = row?.value;
  return v === 'managers' || v === 'all' || v === 'hr' ? v : DEFAULT_DIRECTORY_PHONE_SCOPE;
}

export async function loadDirectory(db: Db, actor: Actor): Promise<Directory> {
  const org = await loadOrg(db);
  const phoneScope = await phoneScopeOf(db);
  const heads = new Map<number, OrgDepartment[]>();
  for (const d of org.departments) if (d.head) heads.set(d.head.id, [...(heads.get(d.head.id) ?? []), d.key]);
  const isHead = heads.has(actor.id);
  const canSeePhones = phoneScope === 'all' || managesOrg(actor) || (phoneScope === 'managers' && isHead);
  const onDuty = org.employees.filter((e) => e.active && e.status === 'active');
  const people = onDuty.map((e): DirectoryPerson => {
    const visible = canSeePhones || e.staffId === actor.id;
    return {
      staffId: e.staffId,
      name: e.name,
      empNo: e.empNo,
      department: e.department,
      position: e.position,
      positionName: positionLabel(e.position),
      phone: e.phone ? (visible ? e.phone : maskPhone(e.phone)) : null,
      phoneMasked: !!e.phone && !visible,
      headOf: heads.get(e.staffId) ?? [],
    };
  });
  // 部门群：没解散的；我在里面才给编号（不在的只标「有」，点了走建群接口：已经有就把能建的人拉进去再打开）
  const groups = await db<{ deptKey: OrgDepartment; id: number; mine: boolean }[]>`
    SELECT c.dept_key, c.id,
           EXISTS (SELECT 1 FROM oa_im_members m WHERE m.conversation_id = c.id AND m.staff_id = ${actor.id} AND m.left_at IS NULL) AS mine
    FROM oa_im_conversations c WHERE c.dept_key IS NOT NULL AND c.dissolved_at IS NULL`;
  const departments = org.departments.map((d): DirectoryDepartment => {
    const g = groups.find((x) => x.deptKey === d.key);
    return {
      key: d.key,
      name: d.name,
      parentKey: d.parentKey,
      headId: d.head?.id ?? null,
      group: g ? { id: g.mine ? Number(g.id) : null } : null,
      canCreateGroup: managesOrg(actor) || d.head?.id === actor.id,
    };
  });
  return { departments, people, phoneScope, canSeePhones, canConfigure: managesOrg(actor) };
}

export function registerOaDirectoryRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/oa/directory', { preHandler: employeeOnly(sql) }, async (req) => loadDirectory(sql, req.actor));

  // 手机号可见范围：管组织架构的人改
  app.put('/api/oa/directory/settings', { preHandler: guardAny('hr.org', 'staff.manage') }, async (req) => {
    const { phoneScope } = parse(SettingsInput, req.body);
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${SETTING_KEY}, ${tx.json(phoneScope)}, now(), ${req.actor.id})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'oa_directory_settings_saved', targetType: 'settings', targetId: SETTING_KEY, detail: { phoneScope }, ip: req.ip });
    });
    return { phoneScope };
  });
}
