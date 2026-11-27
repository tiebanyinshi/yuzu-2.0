// 业财法「流程与阈值 → 试算」（8.2.15）：选事项类型、金额、部门、经营主体、谁提交，按现在的设置与角色映射排一遍审批链，
// 列出每一级现在是谁、排链时的调整（回避上移、内控加签）、知会谁；零星采购另外列分级与额度。没人能审的只提示，不报错。

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { GF_DOC_TYPES, GF_DOC_TYPE_LABELS, GF_FLAG_LABELS, GF_FLAGS, GF_ROLE_SHORT, type GfDocType, type GfFlag, type GfMeta } from '@shared/govflow';
import type { GfFlowConfigView, GfPreviewResult } from '@shared/govflow-config';
import { api, errorMessage } from '../../lib/api';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '../../components/ui';
import { yuanToCents } from './money';

const TIER_LABELS = { basic: '基础审核', enhanced: '超出基础审核' } as const;

export function FlowPreview({ meta, flows }: { meta: GfMeta; flows: GfFlowConfigView[] }) {
  const toast = useToast();
  const [docType, setDocType] = useState<GfDocType>('general');
  const [amount, setAmount] = useState('');
  const [departmentId, setDepartmentId] = useState<number | ''>('');
  const [entityId, setEntityId] = useState<number | ''>('');
  const [submittedBy, setSubmittedBy] = useState<number | ''>('');
  const [performerId, setPerformerId] = useState<number | ''>('');
  const [flags, setFlags] = useState<GfFlag[]>([]);
  const [payload, setPayload] = useState('');
  const hint = flows.find((f) => f.docType === docType)?.payloadHint ?? null;
  const payloadObj = (() => {
    if (!payload.trim()) return {};
    try {
      const v: unknown = JSON.parse(payload);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  })();
  const cents = amount.trim() ? yuanToCents(amount) : 0;
  const run = useMutation({
    mutationFn: () =>
      api.post<GfPreviewResult>('/api/gf/config/preview', {
        docType,
        amountCents: cents,
        flags,
        departmentId: departmentId || null,
        entityId: entityId || null,
        submittedBy: submittedBy || null,
        performerId: performerId || null,
        payload: payloadObj ?? {},
      }),
    onError: (e) => toast({ tone: 'error', title: '没有算出来', body: errorMessage(e) }),
  });
  const r = run.data;
  return (
    <Card className="space-y-3 p-4" data-testid="gf-config-preview">
      <h2 className="text-[15px] font-bold text-ink">试算</h2>
      <p className="text-[13px] text-ink-3">按现在的阈值、流程与角色映射排一遍，不建单。</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="事项类型" htmlFor="gf-pv-type">
          <Select id="gf-pv-type" value={docType} onChange={(e) => setDocType(e.target.value as GfDocType)} data-testid="gf-pv-type">
            {GF_DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {GF_DOC_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="金额（元，不含税）" htmlFor="gf-pv-amount" error={cents === null ? '金额格式不对' : undefined}>
          <Input id="gf-pv-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="gf-pv-amount" />
        </Field>
        <Field label="费用承担部门" htmlFor="gf-pv-dept">
          <Select id="gf-pv-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : '')} data-testid="gf-pv-dept">
            <option value="">不选</option>
            {meta.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="经营主体" htmlFor="gf-pv-entity">
          <Select id="gf-pv-entity" value={entityId} onChange={(e) => setEntityId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">不限</option>
            {meta.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="谁提交" htmlFor="gf-pv-by">
          <Select id="gf-pv-by" value={submittedBy} onChange={(e) => setSubmittedBy(e.target.value ? Number(e.target.value) : '')}>
            <option value="">我自己</option>
            {meta.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="内部履约执行人" htmlFor="gf-pv-performer">
          <Select id="gf-pv-performer" value={performerId} onChange={(e) => setPerformerId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">不选</option>
            {meta.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {GF_FLAGS.map((f) => (
          <label key={f} className="flex items-center gap-1.5 text-[13px] text-ink-2">
            <input type="checkbox" checked={flags.includes(f)} onChange={(e) => setFlags(e.target.checked ? [...flags, f] : flags.filter((x) => x !== f))} />
            {GF_FLAG_LABELS[f]}
          </label>
        ))}
      </div>
      {hint && (
        <Field label="单据字段（选填，JSON）" hint={`内置流程要看：${hint}`} htmlFor="gf-pv-payload" error={payloadObj === null ? '要写成 JSON 对象，例如 {"qty": 60}' : undefined}>
          <Textarea id="gf-pv-payload" rows={2} value={payload} onChange={(e) => setPayload(e.target.value)} data-testid="gf-pv-payload" />
        </Field>
      )}
      <div className="flex justify-end">
        <Button disabled={cents === null || payloadObj === null} loading={run.isPending} onClick={() => run.mutate()} data-testid="gf-pv-run">
          试算
        </Button>
      </div>
      {r && (
        <div className="space-y-2 border-t border-line pt-3 text-[13.5px]" data-testid="gf-pv-result">
          <p className="text-ink-2">
            {r.source === 'override' ? <Badge tone="yuzu">按自定义第 {r.version} 版</Badge> : <Badge>按内置流程</Badge>}
            {r.petty && (
              <span className="ml-2">
                {TIER_LABELS[r.petty.tier]}
                {r.petty.tier === 'enhanced' && r.petty.escalationRole ? `（升级由${GF_ROLE_SHORT[r.petty.escalationRole]}审）` : ''}；部门今天已占 <Money cents={r.petty.quota.dayTaken} /> / 日额度{' '}
                <Money cents={r.petty.quota.dailyLimit} />
                ，本月 <Money cents={r.petty.quota.monthTaken} /> / <Money cents={r.petty.quota.monthlyLimit} />
                {r.petty.quota.needSpecial ? '，超额要财总＋CFO 合并特批' : ''}
              </span>
            )}
          </p>
          <ol className="space-y-1">
            {r.nodes.map((n) => (
              <li key={n.level} className="flex flex-wrap gap-x-2" data-testid={`gf-pv-node-${n.level}`}>
                <span className="font-semibold text-ink">
                  第 {n.level} 级 · {n.label}
                </span>
                {n.seats.map((s) => (
                  <span key={s.seat} className={s.names.length || s.selfSkip ? 'text-ink-2' : 'text-clay'}>
                    {n.seats.length > 1 ? `${s.label}：` : ''}
                    {s.selfSkip ? '本人发起，视同已确认' : s.names.length ? s.names.join('、') : '没有人'}
                  </span>
                ))}
              </li>
            ))}
          </ol>
          {r.notes.length > 0 && <p className="text-[12.5px] text-ink-3">排链时：{r.notes.join('；')}</p>}
          <p className="text-[12.5px] text-ink-3">通过后知会：{r.cc.length ? r.cc.map((c) => `${c.label}${c.names.length ? `（${c.names.join('、')}）` : '（没配人）'}`).join('、') : '不知会'}</p>
          {r.warnings.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-clay" data-testid="gf-pv-warnings">
              {r.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
