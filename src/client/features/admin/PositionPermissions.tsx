// 后台「岗位权限」→「设立岗位」（8.1.18 起，docs/POSITIONS_V8118.md GW8；8.2.0 P06 改，docs/YUZU_REQ_V820.md 第 7 节）：
// 超级管理员（总裁）选一个岗位，逐项开关这个岗位的权限，存为相对建议权限的增减，改完立即生效。
//   · 建议权限从库里来（「分部门岗位职权配置」那一页维护，迁移 201 按 8.1.18 职权表初始化），前端不写死；
//   · 换岗位时勾选按那个岗位保存过的权限重置；改了没保存先问「是否放弃当前修改」；
//   · 按权限表的模块分组（PermissionPicker：单项、全选、本组全选、反选），与建议不同的项标出来，「恢复建议权限」一键回到建议；
//   · 草稿记着是哪个岗位的，换岗位那一刻也不会把上一个岗位的勾选带过去。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import type { EditablePosition, RolePermissionMatrix } from '@shared/admin';
import type { Permission } from '@shared/permissions';
import { ADMIN_LEVEL_LABELS, ORG_DEPARTMENTS, POSITIONS, positionOf } from '@shared/positions';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Notice, PendingBadge, Select } from '../../components/ui';
import { Dialog } from '../../components/Overlay';
import { PermissionPicker } from './PermissionPicker';

const EDITABLE = POSITIONS.filter((p) => p.key !== 'president');

export function PositionPermissions({ data, editable }: { data: RolePermissionMatrix; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState<EditablePosition>('front.staff');
  // 草稿连同岗位一起记：不是这个岗位的草稿一律不用
  const [draft, setDraft] = useState<{ key: EditablePosition; perms: Permission[] } | null>(null);
  const [asking, setAsking] = useState<EditablePosition | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = positionOf(key);
  const saved = data.positions.effective[key];
  const suggested = data.positions.defaults[key];
  const value = draft?.key === key ? draft.perms : saved;
  const unsaved = diff(value, saved);
  const fromSuggested = diff(value, suggested);

  const switchTo = (next: EditablePosition) => {
    // 保存期间不换岗位：回来的结果按发出去的那一份清草稿（与「分部门岗位职权配置」同一个做法，Codex 审查 e770cb9）
    if (next === key || saving) return;
    if (unsaved > 0) return setAsking(next);
    setKey(next);
    setDraft(null);
    setError(null);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<RolePermissionMatrix>('/api/admin/position-permissions', { positions: { [key]: value } });
      qc.setQueryData(['admin', 'permissions'], next);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: qk.session });
      void qc.invalidateQueries({ queryKey: ['admin', 'position-catalog'] });
      toast({ tone: 'success', title: `「${def.title}」的权限已保存`, body: '立即生效：这个岗位的员工下一次操作就按新的权限判断。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="position-permissions">
      <Notice tone="info" title={editable ? '选一个岗位，勾选这个岗位的权限；带锁的只属于总裁' : '只有总裁（超级管理员）可以调整岗位权限'}>
        选岗位就带出这个岗位的建议权限（在「分部门岗位职权配置」里维护）；与建议不同的项标黄点。总裁固定拥有全部权限。
        {data.positions.updatedBy ? `${data.positions.updatedBy} 于 ${formatDateTime(data.positions.updatedAt!)} 调整过。` : '目前全部按建议权限。'}
        {data.positions.needsPosition > 0 && ` 还有 ${data.positions.needsPosition} 个老账号没选新岗位（他们下次登录时自己选）。`}
        <PendingBadge className="ml-2" title="每个岗位具体给哪几项待店主确认（GW4）" />
      </Notice>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="岗位" htmlFor="pp-position">
          <Select id="pp-position" value={key} disabled={saving} onChange={(e) => switchTo(e.target.value as EditablePosition)} data-testid="position-permissions-select">
            {ORG_DEPARTMENTS.filter((d) => d.key !== 'company').map((d) => (
              <optgroup key={d.key} label={d.name}>
                {EDITABLE.filter((p) => p.department === d.key).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.title}（{ADMIN_LEVEL_LABELS[p.level]}）{data.positions.staffCount[p.key as EditablePosition] ? ` · ${data.positions.staffCount[p.key as EditablePosition]} 人` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <p className="flex flex-wrap items-center gap-2 pb-2 text-[12.5px] text-ink-3">
          <Badge tone="lake">{ADMIN_LEVEL_LABELS[def.level]}</Badge>
          建议 <b className="num text-ink-2">{suggested.length}</b> 项
          {diff(saved, suggested) > 0 ? <Badge tone="yuzu">已按岗位调整 {diff(saved, suggested)} 处</Badge> : <Badge tone="pine">按建议</Badge>}
        </p>
        {editable && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {unsaved > 0 && (
              <span className="text-[12.5px] text-ink-3" data-testid="position-permissions-unsaved">
                未保存 {unsaved} 处
              </span>
            )}
            <Button
              variant="ghost"
              icon={<RotateCcw className="size-4" />}
              disabled={fromSuggested === 0}
              onClick={() => setDraft({ key, perms: [...suggested] })}
              data-testid="position-permissions-restore"
            >
              恢复建议权限
            </Button>
            <Button variant="primary" loading={saving} disabled={unsaved === 0} onClick={save} data-testid="position-permissions-save">
              保存这个岗位
            </Button>
          </div>
        )}
      </div>
      {error && <Notice tone="error" title={error} />}
      <PermissionPicker key={key} value={value} onChange={(perms) => setDraft({ key, perms })} baseline={suggested} editable={editable && !saving} testId={`pos-perm-${key}`} />
      <Dialog
        open={!!asking}
        onClose={() => setAsking(null)}
        title="是否放弃当前修改？"
        description={`「${def.title}」改了 ${unsaved} 处还没保存，换到别的岗位会丢掉这些修改。`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              继续改
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setKey(asking!);
                setDraft(null);
                setAsking(null);
                setError(null);
              }}
              data-testid="position-permissions-discard"
            >
              放弃修改
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">要留着的话先点「继续改」，再点「保存这个岗位」。</p>
      </Dialog>
    </div>
  );
}

function diff(a: readonly Permission[], b: readonly Permission[]) {
  return a.filter((p) => !b.includes(p)).length + b.filter((p) => !a.includes(p)).length;
}
