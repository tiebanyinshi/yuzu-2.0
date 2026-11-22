// OA-02 批量开通（docs/OA.md 第 5 节）：后台「组织架构」的员工档案卡片上「批量开通」。
// 下载模板 → 选文件 → 预览（逐行写出问题）→ 全部对了才能「开通」→ 显示这一批的临时密码（只显示这一次，可复制、可下载名单）。
// 开通带操作编号，走 ERP 的「结果待确认」（sendErpOp）：没收到结果时记在本机，组织架构页上方查回、按原内容重新提交或作废；
// 查回、重提拿到的结果不再带临时密码（服务端只存散列），到「员工账号」里重置。

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Download, FileSearch, FileUp } from 'lucide-react';
import { STAFF_IMPORT_MAX_ROWS, type StaffImportPreview, type StaffImportResult, type StaffImportRow } from '@shared/oa';
import { ORG_DEPARTMENTS, positionLabel } from '@shared/positions';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpPending } from '../../lib/erpPending';
import { loadTableFile, type LoadedTable } from '../../lib/import-file';
import { useSession } from '../../lib/session';
import { downloadCsvRows, uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Notice } from '../../components/ui';

const deptName = (key: string | null) => ORG_DEPARTMENTS.find((d) => d.key === key)?.name ?? '—';

export function StaffImportDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const pending = useErpPending(['oa_staff_import']);
  const [file, setFile] = useState<LoadedTable | null>(null);
  const [preview, setPreview] = useState<StaffImportPreview | null>(null);
  const [result, setResult] = useState<StaffImportResult | null>(null);
  const [busy, setBusy] = useState<'read' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const choose = async (f: File | undefined) => {
    // 开通请求还在路上时不换文件（Codex 审查 3568884：换文件会把 busy 改掉，对话框又能关了）
    if (!f || busy === 'apply') return;
    setPreview(null);
    setError(null);
    setBusy('read');
    try {
      const loaded = await loadTableFile(f);
      setFile(loaded);
      setBusy('preview');
      setPreview(await api.post<StaffImportPreview>('/api/oa/employees/import/preview', body(loaded)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };

  const apply = async () => {
    if (!file || !preview) return;
    if (pending.length > 0) return setError('上一次批量开通结果待确认：请先关掉这个窗口，在页面上方查回、按原内容重新提交或作废');
    const clientKey = uuid();
    setBusy('apply');
    setError(null);
    try {
      const r = await sendErpOp<StaffImportResult>({
        key: clientKey,
        type: 'oa_staff_import',
        url: '/api/oa/employees/import',
        body: { ...body(file), clientKey },
        summary: `批量开通 · ${file.fileName} · ${preview.rows.length} 人`,
        staffName: session.staff.displayName,
      });
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['oa', 'org'] });
      toast({ tone: 'success', title: r.replayed ? '这一批之前已经开通好了' : `已开通 ${r.accounts.length} 个账号` });
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '开通结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要改了文件再开。' });
        onClose();
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (result) return <ResultDialog result={result} onClose={onClose} />;

  const columns: DataColumn<StaffImportRow>[] = [
    { key: 'row', header: '行', cell: (r) => r.row },
    { key: 'name', header: '姓名', cell: (r) => r.name || '—' },
    { key: 'phone', header: '手机号', cell: (r) => r.phone || '—' },
    { key: 'dept', header: '部门 / 岗位', cell: (r) => (r.position ? positionLabel(r.position) : deptName(r.department)) },
    { key: 'user', header: '登录名', cell: (r) => r.username },
    {
      key: 'issues',
      header: '核对',
      cell: (r) =>
        r.issues.length ? (
          <span className="block min-w-48 text-[12.5px] whitespace-normal text-clay" data-testid={`staff-import-issue-${r.row}`}>
            {r.issues.join('；')}
          </span>
        ) : (
          <Badge tone="pine">可以开</Badge>
        ),
    },
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      // 开通请求还在路上时不能关（Codex 审查 5eeb9ed）：关掉后请求成功，名单就没地方显示，临时密码一次也看不到
      dismissible={busy !== 'apply'}
      title="批量开通员工账号"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy === 'apply'}>
            取消
          </Button>
          <Button variant="primary" loading={busy === 'apply'} disabled={!preview || preview.issueCount > 0 || busy !== null} onClick={apply} data-testid="staff-import-apply">
            {preview ? `开通 ${preview.rows.length} 个账号` : '开通'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] text-ink-2">
          用模板填好姓名、手机号、部门（工号、岗位、入职日期、登录名选填），一次最多 {STAFF_IMPORT_MAX_ROWS} 人。岗位按「部门 → 负责人 / 员工」定，权限照岗位来；每人一个临时密码，第一次登录必须改。
        </p>
        <div className="flex flex-wrap gap-2">
          <a href="/api/oa/employees/import/template" download data-testid="staff-import-template">
            <Button variant="secondary" icon={<Download className="size-4" />}>
              下载模板
            </Button>
          </a>
          <Button
            variant="secondary"
            icon={<FileUp className="size-4" />}
            loading={busy === 'read' || busy === 'preview'}
            disabled={busy === 'apply'}
            onClick={() => input.current?.click()}
            data-testid="staff-import-choose"
          >
            {file ? '换一个文件' : '选择文件'}
          </Button>
          <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} data-testid="staff-import-file" />
        </div>
        {error && (
          <Notice tone="error" title="没有开通">
            {error}
          </Notice>
        )}
        {preview && (
          <>
            <div className="flex items-center gap-2 text-[13px] text-ink-2">
              <FileSearch className="size-4 text-ink-3" />
              {preview.fileName} · {preview.rows.length} 人{preview.issueCount > 0 ? <Badge tone="ember">{preview.issueCount} 行要先改</Badge> : <Badge tone="pine">都可以开</Badge>}
            </div>
            {preview.issueCount > 0 && (
              <Notice tone="warning" title="改好这几行再选一次文件">
                <ul className="space-y-0.5">
                  {preview.rows
                    .filter((r) => r.issues.length)
                    .slice(0, 8)
                    .map((r) => (
                      <li key={r.row}>
                        第 {r.row} 行{r.name ? `（${r.name}）` : ''}：{r.issues.join('；')}
                      </li>
                    ))}
                  {preview.issueCount > 8 && <li>……还有 {preview.issueCount - 8} 行，见下表</li>}
                </ul>
              </Notice>
            )}
            <DataTable columns={columns} rows={preview.rows} rowKey={(r) => r.row} variant="plain" testId="staff-import-preview" />
          </>
        )}
      </div>
    </Dialog>
  );
}

/** 开通名单的一格：逗号、引号、换行按 CSV 规则包起来；= + - @ 开头的前面加 '，免得表格软件当成公式（Codex 审查 3568884） */
function csvCell(v: string): string {
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 复制名单的一格（粘到表格里是一列一格）：制表符、换行换成空格；= + - @ 开头的前面加 '（Codex 审查 3dff3b4） */
function tsvCell(v: string): string {
  const flat = v.replace(/[\t\r\n]+/g, ' ');
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}

/** 开通后的名单（临时密码只显示这一次）；组织架构页上方「按原内容重新提交」第一次开通成功时也用它显示 */
export function ResultDialog({ result, onClose }: { result: StaffImportResult; onClose: () => void }) {
  const toast = useToast();
  const withPassword = result.accounts.filter((a) => a.temporaryPassword);
  const lines = result.accounts.map((a) => [a.name, positionLabel(a.position), a.username, a.temporaryPassword ?? '（到「员工账号」里重置）']);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.map((l) => l.map(tsvCell).join('\t')).join('\n'));
      toast({ tone: 'success', title: '已复制名单' });
    } catch {
      toast({ tone: 'error', title: '这台电脑不让复制，请用「下载名单」' });
    }
  };
  const columns: DataColumn<StaffImportResult['accounts'][number]>[] = [
    { key: 'name', header: '姓名', cell: (a) => a.name },
    { key: 'pos', header: '岗位', cell: (a) => positionLabel(a.position) },
    { key: 'user', header: '登录名', cell: (a) => <span className="font-mono">{a.username}</span> },
    {
      key: 'pw',
      header: '临时密码',
      cell: (a) =>
        a.temporaryPassword ? (
          <span className="font-mono" data-testid={`staff-import-password-${a.username}`}>
            {a.temporaryPassword}
          </span>
        ) : (
          <span className="text-ink-3">到「员工账号」里重置</span>
        ),
    },
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      // 临时密码只显示这一次：点遮罩、按 Esc 不关，只能点「完成」
      dismissible={false}
      title={`已开通 ${result.accounts.length} 个账号`}
      footer={
        <>
          <Button variant="secondary" icon={<Copy className="size-4" />} onClick={() => void copy()}>
            复制名单
          </Button>
          <Button
            variant="secondary"
            icon={<Download className="size-4" />}
            onClick={() =>
              downloadCsvRows(
                [['姓名', '岗位', '登录名', '临时密码'], ...lines].map((r) => r.map(csvCell)),
                `开通名单-${result.import.fileName.replace(/\.\w+$/, '')}.csv`,
              )
            }
            data-testid="staff-import-download"
          >
            下载名单
          </Button>
          <Button variant="primary" onClick={onClose} data-testid="staff-import-done">
            完成
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {withPassword.length > 0 ? (
          <Notice tone="warning" title="临时密码只显示这一次">
            请现在复制或下载名单，线下发给员工；员工第一次登录必须改密码。关掉以后再看不到，忘了就在「员工账号」里重置。
          </Notice>
        ) : (
          <Notice tone="info" title="这一批之前已经开通">
            临时密码只在第一次开通时显示；需要的话在「员工账号」里给他们重置密码。
          </Notice>
        )}
        <DataTable columns={columns} rows={result.accounts} rowKey={(a) => a.staffId} variant="plain" testId="staff-import-result" />
      </div>
    </Dialog>
  );
}

function body(f: LoadedTable) {
  return { fileName: f.fileName, csv: f.csv, xlsxBase64: f.xlsxBase64 };
}
