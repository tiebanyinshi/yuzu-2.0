// OA-16 通讯录（docs/OA.md 第 19 节；需求文档六（二））：员工端「办公 → 通讯录」。
//   · 在职员工都能看（与即时通讯同一个名单），全公司一份、不分门店；部门按组织架构的上下级排成树，员工按岗位归部门。
//   · 手机号可见范围（OA19，经营设置 oa_directory_phone）：主管以上（默认）/ 所有员工 / 只有管组织架构的人；自己的总能看，看不到的给打码的。
//   · 每个部门标出有没有部门群、我能不能建（建群接口在 im-groups.ts）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_DIRECTORY_PHONE_SCOPE, maskPhone, type Directory, type DirectoryDepartment, type DirectoryPerson, type DirectoryPhoneScope } from '@shared/oa-directory';
import { positionLabel, type OrgDepartment } from '@shared/positions';
import type { Db } from '../../db';
import { guardAny } from '../../auth/guard';
import type { Actor, Deps } from '../../lib/context';
import { writeAudit } from '../../lib/audit';
import { forbidden } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { employeeOnly } from './im';
import { loadOrg, managesOrg } from './org';

const SETTING_KEY = 'oa_directory_phone';
const SettingsInput = z.object({ phoneScope: z.enum(['managers', 'all', 'hr']) });

async function phoneScopeOf(db: Db): Promise<DirectoryPhoneScope> {
  const [row] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${SETTING_KEY}`;
  const v = row?.value;
  return v === 'managers' || v === 'all' || v === 'hr' ? v : DEFAULT_DIRECTORY_PHONE_SCOPE;
}

/**
 * 核实过的部门主管（Codex 安全审查 ae2d4b6）：后台指定的主管，或者岗位是后台给的（不是自己选的、还没核实的）负责人。
 * OA-16 里由主管身份得来的权限（看手机号、建部门群）只认这些人；自己选成负责人的不算，等后台核实。
 */
export async function verifiedHeads(db: Db, org?: Awaited<ReturnType<typeof loadOrg>>): Promise<Map<OrgDepartment, number>> {
  const o = org ?? (await loadOrg(db));
  const selfChosen = new Set((await db<{ id: number }[]>`SELECT id FROM staff WHERE position_chosen_at IS NOT NULL`).map((r) => Number(r.id)));
  const out = new Map<OrgDepartment, number>();
  for (const d of o.departments) if (d.head && (d.head.designated || !selfChosen.has(d.head.id))) out.set(d.key, d.head.id);
  return out;
}

export async function loadDirectory(db: Db, actor: Actor): Promise<Directory> {
  const org = await loadOrg(db);
  const phoneScope = await phoneScopeOf(db);
  const verified = await verifiedHeads(db, org);
  const heads = new Map<number, OrgDepartment[]>();
  for (const d of org.departments) if (d.head) heads.set(d.head.id, [...(heads.get(d.head.id) ?? []), d.key]);
  // 看手机号、建部门群只认核实过的主管（资料卡上「主管」照组织架构显示）
  const isHead = [...verified.values()].includes(actor.id);
  const manager = await managesOrg(db, actor);
  const canSeePhones = phoneScope === 'all' || manager || (phoneScope === 'managers' && isHead);
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
      canCreateGroup: manager || verified.get(d.key) === actor.id,
    };
  });
  return { departments, people, phoneScope, canSeePhones, canConfigure: manager };
}

export function registerOaDirectoryRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/oa/directory', { preHandler: employeeOnly(sql) }, async (req) => loadDirectory(sql, req.actor));

  // 手机号可见范围：管组织架构的人改
  app.put('/api/oa/directory/settings', { preHandler: guardAny('hr.org', 'staff.manage') }, async (req) => {
    const { phoneScope } = parse(SettingsInput, req.body);
    if (!(await managesOrg(sql, req.actor))) throw forbidden('你的岗位还没由后台核实，不能改手机号可见范围');
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${SETTING_KEY}, ${tx.json(phoneScope)}, now(), ${req.actor.id})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'oa_directory_settings_saved', targetType: 'settings', targetId: SETTING_KEY, detail: { phoneScope }, ip: req.ip });
    });
    return { phoneScope };
  });
}
