// OA-16 群管理与部门群（docs/OA.md 第 19 节；需求文档六（三））。
//   · 群主、管理员：拉人（连自己最多 500 人）、改群名、发群公告；群主：设 / 撤管理员、转让群主、解散。踢人：群主踢管理员和成员，管理员只踢成员。
//   · 部门群：管组织架构的人或部门主管一键建（本部门在职员工按部门进群，建的人是群主）；之后跟着岗位、离职自动进出（迁移 224 的触发器）。
//     按部门进来的人不能被踢、不能自己退。
//   · 不带操作编号：都按「结果是什么」写，重复做直接算成功、不重复留提示（OA20）；解散了的群不能再管。
// 加锁（docs/LOCKING.md「即时通讯」）：会话行（FOR UPDATE，与发消息同一把锁）→ 成员行 → 系统提示消息；拉人、建部门群在会话行之前先拿成员同步锁（lockMembershipSync）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IM_GROUP_MAX, IM_GROUP_NAME_MAX, IM_NOTICE_MAX, canKick, canManageGroup, type ImConversationDetail, type ImMemberSource, type ImRole } from '@shared/oa-im';
import { can } from '@shared/permissions';
import type { OrgDepartment } from '@shared/positions';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import type { Actor, Deps } from '../../lib/context';
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { writeAudit } from '../../lib/audit';
import { assertGroupQuota, detailOf, employeeOnly, insertMessage, lockMembershipSync, onDuty, onDutyIds } from './im';
import { verifiedHeads } from './directory';

const MembersInput = z.object({ staffIds: z.array(z.number().int().positive()).min(1, '请选要拉进群的人').max(IM_GROUP_MAX) });
const MemberParams = z.object({ id: z.coerce.number().int().positive(), staffId: z.coerce.number().int().positive() });
const RoleInput = z.object({ role: z.enum(['admin', 'member']) });
const TransferInput = z.object({ staffId: z.number().int().positive() });
const NameInput = z.object({ name: z.string().trim().min(1, '请填写群名').max(IM_GROUP_NAME_MAX, `群名最多 ${IM_GROUP_NAME_MAX} 个字`) });
const NoticeInput = z.object({ notice: z.string().trim().max(IM_NOTICE_MAX, `群公告最多 ${IM_NOTICE_MAX} 个字`) });
const DeptGroupInput = z.object({ deptKey: z.string().min(1).max(40) });

type Group = { name: string; deptKey: string | null; myRole: ImRole };

/** 锁住群（与发消息同一把锁）、核对我在群里、群没解散；不是群聊、不在群里的一律当不存在 */
async function lockGroup(tx: Tx, id: number, me: number, opts: { allowDissolved?: boolean } = {}): Promise<Group & { dissolved: boolean }> {
  const [c] = await tx<{ kind: 'direct' | 'group'; name: string | null; deptKey: string | null; dissolved: boolean }[]>`
    SELECT kind, name, dept_key, dissolved_at IS NOT NULL AS dissolved FROM oa_im_conversations WHERE id = ${id} FOR UPDATE`;
  const [m] = await tx<{ role: ImRole }[]>`SELECT role FROM oa_im_members WHERE conversation_id = ${id} AND staff_id = ${me} AND left_at IS NULL`;
  if (!c || !m) throw notFound('会话不存在或你已经不在这个群里');
  if (c.kind !== 'group') throw unprocessable('GROUP_ONLY', '单聊没有群管理');
  if (c.dissolved && !opts.allowDissolved) throw unprocessable('GROUP_DISSOLVED', '这个群已经解散');
  return { name: c.name ?? '', deptKey: c.deptKey, myRole: m.role, dissolved: c.dissolved };
}

function needManager(g: Group) {
  if (!canManageGroup(g.myRole)) throw forbidden('只有群主和管理员能做这件事');
}
function needOwner(g: Group) {
  if (g.myRole !== 'owner') throw forbidden('只有群主能做这件事');
}

async function memberRow(tx: Tx, id: number, staffId: number) {
  const [m] = await tx<{ role: ImRole; source: ImMemberSource; name: string }[]>`
    SELECT m.role, m.source, s.display_name AS name FROM oa_im_members m JOIN staff s ON s.id = m.staff_id
    WHERE m.conversation_id = ${id} AND m.staff_id = ${staffId} AND m.left_at IS NULL`;
  return m ?? null;
}

/** 拉人进群（已经在的跳过）；退过群的回来，读到的位置记在最新一条（不带一堆积压的未读）；返回真正新进的人的名字 */
async function addMembers(tx: Tx, id: number, ids: readonly number[], source: ImMemberSource): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await tx<{ name: string }[]>`
    WITH last AS (SELECT COALESCE(last_message_id, 0) AS id FROM oa_im_conversations WHERE id = ${id}),
    upserted AS (
      INSERT INTO oa_im_members (conversation_id, staff_id, role, source, last_read_message_id)
      SELECT ${id}, x, 'member', ${source}, (SELECT id FROM last) FROM unnest(${[...ids]}::bigint[]) AS t(x)
      ON CONFLICT (conversation_id, staff_id) DO UPDATE
        SET left_at = NULL, role = 'member', source = EXCLUDED.source, joined_at = now(),
            last_read_message_id = GREATEST(oa_im_members.last_read_message_id, EXCLUDED.last_read_message_id)
        WHERE oa_im_members.left_at IS NOT NULL
      RETURNING staff_id)
    SELECT s.display_name AS name FROM upserted u JOIN staff s ON s.id = u.staff_id ORDER BY u.staff_id`;
  return rows.map((r) => r.name);
}

/** 群里没有群主时让这个人接任（会话行已经锁着）；返回接没接 */
async function ensureOwner(tx: Tx, id: number, staffId: number): Promise<boolean> {
  const rows = await tx`
    UPDATE oa_im_members SET role = 'owner' WHERE conversation_id = ${id} AND staff_id = ${staffId} AND left_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM oa_im_members WHERE conversation_id = ${id} AND left_at IS NULL AND role = 'owner')
    RETURNING staff_id`;
  return rows.length > 0;
}

async function memberCount(tx: Tx, id: number): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM oa_im_members WHERE conversation_id = ${id} AND left_at IS NULL`;
  return r!.n;
}

const names = (xs: readonly string[]) => (xs.length > 3 ? `${xs.slice(0, 3).join('、')}等 ${xs.length} 人` : xs.join('、'));

/** 部门群能不能建：管组织架构的人，或这个部门实际的主管 */
export async function canCreateDeptGroup(db: Db, actor: Actor, dept: OrgDepartment): Promise<boolean> {
  if (can(actor, 'hr.org') || can(actor, 'staff.manage')) return true;
  // 只认核实过的主管：自己选成负责人、后台还没核实的不能建 / 打开部门群（Codex 安全审查 ae2d4b6）
  return (await verifiedHeads(db)).get(dept) === actor.id;
}

export function registerOaImGroupRoutes(app: FastifyInstance, { sql }: Deps) {
  const auth = employeeOnly(sql);
  const after = (id: number, me: number): Promise<ImConversationDetail> => detailOf(sql, id, me);

  // 拉人：群主、管理员；只拉在职员工；连自己最多 500 人；已经在群里的跳过
  app.post('/api/oa/im/conversations/:id/members', { preHandler: auth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(MembersInput, req.body);
    const me = req.actor;
    await sql.begin(async (tx) => {
      // 成员同步锁在会话行锁之前（与触发器同一个顺序）：核对在职与写成员之间，别人办不了这几个人的离职（Codex 审查 ae2d4b6）
      await lockMembershipSync(tx);
      const g = await lockGroup(tx, id, me.id);
      needManager(g);
      const wanted = [...new Set(input.staffIds.filter((x) => x !== me.id))];
      const ok = await onDutyIds(tx, wanted);
      if (ok.length !== wanted.length) throw unprocessable('MEMBER_INVALID', '有人不存在或已经离职，请刷新后重选');
      const added = await addMembers(tx, id, ok, 'manual');
      if (!added.length) return;
      if ((await memberCount(tx, id)) > IM_GROUP_MAX) throw unprocessable('GROUP_TOO_LARGE', `一个群最多 ${IM_GROUP_MAX} 人`);
      await insertMessage(tx, id, me.id, { kind: 'system', body: `${me.displayName}邀请${names(added)}加入了群聊` });
    });
    return after(id, me.id);
  });

  // 踢人：群主踢管理员与成员，管理员只踢成员；部门群里按部门进来的不能踢；已经不在的直接算成功
  app.post('/api/oa/im/conversations/:id/members/:staffId/remove', { preHandler: auth }, async (req) => {
    const { id, staffId } = parse(MemberParams, req.params);
    const me = req.actor;
    await sql.begin(async (tx) => {
      const g = await lockGroup(tx, id, me.id);
      needManager(g);
      const target = await memberRow(tx, id, staffId);
      if (!target) return;
      if (target.source === 'dept' && staffId !== me.id) throw unprocessable('IM_DEPT_MEMBER', '这是部门群，本部门的人不能移出；调到别的部门会自动出群');
      if (!canKick({ staffId: me.id, role: g.myRole }, { staffId, name: target.name, role: target.role, source: target.source })) {
        throw forbidden(staffId === me.id ? '不能把自己移出群，要走请点「退出群聊」' : '管理员只能移出普通成员');
      }
      await tx`UPDATE oa_im_members SET left_at = now(), role = 'member' WHERE conversation_id = ${id} AND staff_id = ${staffId}`;
      await insertMessage(tx, id, me.id, { kind: 'system', body: `${me.displayName}把${target.name}移出了群聊` });
    });
    return after(id, me.id);
  });

  // 设 / 撤管理员：群主；对象要是现在的成员（不是群主）；已经是这个身份的直接算成功
  app.put('/api/oa/im/conversations/:id/members/:staffId/role', { preHandler: auth }, async (req) => {
    const { id, staffId } = parse(MemberParams, req.params);
    const { role } = parse(RoleInput, req.body);
    const me = req.actor;
    await sql.begin(async (tx) => {
      const g = await lockGroup(tx, id, me.id);
      needOwner(g);
      const target = await memberRow(tx, id, staffId);
      if (!target) throw notFound('这位同事不在群里');
      if (target.role === 'owner') throw unprocessable('IM_OWNER_ROLE', '群主的身份要用「转让群主」改');
      if (target.role === role) return;
      await tx`UPDATE oa_im_members SET role = ${role} WHERE conversation_id = ${id} AND staff_id = ${staffId}`;
      await insertMessage(tx, id, me.id, {
        kind: 'system',
        body: role === 'admin' ? `${me.displayName}把${target.name}设为管理员` : `${me.displayName}取消了${target.name}的管理员`,
      });
    });
    return after(id, me.id);
  });

  // 转让群主：群主转给现在的一位成员；原群主变成普通成员
  app.post('/api/oa/im/conversations/:id/transfer', { preHandler: auth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { staffId } = parse(TransferInput, req.body);
    const me = req.actor;
    await sql.begin(async (tx) => {
      const g = await lockGroup(tx, id, me.id);
      const target = await memberRow(tx, id, staffId);
      // 已经转给他了（结果不确定以后重试）：直接算成功
      if (target?.role === 'owner' && g.myRole !== 'owner') return;
      needOwner(g);
      if (staffId === me.id) throw unprocessable('IM_TRANSFER_SELF', '请选另一位成员');
      if (!target) throw notFound('这位同事不在群里');
      if (!(await onDutyIds(tx, [staffId])).length) throw unprocessable('MEMBER_INVALID', '这位同事已经离职');
      await tx`UPDATE oa_im_members SET role = 'member' WHERE conversation_id = ${id} AND staff_id = ${me.id}`;
      await tx`UPDATE oa_im_members SET role = 'owner' WHERE conversation_id = ${id} AND staff_id = ${staffId}`;
      await insertMessage(tx, id, me.id, { kind: 'system', body: `${me.displayName}把群主转给了${target.name}` });
    });
    return after(id, me.id);
  });

  // 改群名：群主、管理员；一样的名字直接算成功
  app.put('/api/oa/im/conversations/:id/name', { preHandler: auth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { name } = parse(NameInput, req.body);
    const me = req.actor;
    await sql.begin(async (tx) => {
      const g = await lockGroup(tx, id, me.id);
      needManager(g);
      if (g.name === name) return;
      await tx`UPDATE oa_im_conversations SET name = ${name} WHERE id = ${id}`;
      await insertMessage(tx, id, me.id, { kind: 'system', body: `${me.displayName}把群名改为「${name}」` });
    });
    return after(id, me.id);
  });

  // 群公告：群主、管理员；空的就是清掉；一样的直接算成功
  app.put('/api/oa/im/conversations/:id/notice', { preHandler: auth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { notice } = parse(NoticeInput, req.body);
    const me = req.actor;
    await sql.begin(async (tx) => {
      const g = await lockGroup(tx, id, me.id);
      needManager(g);
      const [c] = await tx<{ notice: string | null }[]>`SELECT notice FROM oa_im_conversations WHERE id = ${id}`;
      if ((c!.notice ?? '') === notice) return;
      await tx`
        UPDATE oa_im_conversations SET notice = ${notice || null}, notice_by = ${notice ? me.id : null}, notice_at = ${notice ? tx`now()` : null}
        WHERE id = ${id}`;
      await insertMessage(tx, id, me.id, { kind: 'system', body: notice ? `${me.displayName}更新了群公告：${notice.slice(0, 60)}` : `${me.displayName}清除了群公告` });
    });
    return after(id, me.id);
  });

  // 解散：群主；之后不能再发、不能再管，历史照留；已经解散的直接算成功
  app.post('/api/oa/im/conversations/:id/dissolve', { preHandler: auth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const me = req.actor;
    await sql.begin(async (tx) => {
      const g = await lockGroup(tx, id, me.id, { allowDissolved: true });
      if (g.dissolved) return;
      needOwner(g);
      await insertMessage(tx, id, me.id, { kind: 'system', body: `${me.displayName}解散了群聊` });
      await tx`UPDATE oa_im_conversations SET dissolved_at = now() WHERE id = ${id}`;
      await writeAudit(tx, { staffId: me.id, action: 'oa_im_group_dissolved', targetType: 'oa_im_conversation', targetId: id, detail: { name: g.name }, ip: req.ip });
    });
    return after(id, me.id);
  });

  // 建部门群：管组织架构的人或部门主管；本部门在职员工按部门进群，建的人是群主；已经有没解散的部门群就打开那个（不另建）
  app.post('/api/oa/im/dept-groups', { preHandler: auth }, async (req, reply): Promise<{ id: number; created: boolean }> => {
    const { deptKey } = parse(DeptGroupInput, req.body);
    const me = req.actor;
    const [dept] = await sql<{ key: OrgDepartment; name: string }[]>`SELECT key, name FROM org_departments WHERE key = ${deptKey}`;
    if (!dept) throw notFound('部门不存在');
    if (!(await canCreateDeptGroup(sql, me, dept.key))) throw forbidden('只有管组织架构的人或这个部门的主管能建部门群');
    const existing = async () => {
      const [c] = await sql<{ id: number }[]>`SELECT id FROM oa_im_conversations WHERE dept_key = ${deptKey} AND dissolved_at IS NULL`;
      return c ? Number(c.id) : null;
    };
    const had = await existing();
    if (had) return openExisting(had);
    try {
      const id = await sql.begin(async (tx) => {
        // 与部门群同步串行（Codex 审查 1adec4f）：等在途的调岗、离职提交以后再读名单，之后开始的要等这个群建好，触发器就看得到它
        await lockMembershipSync(tx);
        await assertGroupQuota(tx, me.id);
        // 部门成员按岗位来（与组织架构、触发器同一个算法）；自己选的岗位、后台没核实的不自动进（Codex 安全审查 1adec4f）
        const rows = await tx<{ id: number }[]>`
          SELECT s.id FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
          WHERE ${onDuty(tx)} AND s.position IS NOT NULL AND s.position_chosen_at IS NULL
            AND CASE WHEN s.position = 'president' THEN 'company' WHEN s.position = 'gmo' THEN 'gmo' ELSE split_part(s.position, '.', 1) END = ${deptKey}
          ORDER BY s.id`;
        const deptIds = rows.map((r) => Number(r.id));
        if (deptIds.length + (deptIds.includes(me.id) ? 0 : 1) > IM_GROUP_MAX) throw unprocessable('GROUP_TOO_LARGE', `一个群最多 ${IM_GROUP_MAX} 人`);
        const name = `${dept.name}群`.slice(0, IM_GROUP_NAME_MAX);
        const [c] = await tx<{ id: number }[]>`
          INSERT INTO oa_im_conversations (kind, name, created_by, dept_key) VALUES ('group', ${name}, ${me.id}, ${deptKey}) RETURNING id`;
        const convId = Number(c!.id);
        await tx`
          INSERT INTO oa_im_members (conversation_id, staff_id, role, source)
          SELECT ${convId}, x, CASE WHEN x = ${me.id} THEN 'owner' ELSE 'member' END,
                 CASE WHEN x = ANY(${deptIds}::bigint[]) THEN 'dept' ELSE 'manual' END
          FROM unnest(${[...new Set([me.id, ...deptIds])]}::bigint[]) AS t(x)`;
        await insertMessage(tx, convId, me.id, { kind: 'system', body: `${me.displayName}创建了部门群「${name}」，本部门的同事已自动加入` });
        await writeAudit(tx, { staffId: me.id, action: 'oa_im_dept_group_created', targetType: 'oa_im_conversation', targetId: convId, detail: { deptKey }, ip: req.ip });
        return convId;
      });
      reply.code(201);
      return { id, created: true };
    } catch (error) {
      // 两个人同时建：后到的打开先建好的那个
      if (isUniqueViolation(error, 'oa_im_conversations_dept_uq')) {
        const now = await existing();
        if (now) return openExisting(now);
      }
      throw error;
    }

    // 已经有了：我在群里就打开；不在（比如管组织架构的人不是本部门的）拉我进去，再打开
    async function openExisting(id: number): Promise<{ id: number; created: boolean }> {
      await sql.begin(async (tx) => {
        await lockMembershipSync(tx);
        await tx`SELECT 1 FROM oa_im_conversations WHERE id = ${id} FOR UPDATE`;
        const added = await addMembers(tx, id, [me.id], 'manual');
        // 部门群里的人都走光了、没有群主（Codex 审查 1adec4f）：能建部门群的人点进来就接任群主
        const owner = await ensureOwner(tx, id, me.id);
        if (!added.length && !owner) return;
        if ((await memberCount(tx, id)) > IM_GROUP_MAX) throw unprocessable('GROUP_TOO_LARGE', `一个群最多 ${IM_GROUP_MAX} 人`);
        if (added.length) await insertMessage(tx, id, me.id, { kind: 'system', body: `${me.displayName}加入了群聊` });
        if (owner) await insertMessage(tx, id, me.id, { kind: 'system', body: `${me.displayName}成为群主` });
      });
      return { id, created: false };
    }
  });
}
