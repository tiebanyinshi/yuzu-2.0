// OA-17 后台「工资条」（docs/OA.md 第 20 节，OA21）：
//   · 工资表：按月建草稿（同月同标题直接打开那张），每人一行；下载表格填好上传（先预览，有一行不对整份不导，导入整张替换），或点一行在线改；
//     顶上常显与组织架构核对的结果（这个月在职、表里没有的可以补进来；已经不在名单里的行标出来）；点「预览」看员工看到的样子；作废草稿。
//   · 模板：字段（金额 / 数字 / 文字）可配，标一项「实发」；停用不删。
// 系统不算工资：应发、实发按填的。原件加密存在服务器上，只有管工资条的人能下载；看明细、下载都记薪资审计。

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Download, FileUp, Plus, Trash2, UserPlus } from 'lucide-react';
import {
  formatPayslipValue,
  monthLabel,
  netField,
  PAYROLL_STATUS_LABEL,
  PAYSLIP_FIELD_KINDS,
  PAYSLIP_MAX_FIELDS,
  parseAmountCell,
  type PayrollBatchDetail,
  type PayrollBatchSummary,
  type PayrollImportPreview,
  type PayrollImportResult,
  type PayslipField,
  type PayslipFieldKind,
  type PayslipRow,
  type PayslipTemplate,
  type PayslipValues,
} from '@shared/oa-payroll';
import { api, ApiError, errorMessage } from '../../lib/api';
import { loadTableFile, type LoadedTable } from '../../lib/import-file';
import { downloadUrl, formatDateTime } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useActiveSubTab } from '../../components/SubNav';
import { useToast } from '../../components/Toast';
import { Badge, Button, ConfirmCheck, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { PayslipCard } from './PayslipCard';

const TEMPLATES_KEY = ['oa', 'payroll', 'templates'] as const;
const BATCHES_KEY = ['oa', 'payroll', 'batches'] as const;
const batchKey = (id: number) => ['oa', 'payroll', 'batch', id] as const;

export function PayrollSection() {
  const tabs = [
    { key: 'batches', label: <span data-testid="payroll-tab-batches">工资表</span> },
    { key: 'templates', label: <span data-testid="payroll-tab-templates">模板</span> },
  ];
  return (
    <AdminPage section="payroll" wide tabs={tabs} description="按月做工资表：下载表格填好上传，或在线逐行填；系统不算工资，应发、实发按填的。上传的原件加密保存，看明细、下载都留审计。">
      <Body />
    </AdminPage>
  );
}

function Body() {
  const tab = useActiveSubTab() ?? 'batches';
  return tab === 'templates' ? <TemplatesTab /> : <BatchesTab />;
}

// ───────────────────────── 工资表 ─────────────────────────

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

function BatchesTab() {
  const q = useQuery({ queryKey: BATCHES_KEY, queryFn: () => api.get<PayrollBatchSummary[]>('/api/oa/payroll/batches') });
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  if (open) return <BatchView id={open} onBack={() => setOpen(null)} />;
  const columns: DataColumn<PayrollBatchSummary>[] = [
    { key: 'month', header: '月份', cell: (b) => monthLabel(b.month), className: 'whitespace-nowrap' },
    { key: 'title', header: '标题', cell: (b) => <span className="font-bold">{b.title}</span> },
    { key: 'template', header: '模板', cell: (b) => b.templateName, className: 'max-md:hidden' },
    { key: 'count', header: '已填 / 人数', numeric: true, cell: (b) => `${b.filledCount} / ${b.slipCount}` },
    { key: 'status', header: '状态', cell: (b) => <Badge tone={b.status === 'published' ? 'pine' : 'neutral'}>{PAYROLL_STATUS_LABEL[b.status]}</Badge> },
    { key: 'updated', header: '更新', cell: (b) => formatDateTime(b.updatedAt), className: 'max-md:hidden whitespace-nowrap' },
  ];
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="payroll-new">
          新建工资表
        </Button>
      </div>
      <DataTable
        columns={columns}
        rows={q.data ?? []}
        rowKey={(b) => b.id}
        loading={q.isPending}
        failed={q.isError && !q.data}
        onRetry={() => void q.refetch()}
        onRowClick={(b) => setOpen(b.id)}
        rowLabel={(b) => `打开${monthLabel(b.month)}「${b.title}」`}
        rowTestId={(b) => `payroll-batch-${b.id}`}
        empty="还没有工资表"
        emptyDescription="点「新建工资表」，选月份与模板，按当月的在职名单每人一行"
      />
      {creating && (
        <NewBatchDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpen(id);
          }}
        />
      )}
    </div>
  );
}

function NewBatchDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const templates = useQuery({ queryKey: TEMPLATES_KEY, queryFn: () => api.get<PayslipTemplate[]>('/api/oa/payroll/templates') });
  const active = (templates.data ?? []).filter((t) => t.active);
  const [month, setMonth] = useState(thisMonth());
  const [title, setTitle] = useState(`${Number(thisMonth().slice(5))} 月工资`);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const tid = templateId ?? active[0]?.id ?? null;
  const submit = async () => {
    if (!tid) return;
    setBusy(true);
    try {
      const b = await api.post<PayrollBatchSummary>('/api/oa/payroll/batches', { month, title: title.trim(), templateId: tid });
      void qc.invalidateQueries({ queryKey: BATCHES_KEY });
      onCreated(b.id);
    } catch (e) {
      // 结果不确定时刷新列表：同月同标题再点一次会直接打开已经建好的那张
      toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
      void qc.invalidateQueries({ queryKey: BATCHES_KEY });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="新建工资表"
      description="按这个月的在职名单每人一行（这个月里在职过的都算，中途离职的也在）；金额先空着"
      footer={
        <Button variant="primary" size="lg" loading={busy} disabled={!tid || !title.trim() || !/^\d{4}-\d{2}$/.test(month)} onClick={() => void submit()} data-testid="payroll-new-submit">
          建好并打开
        </Button>
      }
    >
      <div className="grid gap-4">
        <Field label="月份">
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} data-testid="payroll-new-month" />
        </Field>
        <Field label="标题" hint="同一个月可以有几张，如「11 月工资」「年终奖」">
          <Input value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} data-testid="payroll-new-title" />
        </Field>
        <Field label="模板">
          {templates.isError && !templates.data ? (
            <LoadFailed title="模板没有取回来" onRetry={() => templates.refetch()} retrying={templates.isFetching} />
          ) : (
            <Select value={tid ?? ''} onChange={(e) => setTemplateId(Number(e.target.value))} data-testid="payroll-new-template">
              {active.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}（{t.fields.length} 项）
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function BatchView({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: batchKey(id), queryFn: () => api.get<PayrollBatchDetail>(`/api/oa/payroll/batches/${id}`) });
  const [editing, setEditing] = useState<PayslipRow | null>(null);
  const [importing, setImporting] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [busy, setBusy] = useState('');
  const d = q.data;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: batchKey(id) });
    void qc.invalidateQueries({ queryKey: BATCHES_KEY });
  };
  const back = (
    <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={onBack} data-testid="payroll-back">
      全部工资表
    </Button>
  );
  if (q.isPending) return <Skeleton className="h-80" />;
  if (q.isError && !d)
    return (
      <div className="space-y-3">
        {back}
        <LoadFailed title="工资表没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      </div>
    );
  const b = d!;
  const draft = b.status === 'draft';
  const net = netField(b.fields);
  const add = async (staffId: number) => {
    setBusy(`add-${staffId}`);
    try {
      await api.put(`/api/oa/payroll/batches/${id}/slips/${staffId}`, { values: {} });
      refresh();
    } catch (e) {
      toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
      refresh();
    } finally {
      setBusy('');
    }
  };
  const voidBatch = async () => {
    setBusy('void');
    try {
      await api.post(`/api/oa/payroll/batches/${id}/void`);
      toast({ tone: 'success', title: '已作废' });
      void qc.invalidateQueries({ queryKey: BATCHES_KEY });
      onBack();
    } catch (e) {
      toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
      refresh();
    } finally {
      setBusy('');
    }
  };
  const offRoster = b.slips.filter((s) => s.offRoster);
  const columns: DataColumn<PayslipRow>[] = [
    {
      key: 'name',
      header: '姓名',
      cell: (s) => (
        <span className="whitespace-nowrap">
          <span className="font-semibold">{s.name}</span>
          {s.offRoster && (
            <Badge tone="clay" className="ml-1">
              不在名单
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'empNo', header: '工号', cell: (s) => s.empNo ?? '—', className: 'whitespace-nowrap' },
    { key: 'dept', header: '部门', cell: (s) => s.departmentName, className: 'whitespace-nowrap max-md:hidden' },
    ...b.fields.map(
      (f): DataColumn<PayslipRow> => ({
        key: f.key,
        header: <span className="whitespace-nowrap">{f.label}</span>,
        numeric: f.kind !== 'text',
        cell: (s) => <span className={f.key === net?.key ? 'font-bold text-pine' : undefined}>{formatPayslipValue(f, s.values[f.key])}</span>,
        className: 'whitespace-nowrap',
      }),
    ),
  ];
  return (
    <div className="space-y-4" data-testid="payroll-batch">
      <div className="flex flex-wrap items-center gap-2">
        {back}
        <h2 className="text-[18px] font-bold text-ink">
          {monthLabel(b.month)} · {b.title}
        </h2>
        <Badge tone={b.status === 'published' ? 'pine' : 'neutral'}>{PAYROLL_STATUS_LABEL[b.status]}</Badge>
        <span className="text-[13px] text-ink-3">
          模板「{b.templateName}」 · {b.filledCount} / {b.slipCount} 人已填
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/oa/payroll/batches/${id}/sheet.xlsx`)} data-testid="payroll-sheet">
            下载表格
          </Button>
          {draft && (
            <Button variant="primary" icon={<FileUp className="size-4" />} disabled={!b.canUpload} onClick={() => setImporting(true)} data-testid="payroll-import">
              上传 Excel
            </Button>
          )}
          {draft && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setVoiding(true)} data-testid="payroll-void">
              作废
            </Button>
          )}
        </div>
      </div>
      {draft && !b.canUpload && (
        <Notice tone="warning" title="服务器还没配工资表原件的加密密钥">
          配好 PAYROLL_FILE_KEY 以前不能上传 Excel（上传的原件要加密保存），可以先在线逐行填。
        </Notice>
      )}
      {(b.missing.length > 0 || offRoster.length > 0) && (
        <Notice tone="warning" title="与组织架构核对" data-testid="payroll-roster">
          {b.missing.length > 0 && (
            <div className="mt-1">
              <p>这个月在职、表里没有的 {b.missing.length} 人：</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {b.missing.map((p) => (
                  <span key={p.staffId} className="inline-flex items-center gap-1 rounded-md bg-card px-2 py-1 text-ink">
                    {p.name}
                    {p.empNo ? `（${p.empNo}）` : ''}
                    {draft && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<UserPlus className="size-4" />}
                        loading={busy === `add-${p.staffId}`}
                        onClick={() => void add(p.staffId)}
                        aria-label={`把${p.name}补进来`}
                        data-testid={`payroll-add-${p.staffId}`}
                      />
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
          {offRoster.length > 0 && <p className="mt-1">已经不在这个月名单里的：{offRoster.map((s) => `${s.name}（${s.offRoster}）`).join('、')}，核对后可以移出。</p>}
        </Notice>
      )}
      <DataTable
        columns={columns}
        rows={b.slips}
        rowKey={(s) => s.staffId}
        onRowClick={(s) => setEditing(s)}
        rowLabel={(s) => `${draft ? '填写' : '查看'}${s.name}的工资条`}
        rowTestId={(s) => `payroll-slip-${s.staffId}`}
        empty="表里还没有人"
        emptyDescription="上传 Excel，或从上面的名单里补人"
      />
      {b.files.length > 0 && (
        <div className="rounded-lg border border-line p-3 text-[13px]" data-testid="payroll-files">
          <p className="mb-1 font-semibold text-ink">上传过的原件（加密保存）</p>
          <ul className="space-y-1">
            {b.files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 text-ink-2">
                <span className="font-medium text-ink">{f.fileName}</span>
                <span>
                  {f.rowCount} 人 · {f.uploadedByName} · {formatDateTime(f.uploadedAt)}
                </span>
                {f.readable ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Download className="size-4" />}
                    onClick={() => downloadUrl(`/api/oa/payroll/batches/${id}/files/${f.id}`)}
                    data-testid={`payroll-file-${f.id}`}
                  >
                    下载原件
                  </Button>
                ) : (
                  <Badge tone="clay">换过密钥，解不开</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {editing && <SlipDialog batch={b} slip={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {importing && <ImportDialog batch={b} onClose={() => setImporting(false)} onDone={refresh} />}
      <VoidDialog open={voiding} busy={busy === 'void'} onClose={() => setVoiding(false)} onConfirm={() => void voidBatch()} />
    </div>
  );
}

function VoidDialog({ open, busy, onClose, onConfirm }: { open: boolean; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="作废这张工资表？"
      footer={
        <Button variant="danger" size="lg" disabled={!sure} loading={busy} onClick={onConfirm} data-testid="payroll-void-confirm">
          作废
        </Button>
      }
    >
      <ConfirmCheck checked={sure} onChange={setSure} tone="clay">
        作废以后不能再改、不再显示在列表里（记录留着）；同月同标题可以重新建
      </ConfirmCheck>
    </Dialog>
  );
}

/** 单元格的输入文字：金额按元写 */
const inputOf = (f: PayslipField, v: PayslipValues[string] | undefined) => (v === null || v === undefined ? '' : f.kind === 'money' && typeof v === 'number' ? (v / 100).toFixed(2) : String(v));

function SlipDialog({ batch, slip, onClose, onSaved }: { batch: PayrollBatchDetail; slip: PayslipRow; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const draft = batch.status === 'draft';
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(batch.fields.map((f) => [f.key, inputOf(f, slip.values[f.key])])));
  const [preview, setPreview] = useState(!draft);
  const [busy, setBusy] = useState('');
  const parsed: PayslipValues = {};
  const bad: string[] = [];
  for (const f of batch.fields) {
    const t = (text[f.key] ?? '').trim();
    if (!t) continue;
    if (f.kind === 'text') parsed[f.key] = t;
    else {
      const v = parseAmountCell(t, f.kind);
      if (v === 'invalid') bad.push(f.label);
      else if (v !== null) parsed[f.key] = v;
    }
  }
  const run = async (what: 'save' | 'remove') => {
    setBusy(what);
    try {
      if (what === 'save') await api.put(`/api/oa/payroll/batches/${batch.id}/slips/${slip.staffId}`, { values: parsed });
      else await api.post(`/api/oa/payroll/batches/${batch.id}/slips/${slip.staffId}/remove`);
      toast({ tone: 'success', title: what === 'save' ? '已保存' : '已移出' });
      onSaved();
      onClose();
    } catch (e) {
      // 按结果写：没收到结果的再点一次结果一样
      toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
      onSaved();
    } finally {
      setBusy('');
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${slip.name}${slip.empNo ? `（${slip.empNo}）` : ''}`}
      description={`${slip.departmentName}${slip.offRoster ? ` · 不在这个月的名单里：${slip.offRoster}` : ''}`}
      footer={
        draft ? (
          <div className="flex w-full flex-wrap justify-between gap-2">
            <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={busy === 'remove'} onClick={() => void run('remove')} data-testid="payroll-slip-remove">
              移出这张表
            </Button>
            <Button variant="primary" size="lg" loading={busy === 'save'} disabled={bad.length > 0} onClick={() => void run('save')} data-testid="payroll-slip-save">
              保存
            </Button>
          </div>
        ) : undefined
      }
    >
      {draft && (
        <div className="mb-3 flex gap-2">
          <Button size="sm" variant={preview ? 'secondary' : 'primary'} onClick={() => setPreview(false)}>
            填写
          </Button>
          <Button size="sm" variant={preview ? 'primary' : 'secondary'} onClick={() => setPreview(true)} data-testid="payroll-slip-preview">
            预览员工看到的
          </Button>
        </div>
      )}
      {preview ? (
        <PayslipCard month={batch.month} title={batch.title} name={slip.name} fields={batch.fields} values={draft ? parsed : slip.values} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {batch.fields.map((f) => (
            <Field key={f.key} label={`${f.label}${f.kind === 'money' ? '（元）' : ''}${f.net ? ' · 实发' : ''}`} error={bad.includes(f.label) ? '要写数字，最多两位小数' : undefined}>
              <Input
                value={text[f.key] ?? ''}
                inputMode={f.kind === 'text' ? 'text' : 'decimal'}
                maxLength={f.kind === 'text' ? 100 : 16}
                onChange={(e) => setText((t) => ({ ...t, [f.key]: e.target.value }))}
                data-testid={`payroll-field-${f.key}`}
              />
            </Field>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function ImportDialog({ batch, onClose, onDone }: { batch: PayrollBatchDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<LoadedTable | null>(null);
  const [preview, setPreview] = useState<PayrollImportPreview | null>(null);
  const [busy, setBusy] = useState<'read' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const body = (f: LoadedTable) => ({ fileName: f.fileName, csv: f.csv, xlsxBase64: f.xlsxBase64 });
  const choose = async (f: File | undefined) => {
    if (!f || busy === 'apply') return;
    setPreview(null);
    setError(null);
    setBusy('read');
    try {
      const loaded = await loadTableFile(f);
      setFile(loaded);
      setPreview(await api.post<PayrollImportPreview>(`/api/oa/payroll/batches/${batch.id}/import/preview`, body(loaded)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };
  const apply = async () => {
    if (!file || !preview) return;
    setBusy('apply');
    setError(null);
    try {
      const r = await api.post<PayrollImportResult>(`/api/oa/payroll/batches/${batch.id}/import`, body(file));
      toast({ tone: 'success', title: `已导入 ${r.slipCount} 人的工资条` });
      onDone();
      onClose();
    } catch (e) {
      // 导入是整张替换：结果不确定时原样再传一次结果一样（同一份原件不重复存）
      setError(e instanceof ApiError ? errorMessage(e) : `${errorMessage(e)}（结果不确定：可以刷新看工资表，或原样再导一次，结果一样）`);
      onDone();
    } finally {
      setBusy(null);
    }
  };
  const bad = preview?.rows.filter((r) => r.issues.length) ?? [];
  return (
    <Dialog
      open
      onClose={() => busy !== 'apply' && onClose()}
      dismissible={busy !== 'apply'}
      width="max-w-2xl"
      title="上传 Excel"
      description="用「下载表格」得到的表填好上传：先预览核对，全部对了才能导入；导入会整张替换表里现有的工资条。原件加密保存。"
      footer={
        <div className="flex w-full flex-wrap justify-between gap-2">
          <Button icon={<FileUp className="size-4" />} loading={busy === 'read'} disabled={busy === 'apply'} onClick={() => input.current?.click()} data-testid="payroll-import-choose">
            {file ? '换一个文件' : '选文件'}
          </Button>
          <Button variant="primary" size="lg" loading={busy === 'apply'} disabled={!preview || bad.length > 0} onClick={() => void apply()} data-testid="payroll-import-apply">
            导入{preview ? ` ${preview.okCount} 人` : ''}
          </Button>
        </div>
      }
    >
      <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} data-testid="payroll-import-file" />
      {error && (
        <Notice tone="error" className="mb-3">
          {error}
        </Notice>
      )}
      {!preview && !error && <EmptyState title="还没选文件" description="Excel（.xlsx）或 CSV；按工号对人，没有工号按姓名" />}
      {preview && (
        <div className="space-y-3" data-testid="payroll-import-preview">
          <p className="text-ink-2">
            {preview.fileName}：{preview.rows.length} 行，<span className="text-pine">{preview.okCount} 行没问题</span>
            {bad.length > 0 && <span className="text-clay">，{bad.length} 行要改</span>}
          </p>
          {bad.length > 0 && (
            <ul className="max-h-60 space-y-1 overflow-auto rounded-lg border border-clay/30 p-3 text-[13px]" data-testid="payroll-import-issues">
              {bad.map((r) => (
                <li key={r.row}>
                  <span className="num text-ink-3">第 {r.row} 行</span> <span className="font-semibold">{r.name || '—'}</span>：<span className="text-clay">{r.issues.join('；')}</span>
                </li>
              ))}
            </ul>
          )}
          {preview.missing.length > 0 && (
            <Notice tone="warning" title={`名单里有、表里没有的 ${preview.missing.length} 人`}>
              {preview.missing.map((p) => p.name).join('、')}（导入后他们不在这张表里，需要的话之后再补）
            </Notice>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ───────────────────────── 模板 ─────────────────────────

function TemplatesTab() {
  const q = useQuery({ queryKey: TEMPLATES_KEY, queryFn: () => api.get<PayslipTemplate[]>('/api/oa/payroll/templates') });
  const [editing, setEditing] = useState<PayslipTemplate | 'new' | null>(null);
  if (q.isPending) return <Skeleton className="h-60" />;
  if (q.isError && !q.data) return <LoadFailed title="模板没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const columns: DataColumn<PayslipTemplate>[] = [
    { key: 'name', header: '模板', cell: (t) => <span className="font-bold">{t.name}</span> },
    { key: 'fields', header: '字段', cell: (t) => <span className="line-clamp-2 text-ink-2">{t.fields.map((f) => f.label).join('、')}</span> },
    { key: 'used', header: '工资表', numeric: true, cell: (t) => t.batchCount, className: 'max-md:hidden' },
    { key: 'active', header: '状态', cell: (t) => <Badge tone={t.active ? 'pine' : 'neutral'}>{t.active ? '在用' : '停用'}</Badge> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="payroll-template-new">
          新建模板
        </Button>
      </div>
      <DataTable columns={columns} rows={q.data} rowKey={(t) => t.id} onRowClick={(t) => setEditing(t)} rowLabel={(t) => `编辑模板「${t.name}」`} rowTestId={(t) => `payroll-template-${t.id}`} />
      {editing && <TemplateDialog template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

type DraftField = { key?: string; label: string; kind: PayslipFieldKind; net?: boolean };

function TemplateDialog({ template, onClose }: { template: PayslipTemplate | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(template?.name ?? '');
  const [fields, setFields] = useState<DraftField[]>(template?.fields ?? [{ label: '', kind: 'money' }]);
  const [active, setActive] = useState(template?.active ?? true);
  const [busy, setBusy] = useState(false);
  const labels = fields.map((f) => f.label.trim());
  const dup = labels.find((l, i) => l && labels.indexOf(l) !== i);
  const invalid = !name.trim() || labels.some((l) => !l) || !!dup;
  const set = (i: number, patch: Partial<DraftField>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : patch.net ? { ...f, net: false } : f)));
  const move = (i: number, d: -1 | 1) =>
    setFields((fs) => {
      const next = [...fs];
      [next[i], next[i + d]] = [next[i + d]!, next[i]!];
      return next;
    });
  const save = async () => {
    setBusy(true);
    const payload = {
      name: name.trim(),
      fields: fields.map((f) => ({ ...(f.key ? { key: f.key } : {}), label: f.label.trim(), kind: f.kind, ...(f.net && f.kind === 'money' ? { net: true } : {}) })),
    };
    try {
      if (template) await api.put(`/api/oa/payroll/templates/${template.id}`, { ...payload, active, version: template.version });
      else await api.post('/api/oa/payroll/templates', payload);
      toast({ tone: 'success', title: '已保存', body: template ? '已经建好的工资表不受影响' : undefined });
      void qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
      onClose();
    } catch (e) {
      toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
      void qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title={template ? `编辑模板「${template.name}」` : '新建模板'}
      description="字段的顺序就是工资条上的顺序；标一项「实发」，员工的工资条列表上显示它。改模板不影响已经建好的工资表"
      footer={
        <Button variant="primary" size="lg" loading={busy} disabled={invalid} onClick={() => void save()} data-testid="payroll-template-save">
          保存
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="模板名称">
          <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-testid="payroll-template-name" />
        </Field>
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={f.key ?? `new-${i}`} className="flex flex-wrap items-center gap-2" data-testid={`payroll-template-field-${i}`}>
              <Input
                className="min-w-0 flex-1"
                fullWidth={false}
                value={f.label}
                maxLength={20}
                placeholder="字段名称"
                onChange={(e) => set(i, { label: e.target.value })}
                aria-label={`第 ${i + 1} 个字段的名称`}
              />
              <Select
                className="w-24"
                value={f.kind}
                onChange={(e) => set(i, { kind: e.target.value as PayslipFieldKind, net: e.target.value === 'money' ? f.net : false })}
                aria-label={`第 ${i + 1} 个字段的类型`}
              >
                {PAYSLIP_FIELD_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-1 text-[13px] text-ink-2">
                <input type="radio" name="net" checked={!!f.net} disabled={f.kind !== 'money'} onChange={() => set(i, { net: true })} />
                实发
              </label>
              <Button size="sm" variant="ghost" icon={<ArrowUp className="size-4" />} disabled={i === 0} onClick={() => move(i, -1)} aria-label="上移" />
              <Button size="sm" variant="ghost" icon={<ArrowDown className="size-4" />} disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label="下移" />
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                disabled={fields.length === 1}
                onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
                aria-label="删掉这个字段"
              />
            </div>
          ))}
          {dup && <p className="text-[13px] text-clay">字段名称「{dup}」重复了</p>}
          <Button
            size="sm"
            icon={<Plus className="size-4" />}
            disabled={fields.length >= PAYSLIP_MAX_FIELDS}
            onClick={() => setFields((fs) => [...fs, { label: '', kind: 'money' }])}
            data-testid="payroll-template-add-field"
          >
            加一个字段
          </Button>
        </div>
        {template && (
          <ConfirmCheck checked={active} onChange={setActive}>
            在用（停用以后新建工资表时选不到它；已经建好的不受影响）
          </ConfirmCheck>
        )}
      </div>
    </Dialog>
  );
}
