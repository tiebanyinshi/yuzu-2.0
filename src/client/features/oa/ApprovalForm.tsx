// OA-11 员工「办公 → 审批 → 发起审批」（docs/OA.md 第 14 节）：选模板，按模板字段填表（与服务端同一份核对，填错就地提示）。
//   · 没提交的表单记在本机（草稿，按账号 + 模板），下次打开接着填；提交成功清掉。
//   · 驳回以后「修改后重新提交」：带出原单的内容与附件（附件沿用原来那一份）。
//   · 提交带操作编号、先记在本机再发（sendErpOp）；没收到结果的在「审批」页上方查回、原样重提或作废，确认前不让再提交。

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FileText, Paperclip, X } from 'lucide-react';
import { checkApprovalForm, type ApprovalDetail, type ApprovalField, type ApprovalForm as Form, type ApprovalPage, type ApprovalSaved, type ApprovalTemplate, type HalfDay } from '@shared/oa-approval';
import type { LeaveType, MySchedule, OaAttachment } from '@shared/oa';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { uploadFile } from './oaImage';

/** 表单在页面上的样子：金额按元填（提交时换成分），附件留着名字好显示 */
type Values = Record<string, unknown>;

const draftKey = (staffId: number, code: string) => `oa-approval-draft:${staffId}:${code}`;
function readDraft(key: string): Values | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Values) : null;
  } catch {
    return null;
  }
}
function writeDraft(key: string, v: Values | null) {
  try {
    if (v) localStorage.setItem(key, JSON.stringify(v));
    else localStorage.removeItem(key);
  } catch {
    /* 存不了草稿不影响提交 */
  }
}

/** 页面上的值 → 提交的表单 */
function toForm(fields: readonly ApprovalField[], v: Values): Form {
  const out: Form = {};
  for (const f of fields) {
    const x = v[f.key];
    if (f.type === 'money') out[f.key] = typeof x === 'string' && /^\d+(\.\d{1,2})?$/.test(x.trim()) ? Math.round(Number(x) * 100) : x === '' || x == null ? null : (x as never);
    else if (f.type === 'attachments') out[f.key] = Array.isArray(x) ? (x as OaAttachment[]).map((a) => a.id) : [];
    else out[f.key] = (x ?? null) as never;
  }
  return out;
}
/** 原单的表单 → 页面上的值（重新提交时带出） */
function fromForm(fields: readonly ApprovalField[], form: Form, attachments: OaAttachment[]): Values {
  const v: Values = {};
  for (const f of fields) {
    const x = form[f.key];
    if (f.type === 'money') v[f.key] = typeof x === 'number' ? (x / 100).toFixed(2) : '';
    else if (f.type === 'attachments') v[f.key] = attachments.filter((a) => Array.isArray(x) && (x as number[]).includes(a.id));
    else v[f.key] = x ?? '';
  }
  return v;
}

export function NewApprovalPage({ code, fromId }: { code: string | null; fromId: number | null }) {
  const templates = useQuery({ queryKey: ['oa', 'approval-templates'], queryFn: () => api.get<ApprovalTemplate[]>('/api/oa/approval/templates') });
  const template = templates.data?.find((t) => t.code === code) ?? null;
  return (
    <>
      <PageHeader dateMode="calendar" title={template ? `发起审批 · ${template.name}` : '发起审批'} subtitle="提交以后按模板逐级审批；没提交的内容记在这台设备上，下次接着填" />
      <div className="mx-auto w-full max-w-2xl space-y-4 p-4 md:p-7">
        {templates.isPending ? (
          <Skeleton className="h-60" />
        ) : templates.isError && !templates.data ? (
          <LoadFailed title="审批模板没有取回来" onRetry={() => templates.refetch()} retrying={templates.isFetching} />
        ) : !code ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="oa-approval-templates">
            {templates.data!.map((t) => (
              <Link
                key={t.id}
                to={`/oa/approvals/new/${t.code}`}
                className="tap relative rounded-lg border border-line bg-card p-4 shadow-card hover:border-line-strong"
                data-testid={`oa-approval-tpl-${t.code}`}
              >
                <FileText className="size-6 text-pine" />
                <p className="mt-3 text-[15px] font-bold text-ink">{t.name}</p>
                <p className="mt-0.5 text-[12.5px] text-ink-3">{t.description}</p>
              </Link>
            ))}
          </div>
        ) : !template ? (
          <Notice tone="warning" title="这个模板不存在或已停用" action={<Link to="/oa/approvals/new">换一个</Link>} />
        ) : (
          <TemplateForm template={template} fromId={fromId} />
        )}
      </div>
    </>
  );
}

function TemplateForm({ template, fromId }: { template: ApprovalTemplate; fromId: number | null }) {
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const key = draftKey(session.staff.id, template.code);
  const from = useQuery({ queryKey: ['oa', 'approval', fromId], queryFn: () => api.get<ApprovalDetail>(`/api/oa/approvals/${fromId}`), enabled: !!fromId });
  // 从别的页带过来的预填（只认文字、多行文字字段）：如工资条页「有异议」带上「工资条」那一栏（OA-18）
  const [params] = useSearchParams();
  const [values, setValues] = useState<Values | null>(() => {
    if (fromId) return null;
    const prefill = Object.fromEntries(
      template.fields
        .filter((f) => f.type === 'text' || f.type === 'textarea')
        .map((f) => [f.key, params.get(`f.${f.key}`)?.slice(0, f.max ?? 200) ?? ''] as const)
        .filter(([, v]) => v),
    );
    return { ...readDraft(key), ...prefill };
  });
  useEffect(() => {
    if (fromId && from.data && values === null) setValues(fromForm(template.fields, from.data.form, from.data.attachments));
  }, [fromId, from.data, values, template.fields]);
  const mine = (op: { staffId?: number }) => op.staffId === session.staff.id;
  const pending = useErpRecorded(['oa_approval_submit']).filter(mine);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // 还在上传的附件个数：传完才能提交（新附件传完才进表单，Codex 审查 128b492）
  const [uploading, setUploading] = useState(0);
  if (fromId && !values) return from.isError ? <LoadFailed title="原来的单没有取回来" onRetry={() => from.refetch()} retrying={from.isFetching} /> : <Skeleton className="h-60" />;
  const v = values ?? {};
  // 按最新的状态合并（附件上传完成时调用的是上传开始那一刻的回调，不能拿那时的表单整个盖回去，Codex 审查 03e17aa）
  const set = (k: string, x: unknown) =>
    setValues((prev) => {
      const next = { ...prev, [k]: x };
      if (!fromId) writeDraft(key, next);
      return next;
    });
  const form = toForm(template.fields, v);
  const checked = checkApprovalForm(template.fields, form);
  const badMoney = template.fields.find((f) => f.type === 'money' && typeof v[f.key] === 'string' && (v[f.key] as string).trim() !== '' && typeof form[f.key] !== 'number');
  const problem = badMoney ? `${badMoney.label}按元填，最多两位小数` : 'error' in checked ? checked.error : null;

  const submit = async () => {
    setTouched(true);
    if (problem || uploading > 0) return;
    if (pending.length > 0) {
      setError('上一次提交结果待确认：请先到「审批」页上方查回、按原内容重新提交或作废');
      return;
    }
    const clientKey = uuid();
    setSaving(true);
    setError(null);
    try {
      const r = await sendErpOp<ApprovalSaved>({
        key: clientKey,
        type: 'oa_approval_submit',
        url: '/api/oa/approvals',
        body: { clientKey, templateId: template.id, form, previousId: fromId },
        summary: `${template.name}${typeof form.title === 'string' ? ` · ${form.title}` : ''}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      writeDraft(key, null);
      toast({ tone: 'success', title: `已提交：${r.approval.title}` });
      navigate(`/oa/approvals/${r.approval.id}`, { replace: true });
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '提交结果待确认', body: '已记在本机：请在「审批」页上方查回、按原内容重新提交或作废，确认前不要再提交一份。' });
        navigate('/oa/approvals?box=mine', { replace: true });
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-4 p-4 md:p-5" data-testid="oa-approval-form">
      {fromId && <Notice tone="info" title="修改后重新提交：会生成新的一张，原来那张留着" />}
      {template.fields.map((f) => (
        <FieldInput key={f.key} field={f} value={v[f.key]} values={v} onChange={(x) => set(f.key, x)} onBusy={(d) => setUploading((n) => n + d)} />
      ))}
      {(error || (touched && problem)) && (
        <p className="text-[13px] text-clay" data-testid="oa-approval-problem">
          {error ?? problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {!fromId && Object.keys(v).length > 0 && uploading === 0 && (
          <Button
            variant="ghost"
            onClick={() => {
              writeDraft(key, null);
              setValues({});
            }}
          >
            清空
          </Button>
        )}
        <Button variant="primary" size="lg" loading={saving} disabled={uploading > 0} onClick={() => void submit()} data-testid="oa-approval-submit">
          {uploading > 0 ? '附件上传中…' : '提交'}
        </Button>
      </div>
    </Card>
  );
}

const testId = (f: ApprovalField) => `oa-field-${f.key}`;

function FieldInput({
  field: f,
  value,
  values,
  onChange,
  onBusy,
}: {
  field: ApprovalField;
  value: unknown;
  values: Values;
  onChange: (v: unknown) => void;
  /** 附件开始上传 +1、传完 −1 */
  onBusy: (delta: number) => void;
}) {
  const label = `${f.label}${f.required ? '' : '（可不填）'}`;
  const str = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  switch (f.type) {
    case 'text':
      return (
        <Field label={label} hint={f.hint}>
          <Input value={str} maxLength={f.max} onChange={(e) => onChange(e.target.value)} data-testid={testId(f)} />
        </Field>
      );
    case 'textarea':
      return (
        <Field label={label} hint={f.hint}>
          <Textarea value={str} maxLength={f.max} onChange={(e) => onChange(e.target.value)} className="min-h-24" data-testid={testId(f)} />
        </Field>
      );
    case 'number':
      return (
        <Field label={label} hint={f.hint}>
          <Input value={str} inputMode="numeric" onChange={(e) => onChange(e.target.value.replace(/\D/g, '') === '' ? '' : Number(e.target.value.replace(/\D/g, '')))} data-testid={testId(f)} />
        </Field>
      );
    case 'money':
      return (
        <Field label={`${label}（元）`} hint={f.hint}>
          <Input value={str} inputMode="decimal" placeholder="0.00" onChange={(e) => onChange(e.target.value)} data-testid={testId(f)} />
        </Field>
      );
    case 'date':
      return (
        <Field label={label} hint={f.hint}>
          <Input type="date" value={str} onChange={(e) => onChange(e.target.value)} data-testid={testId(f)} />
        </Field>
      );
    case 'datetime':
      return (
        <Field label={label} hint={f.hint}>
          <Input type="datetime-local" value={str} onChange={(e) => onChange(e.target.value)} data-testid={testId(f)} />
        </Field>
      );
    case 'halfday': {
      const h = (value && typeof value === 'object' ? value : { date: '', half: 'am' }) as HalfDay;
      return (
        <Field label={label} hint={f.hint}>
          <div className="flex gap-2">
            <Input type="date" value={h.date} onChange={(e) => onChange({ ...h, date: e.target.value })} data-testid={`${testId(f)}-date`} />
            <Select value={h.half} onChange={(e) => onChange({ ...h, half: e.target.value })} fullWidth={false} className="w-28" data-testid={`${testId(f)}-half`}>
              <option value="am">上午</option>
              <option value="pm">下午</option>
            </Select>
          </div>
        </Field>
      );
    }
    case 'select':
      return (
        <Field label={label} hint={f.hint}>
          <Select value={str} onChange={(e) => onChange(e.target.value)} data-testid={testId(f)}>
            <option value="">请选择</option>
            {(f.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
      );
    case 'leave_type':
      return <LeaveTypeInput field={f} label={label} value={str} onChange={onChange} />;
    case 'shift':
      return <ShiftInput field={f} label={label} value={str} date={typeof values.date === 'string' ? values.date : ''} onChange={onChange} />;
    case 'ref':
      return <RefInput field={f} label={label} value={str} onChange={onChange} />;
    case 'attachments':
      return <AttachmentsInput field={f} label={label} value={Array.isArray(value) ? (value as OaAttachment[]) : []} onChange={onChange} onBusy={onBusy} />;
  }
}

function LeaveTypeInput({ field: f, label, value, onChange }: { field: ApprovalField; label: string; value: string; onChange: (v: unknown) => void }) {
  const types = useQuery({ queryKey: ['oa', 'leave-types'], queryFn: () => api.get<LeaveType[]>('/api/oa/leave/types') });
  const t = types.data?.find((x) => String(x.id) === value);
  if (types.isError && !types.data) return <OptionsFailed label={f.label} onRetry={() => types.refetch()} retrying={types.isFetching} />;
  return (
    <Field label={label} hint={t ? `${t.paid ? '带薪' : '不带薪'}${t.proofRequired ? '，要上传证明附件' : ''}${t.hasBalance ? '，按余额（在「假期余额」看还剩几天）' : ''}` : f.hint}>
      <Select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} data-testid={testId(f)}>
        <option value="">请选择</option>
        {(types.data ?? [])
          .filter((x) => x.active)
          .map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
      </Select>
    </Field>
  );
}

function ShiftInput({ field: f, label, value, date, onChange }: { field: ApprovalField; label: string; value: string; date: string; onChange: (v: unknown) => void }) {
  const month = date.slice(0, 7);
  const q = useQuery({ queryKey: ['oa', 'my-schedule', month], queryFn: () => api.get<MySchedule>(`/api/oa/me/schedule?month=${month}`), enabled: !!month });
  const items = q.data?.days.find((d) => d.date === date)?.items ?? [];
  if (q.isError && !q.data) return <OptionsFailed label={f.label} onRetry={() => q.refetch()} retrying={q.isFetching} />;
  return (
    <Field label={label} hint={!date ? '先选日期' : q.isPending ? '正在取那天的排班…' : !items.length ? '那天没有排班' : f.hint}>
      <Select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} disabled={!items.length} data-testid={testId(f)}>
        <option value="">请选择</option>
        {items.map((s) => (
          <option key={s.shiftId} value={s.shiftId}>
            {s.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function RefInput({ field: f, label, value, onChange }: { field: ApprovalField; label: string; value: string; onChange: (v: unknown) => void }) {
  // 自己已通过的那个模板的单：按模板在服务端筛，一页一页取完（一般就几张）
  const q = useQuery({
    queryKey: ['oa', 'approvals', 'ref', f.refTemplate],
    queryFn: async () => {
      const all: ApprovalPage['items'] = [];
      let before: number | null = null;
      for (let i = 0; i < 20; i += 1) {
        const page: ApprovalPage = await api.get<ApprovalPage>(`/api/oa/approvals?box=mine&status=approved&template=${f.refTemplate ?? ''}${before ? `&before=${before}` : ''}`);
        all.push(...page.items);
        if (!page.next) break;
        before = page.next;
      }
      return all;
    },
  });
  const items = q.data ?? [];
  if (q.isError && !q.data) return <OptionsFailed label={f.label} onRetry={() => q.refetch()} retrying={q.isFetching} />;
  return (
    <Field label={label} hint={q.isPending ? '正在取可以关联的单…' : f.hint}>
      <Select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} data-testid={testId(f)}>
        <option value="">不关联</option>
        {items.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}（{x.submittedAt.slice(0, 10)}）
          </option>
        ))}
      </Select>
    </Field>
  );
}

function AttachmentsInput({
  field: f,
  label,
  value,
  onChange,
  onBusy,
}: {
  field: ApprovalField;
  label: string;
  value: OaAttachment[];
  onChange: (v: unknown) => void;
  onBusy: (delta: number) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const max = f.max ?? 9;
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    onBusy(1);
    const next = [...value];
    try {
      for (const file of [...files].slice(0, max - value.length)) next.push(await uploadFile(file));
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
      onChange(next);
      onBusy(-1);
    }
  };
  return (
    <Field label={`${label}（最多 ${max} 个）`} hint={f.hint}>
      <div className="space-y-2" data-testid={testId(f)}>
        {value.map((a) => (
          <div key={a.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
            <Paperclip className="size-4 text-ink-3" />
            <span className="min-w-0 flex-1 truncate">{a.fileName}</span>
            {/* 上传期间不能去掉已有的：传完时按上传开始那一刻的列表加上新的，去掉的会被加回来（Codex 审查 1715764） */}
            <Button size="sm" variant="ghost" icon={<X className="size-4" />} aria-label={`去掉 ${a.fileName}`} disabled={busy} onClick={() => onChange(value.filter((x) => x.id !== a.id))} />
          </div>
        ))}
        {value.length < max && (
          <label className="tap relative flex h-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-line-strong text-[14px] text-ink-2">
            <Paperclip className="size-4" />
            {busy ? '正在上传…' : '添加附件（照片、PDF、Office 文档）'}
            <input
              type="file"
              multiple
              className="sr-only"
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"
              disabled={busy}
              onChange={(e) => {
                void add(e.target.files);
                e.target.value = '';
              }}
              data-testid={`${testId(f)}-input`}
            />
          </label>
        )}
      </div>
    </Field>
  );
}

/** 选项没有取回来：明说加载失败、给重试，不当成「没有可选的」（docs/CONVENTIONS.md 第 4 节，Codex 审查 03e17aa） */
export function OptionsFailed({ label, onRetry, retrying }: { label: string; onRetry: () => void; retrying: boolean }) {
  return <LoadFailed title={`${label}的选项没有取回来`} onRetry={onRetry} retrying={retrying} />;
}
