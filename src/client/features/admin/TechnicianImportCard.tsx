// 网页导入技师（8.2.2，docs/V8222_TECHNICIANS.md 第 8 节）：上传 Excel / CSV，自动认表头，先预览逐行核对，有一处问题一行都不写。
// 再导一次同一份文件结果一样（都是「不变」）；结果不明时重新预览就看得出导没导进去（导进去了的都是「不变」）。

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileSearch, FileUp } from 'lucide-react';
import { TECH_IMPORT_ACTION_LABELS, type TechnicianImportPreview } from '@shared/technician-import-web';
import { api, errorMessage } from '../../lib/api';
import { loadTableFile, type LoadedTable } from '../../lib/import-file';
import { DataTable } from '../../components/DataTable';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented } from '../../components/ui';

export function TechnicianImportCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<LoadedTable | null>(null);
  const [gender, setGender] = useState<'none' | 'female' | 'male'>('none');
  const [gradeMap, setGradeMap] = useState('');
  const [preview, setPreview] = useState<TechnicianImportPreview | null>(null);
  const [busy, setBusy] = useState<'read' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selection = useRef(0);
  const body = () => ({ fileName: file!.fileName, csv: file!.csv, xlsxBase64: file!.xlsxBase64, defaultGender: gender === 'none' ? null : gender, gradeMap: gradeMap.trim() });

  const choose = async (f: File | undefined) => {
    selection.current += 1;
    setFile(null);
    setPreview(null);
    setError(null);
    if (!f) return;
    const ticket = selection.current;
    setBusy('read');
    try {
      const loaded = await loadTableFile(f);
      if (selection.current === ticket) setFile(loaded);
    } catch (e) {
      if (selection.current === ticket) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const runPreview = async () => {
    if (!file) return;
    const ticket = selection.current;
    setBusy('preview');
    setError(null);
    try {
      const r = await api.post<TechnicianImportPreview>('/api/admin/technicians/import/preview', body());
      if (selection.current === ticket) setPreview(r);
    } catch (e) {
      if (selection.current === ticket) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    if (!file || !preview) return;
    setBusy('apply');
    setError(null);
    try {
      const r = await api.post<TechnicianImportPreview>('/api/admin/technicians/import', { ...body(), planHash: preview.planHash });
      setPreview(r);
      void qc.invalidateQueries({ queryKey: ['admin', 'technicians'] });
      void qc.invalidateQueries({ queryKey: ['technician-admin'] });
      toast({ tone: 'success', title: `已导入：新建 ${r.create} 位、更新 ${r.update} 位`, body: `不变 ${r.same} 位${r.groupsCreated.length ? `，新建分组 ${r.groupsCreated.join('、')}` : ''}` });
    } catch (e) {
      // 结果不明也不要紧：重新预览就看得出导没导进去（导进去了的都是「不变」），原样再导结果一样
      setError(`${errorMessage(e)}（请重新预览核对：已经导进去的会显示「不变」）`);
    } finally {
      setBusy(null);
    }
  };

  const can = preview && preview.errors.length === 0 && !preview.applied && preview.create + preview.update > 0;
  return (
    <Card className="p-5" data-testid="technician-import">
      <SectionTitle
        aside={
          <a
            href="/api/admin/technicians/import-template.csv"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line-strong px-3 text-[13px] font-semibold text-ink-2 hover:border-pine hover:text-pine"
            data-testid="technician-import-template"
          >
            <Download className="size-4" /> 下载模板
          </a>
        }
      >
        导入技师（Excel / CSV）
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        认得的表头：工号（技师号）、姓名、花名（昵称）、性别、电话（手机、手机号）、组别、身高、体重、星级、技师等级、入职日期；表头前面有说明行也认。
        工号已有的只更新表里有值、和名册不一样的花名、电话、组别、身高、体重、星级；姓名、性别、等级不改。有一处问题一行都不写。
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="文件">
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-line-strong px-3 text-[13px] font-semibold text-ink-2 hover:border-pine">
            <FileUp className="size-4" />
            {file ? file.fileName : busy === 'read' ? '读取中…' : '选择文件'}
            <input type="file" accept=".xlsx,.csv,text/csv" className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} data-testid="technician-import-file" />
          </label>
        </Field>
        <Field label="表里没写性别的新技师按">
          <Segmented
            ariaLabel="没写性别的按"
            value={gender}
            onChange={(v) => {
              setGender(v);
              setPreview(null);
            }}
            options={[
              { value: 'none', label: '要补上' },
              { value: 'female', label: '女' },
              { value: 'male', label: '男' },
            ]}
          />
        </Field>
        <Field label="等级对照（选填）" htmlFor="tech-import-grade" hint="旧系统把星级写在「技师等级」列时，如：一星=标准,五星=专业">
          <Input
            id="tech-import-grade"
            value={gradeMap}
            maxLength={300}
            onChange={(e) => {
              setGradeMap(e.target.value);
              setPreview(null);
            }}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" icon={<FileSearch className="size-4" />} disabled={!file} loading={busy === 'preview'} onClick={() => void runPreview()} data-testid="technician-import-preview">
          预览
        </Button>
        <Button variant="primary" disabled={!can} loading={busy === 'apply'} onClick={() => void apply()} data-testid="technician-import-apply">
          确认导入
        </Button>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {preview && (
        <div className="mt-4 space-y-3" data-testid="technician-import-result">
          <p className="text-[13px] text-ink-2">
            {preview.applied ? '已导入：' : '预览：'}表里 {preview.total} 行，新建 {preview.create}、更新 {preview.update}、不变 {preview.same}
            {preview.groupsCreated.length > 0 && `；新建分组 ${preview.groupsCreated.join('、')}`}
            {preview.groupsReactivated.length > 0 && `；重新启用 ${preview.groupsReactivated.join('、')}`}
          </p>
          {preview.errors.length > 0 && (
            <Notice tone="error" title={`有 ${preview.errors.length} 行要改，一行都不会导入`}>
              <ul className="mt-1 space-y-0.5 text-[12.5px]">
                {preview.errors.slice(0, 50).map((e) => (
                  <li key={`${e.line}-${e.message}`}>
                    第 {e.line} 行：{e.message}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          <DataTable
            variant="plain"
            rows={preview.rows}
            rowKey={(r) => r.line}
            className="max-h-80 overflow-auto"
            columns={[
              { key: 'line', header: '行', numeric: true, cell: (r) => r.line },
              { key: 'no', header: '工号', cell: (r) => <span className="num font-bold">{r.techNo}</span> },
              { key: 'name', header: '姓名', cell: (r) => r.name },
              {
                key: 'action',
                header: '做什么',
                cell: (r) => <Badge tone={r.action === 'create' ? 'pine' : r.action === 'update' ? 'lake' : 'neutral'}>{TECH_IMPORT_ACTION_LABELS[r.action]}</Badge>,
              },
              {
                key: 'changes',
                header: '内容',
                cell: (r) => (
                  <>
                    {r.changes.join('；')}
                    {r.notes.length > 0 && <span className="block text-ink-3">{r.notes.join('；')}</span>}
                  </>
                ),
              },
            ]}
          />
        </div>
      )}
    </Card>
  );
}
