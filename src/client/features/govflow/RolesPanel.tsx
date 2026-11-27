// 业财法「角色映射」（店主配置）。8.2.14（《业财法审批与 WCP 需求变更》A1，WB1、WB2）：
//   · 列表带工号（登录账号）与所在部门，同名的人分得清；
//   · 能改：换人、改经营主体范围、改备注（角色本身不能改，要换角色就撤销后新加），改与撤都写原因；
//   · 变更记录：每一条映射的加、改、撤，谁、什么时候、原因；
//   · 改映射不影响已经提交的单（按提交时的快照审批），之后提交的按新的。

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GF_ROLE_LABELS, type GfMeta, type GfRole, type GfRoleChange, type GfRoleMember } from '@shared/govflow';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Select, Skeleton } from '../../components/ui';

const OP_LABELS: Record<GfRoleChange['op'], string> = { add: '新加', edit: '修改', revoke: '撤销' };

export function RolesPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useQuery({ queryKey: ['gf', 'meta'], queryFn: () => api.get<GfMeta>('/api/gf/meta') });
  const q = useQuery({ queryKey: ['gf', 'roles'], queryFn: () => api.get<GfRoleMember[]>('/api/gf/roles') });
  const [showLog, setShowLog] = useState(false);
  const changes = useQuery({ queryKey: ['gf', 'roles', 'changes'], queryFn: () => api.get<GfRoleChange[]>('/api/gf/roles/changes'), enabled: showLog });
  const [role, setRole] = useState<GfRole | ''>('');
  const [staffId, setStaffId] = useState<number | ''>('');
  const [entityId, setEntityId] = useState<number | ''>('');
  const [editing, setEditing] = useState<GfRoleMember | null>(null);
  const [revoking, setRevoking] = useState<GfRoleMember | null>(null);
  const saved = (list: GfRoleMember[]) => {
    qc.setQueryData(['gf', 'roles'], list);
    void qc.invalidateQueries({ queryKey: ['gf', 'meta'] });
    void qc.invalidateQueries({ queryKey: ['gf', 'roles', 'changes'] });
  };
  const add = useMutation({
    mutationFn: () => api.post<GfRoleMember[]>('/api/gf/roles', { role, staffId, entityId: entityId || null }),
    onSuccess: (list) => {
      saved(list);
      setStaffId('');
    },
    onError: (e) => toast({ tone: 'error', title: '没有加上', body: errorMessage(e) }),
  });
  return (
    <Card className="space-y-3 p-4" data-testid="gf-roles">
      <p className="text-[13px] text-ink-2">
        把真实账号配成各个角色；店主不自动顶替这些角色。最高角色是董事长。按经营主体限定的只审那个主体的事项。改动只影响之后提交的单，已经提交的按提交时的审批人走。
      </p>
      <div className="grid gap-2 sm:grid-cols-4">
        <Select value={role} onChange={(e) => setRole(e.target.value as GfRole | '')} data-testid="gf-role-role">
          <option value="">角色</option>
          {meta.data?.roles.map((r) => (
            <option key={r.role} value={r.role}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select value={staffId} onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : '')} data-testid="gf-role-staff">
          <option value="">员工</option>
          {meta.data?.staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select value={entityId} onChange={(e) => setEntityId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">所有经营主体</option>
          {meta.data?.entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        <Button disabled={!role || !staffId} loading={add.isPending} onClick={() => add.mutate()} data-testid="gf-role-add">
          加上
        </Button>
      </div>
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : (
        <ul className="divide-y divide-line">
          {(q.data ?? []).map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 py-2 text-[14px]" data-testid={`gf-role-row-${m.id}`}>
              <span className="w-40 shrink-0 font-semibold text-ink">{GF_ROLE_LABELS[m.role]}</span>
              <span className="min-w-0 flex-1 text-ink-2">
                {m.staffName}
                <span className="ml-1.5 text-[12.5px] text-ink-3">
                  工号 {m.staffNo}
                  {m.departmentName ? ` · ${m.departmentName}` : ''}
                </span>
                {m.entityName ? ` · 限 ${m.entityName}` : ''}
                {m.note ? <span className="ml-1.5 text-[12.5px] text-ink-3">（{m.note}）</span> : null}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setEditing(m)} data-testid={`gf-role-edit-${m.id}`}>
                修改
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRevoking(m)} data-testid={`gf-role-revoke-${m.id}`}>
                撤销
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button size="sm" variant="secondary" onClick={() => setShowLog((v) => !v)} data-testid="gf-role-log-toggle">
          {showLog ? '收起变更记录' : '变更记录'}
        </Button>
        {showLog &&
          (changes.isPending ? (
            <Skeleton className="mt-2 h-20" />
          ) : (
            <ul className="mt-2 divide-y divide-line text-[13px]" data-testid="gf-role-log">
              {(changes.data ?? []).length === 0 && <li className="py-2 text-ink-3">还没有变更</li>}
              {(changes.data ?? []).map((c) => (
                <li key={`${c.op}-${c.id}`} className="flex flex-wrap items-center gap-2 py-1.5">
                  <Badge tone={c.op === 'revoke' ? 'clay' : c.op === 'edit' ? 'yuzu' : 'moss'}>{OP_LABELS[c.op]}</Badge>
                  <span className="font-semibold text-ink">{GF_ROLE_LABELS[c.role]}</span>
                  <span className="text-ink-2">
                    {c.op === 'edit' && c.replacedStaffName ? `${c.replacedStaffName} → ` : ''}
                    {c.staffName}（{c.staffNo}）{c.entityName ? ` · 限 ${c.entityName}` : ''}
                  </span>
                  {c.reason && <span className="text-ink-3">原因：{c.reason}</span>}
                  <span className="ml-auto text-[12px] text-ink-3">
                    {c.byName} · {formatDateTime(c.at)}
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </div>
      {editing && <EditDialog member={editing} meta={meta.data} onClose={() => setEditing(null)} onSaved={saved} />}
      {revoking && <RevokeDialog member={revoking} onClose={() => setRevoking(null)} onSaved={saved} />}
    </Card>
  );
}

function EditDialog({ member, meta, onClose, onSaved }: { member: GfRoleMember; meta: GfMeta | undefined; onClose: () => void; onSaved: (l: GfRoleMember[]) => void }) {
  const toast = useToast();
  const [staffId, setStaffId] = useState<number>(member.staffId);
  const [entityId, setEntityId] = useState<number | ''>(member.entityId ?? '');
  const [note, setNote] = useState(member.note);
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.post<GfRoleMember[]>(`/api/gf/roles/${member.id}/edit`, { staffId, entityId: entityId || null, note, reason }),
    onSuccess: (list) => {
      onSaved(list);
      onClose();
    },
    onError: (e) => toast({ tone: 'error', title: '没有改成', body: errorMessage(e) }),
  });
  return (
    <Dialog open onClose={onClose} title={`修改「${GF_ROLE_LABELS[member.role]}」`}>
      <div className="space-y-3">
        <p className="text-[13px] text-ink-3">角色不能改；要换角色请撤销后新加。已经提交的单仍按提交时的审批人走。</p>
        <Field label="员工" htmlFor="gf-edit-staff">
          <Select id="gf-edit-staff" value={staffId} onChange={(e) => setStaffId(Number(e.target.value))} data-testid="gf-edit-staff">
            {meta?.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="经营主体" htmlFor="gf-edit-entity">
          <Select id="gf-edit-entity" value={entityId} onChange={(e) => setEntityId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">所有经营主体</option>
            {meta?.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="备注" htmlFor="gf-edit-note">
          <Input id="gf-edit-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field label="修改原因" htmlFor="gf-edit-reason">
          <Input id="gf-edit-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="例如：岗位调整，由某某接手" data-testid="gf-edit-reason" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={reason.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()} data-testid="gf-edit-save">
            保存
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RevokeDialog({ member, onClose, onSaved }: { member: GfRoleMember; onClose: () => void; onSaved: (l: GfRoleMember[]) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const revoke = useMutation({
    mutationFn: () => api.post<GfRoleMember[]>(`/api/gf/roles/${member.id}/revoke`, { reason }),
    onSuccess: (list) => {
      onSaved(list);
      onClose();
    },
    onError: (e) => toast({ tone: 'error', title: '没有撤销', body: errorMessage(e) }),
  });
  return (
    <Dialog open onClose={onClose} title={`撤销「${GF_ROLE_LABELS[member.role]}」· ${member.staffName}`}>
      <div className="space-y-3">
        <p className="text-[13px] text-ink-3">撤销后这个人不再审之后提交的单；已经提交、轮到他的单仍由他审（他停用了的话改由现在的映射审）。</p>
        <Field label="原因（选填）" htmlFor="gf-revoke-reason">
          <Input id="gf-revoke-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()} data-testid="gf-revoke-confirm">
            撤销
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
