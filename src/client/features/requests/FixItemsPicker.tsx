// 退回商城来的需求单（8.2.6，需求变更文档 v0.2 §4.5）：逐项标「本次必补」——哪一行、哪一项、要补什么。
// 不允许只写一句整体意见：商城单至少标一项，服务端也会拦（FIX_ITEMS_REQUIRED）

import { Plus, X } from 'lucide-react';
import { MALL_FIX_FIELD_LABELS, MALL_FIX_HEADER_FIELDS, MALL_FIX_LINE_FIELDS, type MallFixField, type MallFixItemInput } from '@shared/mall-fix';
import type { PurchaseRequest } from '@shared/requests';
import { Button, Input, Select } from '../../components/ui';

const fieldsFor = (custom: boolean | null): readonly MallFixField[] => (custom === null ? MALL_FIX_HEADER_FIELDS : MALL_FIX_LINE_FIELDS.filter((f) => custom || !f.startsWith('spec.')));

export const fixItemsProblem = (items: MallFixItemInput[]) =>
  !items.length ? '商城的需求单退回时要逐项标「本次必补」（至少一项）' : items.some((i) => !i.requirement.trim()) ? '每一项必补都要写清楚补什么' : null;

export function FixItemsPicker({ request, items, onChange }: { request: PurchaseRequest; items: MallFixItemInput[]; onChange: (next: MallFixItemInput[]) => void }) {
  const isCustom = (lineId: number | null) => (lineId === null ? null : request.lines.find((l) => l.id === lineId)?.mall?.customKind === 'custom');
  const put = (i: number, patch: Partial<MallFixItemInput>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const first = request.lines[0];
  return (
    <div className="mt-3 space-y-2" data-testid="request-fix-items">
      <p className="text-[13px] font-semibold text-ink-2">本次必补（逐项标出要补什么，部门照着补；没标的项部门不用动）</p>
      {items.map((it, i) => (
        <div key={i} className="grid gap-2 rounded-lg bg-paper-2/60 p-2.5 sm:grid-cols-[1fr_1fr_auto]" data-testid={`request-fix-item-${i}`}>
          <Select
            aria-label="哪一行"
            value={it.lineId ?? 0}
            onChange={(e) => {
              const lineId = Number(e.target.value) || null;
              const allowed = fieldsFor(isCustom(lineId));
              put(i, { lineId, field: allowed.includes(it.field) ? it.field : allowed[0]! });
            }}
          >
            <option value={0}>整张单</option>
            {request.lines.map((l) => (
              <option key={l.id} value={l.id}>
                第 {l.lineNo} 行 · {l.name}
              </option>
            ))}
          </Select>
          <Select aria-label="哪一项" value={it.field} onChange={(e) => put(i, { field: e.target.value as MallFixField })} data-testid={`request-fix-field-${i}`}>
            {fieldsFor(isCustom(it.lineId)).map((f) => (
              <option key={f} value={f}>
                {MALL_FIX_FIELD_LABELS[f]}
              </option>
            ))}
          </Select>
          <Button variant="ghost" size="sm" aria-label="去掉这一项" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <X className="size-4" />
          </Button>
          <Input
            className="sm:col-span-3"
            maxLength={200}
            value={it.requirement}
            placeholder="要补什么，例如：写清面板和底座的尺寸单位，再注明板材厚度"
            onChange={(e) => put(i, { requirement: e.target.value })}
            data-testid={`request-fix-requirement-${i}`}
          />
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          onChange([...items, first ? { lineId: first.id, field: first.mall?.customKind === 'custom' ? 'spec.size' : 'details', requirement: '' } : { lineId: null, field: 'note', requirement: '' }])
        }
        data-testid="request-fix-add"
      >
        <Plus className="size-4" /> 加一项必补
      </Button>
    </div>
  );
}
