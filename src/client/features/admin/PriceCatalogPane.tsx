// 全品类价目表（店主 2026-11-22《汤崎宝安全品类价目表录入系统需求说明》，docs/PRICE_CATALOG.md）：
// 后台 → 价目 → 「全品类价目表」。第一批导入成草稿；第二批（这里）：导入页面、条数对照（系统条数 / 表格条数，按摩分板块、
// 零点分餐段）、按工作表 / 板块 / 餐段分组列表、搜索（名称、编号、分类、房号）、只看待定价 / 停用、草稿与生效对比。
// 第三批：单条新增、修改（改价）、停用 / 启用（表单在 PriceEntryDialog.tsx），改动记录（经办人、时间、旧价 → 新价），
// 一键切换生效（条数与表格对不上要写原因）、整体回滚到上一版、放弃草稿。价格：无价格写「待定价」，不写 0 元；服务费写百分比。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileSearch, FileUp, History, Pencil, Plus, Search, Trash2, Undo2 } from 'lucide-react';
import {
  DISH_SECTIONS,
  PRICE_CHANGE_LABELS,
  MASSAGE_SECTIONS,
  PRICE_KIND_LABELS,
  PRICE_SHEET_NAMES,
  PRICE_SHEETS,
  countMismatches,
  diffPriceCatalogs,
  entryFacts,
  matchesPriceSearch,
  priceText,
  type PriceCatalogEntry,
  type PriceCatalogOverview,
  type PriceCatalogSet,
  type PriceCatalogSetSummary,
  type PriceChange,
  type PriceCountCheck,
  type PriceImportPreview,
  type PriceSheet,
} from '@shared/price-catalog';
import { formatYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { loadTableFile, type LoadedTable } from '../../lib/import-file';
import { formatDateTime, uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { Badge, Button, Card, Input, Notice, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { ChangeLines, PriceEntryDialog, PriceEntryHistory } from './PriceEntryDialog';

/** 价目表的查询都在这个前缀下：改了任何一处整体刷新（概要、条目、改动记录） */
const overviewKey = ['admin', 'price-catalog'] as const;
const setKey = (id: number) => ['admin', 'price-catalog', 'set', id] as const;

type Which = 'draft' | 'active';
type SheetFilter = 'all' | PriceSheet;
type Only = 'all' | 'none' | 'inactive';

export function PriceCatalogPane() {
  const overview = useQuery({ queryKey: overviewKey, queryFn: () => api.get<PriceCatalogOverview>('/api/admin/price-catalog') });
  const [which, setWhich] = useState<Which>('active');
  const data = overview.data;
  const shown = (which === 'draft' ? data?.draft : data?.active) ?? data?.active ?? data?.draft ?? null;
  const set = useQuery({ queryKey: setKey(shown?.id ?? 0), queryFn: () => api.get<PriceCatalogSet>(`/api/admin/price-catalog/sets/${shown!.id}`), enabled: !!shown });
  // 草稿与生效都有时，取另一份来对比
  const other = shown && data?.draft && data?.active ? (shown.id === data.draft.id ? data.active : data.draft) : null;
  const otherSet = useQuery({ queryKey: setKey(other?.id ?? 0), queryFn: () => api.get<PriceCatalogSet>(`/api/admin/price-catalog/sets/${other!.id}`), enabled: !!other });

  return (
    <div className="space-y-4" data-testid="price-catalog">
      <ImportCard onImported={() => setWhich('draft')} />
      {overview.isPending ? (
        <Skeleton className="h-48" />
      ) : overview.isError && !data ? (
        <LoadFailed title="价目表取不回来" onRetry={() => void overview.refetch()} />
      ) : !shown ? (
        <Notice tone="info" title="还没有全品类价目表">
          用上面的「导入」把《汤崎宝安全品类价目表》六张表导进来，先存成草稿，核对条数后再切换生效。
        </Notice>
      ) : (
        <>
          <Card className="p-5">
            <SectionTitle
              aside={
                data?.draft && data?.active ? (
                  <Segmented
                    size="sm"
                    value={shown.id === data.draft.id ? 'draft' : 'active'}
                    onChange={setWhich}
                    ariaLabel="看哪一份"
                    options={[
                      { value: 'active', label: '生效中' },
                      { value: 'draft', label: '草稿' },
                    ]}
                  />
                ) : undefined
              }
            >
              <span className="flex flex-wrap items-center gap-2">
                {shown.title}
                <Badge tone={shown.status === 'active' ? 'pine' : 'ember'}>{shown.status === 'active' ? '生效中' : '草稿'}</Badge>
              </span>
            </SectionTitle>
            <p className="mt-1 text-[12.5px] text-ink-3" data-testid="price-catalog-meta">
              {shown.fileName ? `导入自 ${shown.fileName} · ` : ''}
              {shown.createdByName} {formatDateTime(shown.createdAt)}
              {shown.activatedAt ? ` · ${shown.activatedByName} ${formatDateTime(shown.activatedAt)} 切换生效` : ''}
              {shown.status === 'draft' ? ' · 草稿不参与开单，核对无误后再切换生效' : ''}
            </p>
            {Object.entries(shown.notes).map(([k, v]) => (
              <p key={k} className="mt-1 text-[12.5px] text-ink-3">
                {k}（本次不录入）：{v}
              </p>
            ))}
            <SetActions shown={shown} previous={data?.previous ?? null} onDone={(which) => setWhich(which)} />
            <CountTable counts={shown.counts} total={shown.total} />
          </Card>
          {other && otherSet.data && set.data && <DiffCard current={set.data} other={otherSet.data} />}
          {set.isPending ? (
            <Skeleton className="h-64" />
          ) : set.isError && !set.data ? (
            <LoadFailed title="条目取不回来" onRetry={() => void set.refetch()} />
          ) : set.data ? (
            <EntryList key={set.data.id} setId={set.data.id} entries={set.data.entries} />
          ) : null}
          <ChangesCard setId={shown.id} />
        </>
      )}
    </div>
  );
}

// ───────────────────────── 条数对照 ─────────────────────────

type CountRow = Omit<PriceCountCheck, 'sheet'> & { sheet: PriceSheet | 'total' };

function CountTable({ counts, total }: { counts: PriceCountCheck[]; total: { expected: number; actual: number } }) {
  const ok = (c: { expected: number; actual: number }) => c.expected === c.actual;
  const rows: CountRow[] = [...counts, { sheet: 'total', name: '合计', expected: total.expected, actual: total.actual, parts: [] }];
  const columns: DataColumn<CountRow>[] = [
    { key: 'name', header: '工作表', cell: (c) => <span className="font-semibold">{c.name}</span>, dataLabel: '工作表' },
    { key: 'actual', header: '系统条数', numeric: true, cell: (c) => <span className="font-bold">{c.actual}</span>, dataLabel: '系统条数' },
    { key: 'expected', header: '表格条数', numeric: true, cell: (c) => <span className="text-ink-3">{c.expected}</span>, dataLabel: '表格条数' },
    {
      key: 'parts',
      header: '分项（系统 / 表格）',
      dataLabel: '分项',
      cell: (c) =>
        c.parts.length === 0 ? (
          <span className={`text-[12.5px] ${ok(c) ? 'text-pine' : 'font-bold text-clay'}`}>{ok(c) ? (c.sheet === 'total' ? '与表格一致' : '一致') : `差 ${c.actual - c.expected}`}</span>
        ) : (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px]">
            {c.parts.map((p) => (
              <span key={p.name} className={ok(p) ? 'text-ink-2' : 'font-bold text-clay'}>
                {p.name} {p.actual}/{p.expected}
              </span>
            ))}
          </span>
        ),
    },
  ];
  return (
    <DataTable
      className="mt-3"
      variant="plain"
      columns={columns}
      rows={rows}
      rowKey={(c) => c.sheet}
      rowTestId={(c) => `price-count-${c.sheet}`}
      rowClassName={(c) => (c.sheet === 'total' ? 'bg-paper-2/60 font-bold' : undefined)}
      testId="price-catalog-counts"
    />
  );
}

// ───────────────────────── 列表与搜索 ─────────────────────────

function EntryList({ setId, entries }: { setId: number; entries: PriceCatalogEntry[] }) {
  const qc = useQueryClient();
  const [sheet, setSheet] = useState<SheetFilter>('all');
  const [editing, setEditing] = useState<PriceCatalogEntry | 'new' | null>(null);
  const [history, setHistory] = useState<PriceCatalogEntry | null>(null);
  const [toggling, setToggling] = useState<PriceCatalogEntry | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: overviewKey });
  const toggle = async (e: PriceCatalogEntry, reason: string) => {
    try {
      await api.post(`/api/admin/price-catalog/entries/${e.id}/active`, { version: e.version, active: !e.active, reason });
      setNotice({ tone: 'success', text: `已${e.active ? '停用' : '启用'}「${e.name}」` });
    } catch (err) {
      setNotice({ tone: 'error', text: errorMessage(err) });
    } finally {
      setToggling(null);
      await refresh();
    }
  };
  const [section, setSection] = useState('');
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<Only>('all');
  const sections: readonly string[] = sheet === 'massage' ? MASSAGE_SECTIONS : sheet === 'dish' ? DISH_SECTIONS : [];
  const rows = useMemo(
    () =>
      entries.filter(
        (e) => (sheet === 'all' || e.sheet === sheet) && (!section || e.section === section) && (only === 'all' || (only === 'none' ? e.priceMode === 'none' : !e.active)) && matchesPriceSearch(e, q),
      ),
    [entries, sheet, section, q, only],
  );
  const columns: DataColumn<PriceCatalogEntry>[] = [
    {
      key: 'where',
      header: '分类',
      cell: (e) => (
        <span className="text-[12.5px] text-ink-3">{[PRICE_KIND_LABELS[e.kind], e.section && e.section !== PRICE_KIND_LABELS[e.kind] ? e.section : '', e.category].filter(Boolean).join(' · ')}</span>
      ),
      dataLabel: '分类',
    },
    { key: 'code', header: '编号', cell: (e) => <span className="num text-ink-3">{e.code}</span>, dataLabel: '编号' },
    {
      key: 'name',
      header: '名称',
      cell: (e) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{e.name}</span>
          {!e.orderable && <Badge tone="ember">不可下单</Badge>}
          {!e.active && <Badge>已停用</Badge>}
        </span>
      ),
      dataLabel: '名称',
    },
    {
      key: 'price',
      header: '价格',
      numeric: true,
      cell: (e) => (
        <span className={e.priceMode === 'none' ? 'text-ember-deep' : 'font-bold'} data-testid={`price-entry-price-${e.id}`}>
          {priceText(e, formatYuan)}
          {e.unit && e.priceMode !== 'none' && e.priceMode !== 'rate' ? <span className="ml-0.5 text-[12px] font-normal text-ink-3">/{e.unit}</span> : null}
        </span>
      ),
      dataLabel: '价格',
    },
    {
      key: 'facts',
      header: '规格',
      cell: (e) => (
        <span className="block max-w-[28rem] text-[12.5px] text-ink-2">
          {entryFacts(e, formatYuan).join(' · ')}
          {e.variants.length > 0 && <span className="block text-ink-3">{e.variants.map((v) => `${v.label}${v.priceCents !== null ? ` ${formatYuan(v.priceCents)}` : ''}`).join('；')}</span>}
        </span>
      ),
      dataLabel: '规格',
    },
    {
      key: 'actions',
      header: '',
      dataLabel: '操作',
      cell: (e) => (
        <span className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(e)} data-testid="price-entry-edit">
            改
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setToggling(e)} data-testid="price-entry-toggle">
            {e.active ? '停用' : '启用'}
          </Button>
          <Button size="sm" variant="ghost" icon={<History className="size-3.5" />} onClick={() => setHistory(e)} data-testid="price-entry-history-open">
            记录
          </Button>
        </span>
      ),
    },
  ];
  const noneCount = entries.filter((e) => e.priceMode === 'none').length;
  return (
    <Card className="p-5">
      <SectionTitle
        aside={
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="price-catalog-add">
            新增一项
          </Button>
        }
      >
        条目
      </SectionTitle>
      {notice && <Notice tone={notice.tone} title={notice.text} className="mt-3" data-testid="price-catalog-entry-notice" />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Segmented<SheetFilter>
          size="sm"
          value={sheet}
          onChange={(v) => {
            setSheet(v);
            setSection('');
          }}
          ariaLabel="工作表"
          options={[{ value: 'all', label: '全部' }, ...PRICE_SHEETS.map((s) => ({ value: s, label: PRICE_SHEET_NAMES[s].replace('价格', '') }))]}
        />
        {sections.length > 0 && (
          <Select fullWidth={false} value={section} onChange={(e) => setSection(e.target.value)} aria-label={sheet === 'massage' ? '板块' : '餐段'} className="h-9" data-testid="price-catalog-section">
            <option value="">{sheet === 'massage' ? '全部板块' : '全部餐段'}</option>
            {sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
        <Select fullWidth={false} value={only} onChange={(e) => setOnly(e.target.value as Only)} aria-label="只看" className="h-9" data-testid="price-catalog-only">
          <option value="all">全部状态</option>
          <option value="none">只看待定价（{noneCount}）</option>
          <option value="inactive">只看已停用</option>
        </Select>
        <span className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜名称、编号、分类、房号" className="pl-9" aria-label="搜索价目" data-testid="price-catalog-search" />
        </span>
      </div>
      <p className="mt-2 text-[12.5px] text-ink-3" data-testid="price-catalog-shown">
        共 {rows.length} 项{rows.length !== entries.length ? `（全部 ${entries.length} 项）` : ''}
      </p>
      <DataTable
        className="mt-2"
        columns={columns}
        rows={rows}
        rowKey={(e) => e.id ?? `${e.sheet}-${e.sortOrder}`}
        rowTestId={() => 'price-entry'}
        empty="没有符合条件的项目"
        testId="price-catalog-entries"
      />
      <PriceEntryDialog
        open={editing !== null}
        setId={setId}
        entry={editing === 'new' ? null : editing}
        defaultSheet={sheet === 'all' ? 'massage' : sheet}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          setNotice({ tone: 'success', text: `${editing === 'new' ? '已新增' : '已保存'}「${saved.name}」` });
          setEditing(null);
          void refresh();
        }}
      />
      <PriceEntryHistory setId={setId} entry={history} onClose={() => setHistory(null)} />
      <ReasonDialog
        open={!!toggling?.active}
        title={toggling ? `停用「${toggling.name}」` : ''}
        description="停用不删除：历史单据照旧显示名称与价格；停用的不算条数，需要时可以再启用。"
        confirmLabel="停用"
        danger
        testId="price-entry-off"
        onClose={() => setToggling(null)}
        onConfirm={(reason) => void (toggling && toggle(toggling, reason))}
      />
      <Dialog
        open={!!toggling && !toggling.active}
        onClose={() => setToggling(null)}
        title={toggling ? `启用「${toggling.name}」` : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setToggling(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void (toggling && toggle(toggling, ''))} data-testid="price-entry-on-confirm">
              启用
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">启用后重新算进条数；同一个板块 / 餐段、同一个分类里已经有同名在用的不能启用。</p>
      </Dialog>
    </Card>
  );
}

// ───────────────────────── 切换生效、回滚、放弃草稿（第三批） ─────────────────────────

function SetActions({ shown, previous, onDone }: { shown: PriceCatalogSetSummary; previous: PriceCatalogSetSummary | null; onDone: (which: Which) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<'activate' | 'rollback' | 'discard' | null>(null);
  const [rollbackKey, setRollbackKey] = useState(() => uuid());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatches = countMismatches(shown.counts);
  const run = async (path: string, body: unknown, which: Which) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/admin/price-catalog/${path}`, body);
      setOpen(null);
      onDone(which);
    } catch (e) {
      setError(errorMessage(e));
      setOpen(null);
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: overviewKey });
    }
  };
  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {shown.status === 'draft' && (
          <>
            <Button variant="primary" size="sm" icon={<Check className="size-4" />} onClick={() => setOpen('activate')} data-testid="price-catalog-activate">
              切换生效
            </Button>
            <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} onClick={() => setOpen('discard')} data-testid="price-catalog-discard">
              放弃草稿
            </Button>
          </>
        )}
        {shown.status === 'active' && previous && (
          <Button
            variant="secondary"
            size="sm"
            icon={<Undo2 className="size-4" />}
            onClick={() => {
              // 每次打开配一个新的操作编号；结果不确定再点一次用同一个
              setRollbackKey(uuid());
              setOpen('rollback');
            }}
            data-testid="price-catalog-rollback"
          >
            回滚到上一版「{previous.title}」
          </Button>
        )}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {mismatches.length > 0 ? (
        <ReasonDialog
          open={open === 'activate'}
          title={`切换生效「${shown.title}」`}
          description="条数与表格对不上，核对后写明为什么仍要切换（会记在审计里）。"
          label="仍要切换的原因"
          confirmLabel="仍然切换生效"
          busy={busy}
          testId="price-catalog-activate"
          extra={
            <ul className="mt-3 space-y-0.5 text-[12.5px] text-clay" data-testid="price-catalog-mismatches">
              {mismatches.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          }
          onClose={() => setOpen(null)}
          onConfirm={(countReason) => void run('activate', { draftId: shown.id, countReason }, 'active')}
        />
      ) : (
        <Dialog
          open={open === 'activate'}
          onClose={() => setOpen(null)}
          title={`切换生效「${shown.title}」`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(null)}>
                取消
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void run('activate', { draftId: shown.id }, 'active')} data-testid="price-catalog-activate-confirm">
                切换生效
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-ink-2">条数与表格一致（{shown.total.actual} 项）。切换后原来生效的那份换下来，可以整体回滚到它。</p>
        </Dialog>
      )}
      <ReasonDialog
        open={open === 'rollback'}
        title="整体回滚到上一版"
        description={previous ? `「${shown.title}」换下来，「${previous.title}」恢复生效（之后还能再回滚回来）。` : ''}
        label="回滚原因"
        confirmLabel="整体回滚"
        danger
        busy={busy}
        testId="price-catalog-rollback"
        onClose={() => setOpen(null)}
        onConfirm={(reason) => void run('rollback', { activeId: shown.id, reason, opKey: rollbackKey }, 'active')}
      />
      <Dialog
        open={open === 'discard'}
        onClose={() => setOpen(null)}
        title={`放弃草稿「${shown.title}」`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              取消
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void run('discard', { draftId: shown.id }, 'active')} data-testid="price-catalog-discard-confirm">
              放弃草稿
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">草稿和它的改动记录一起删掉（审计里留一条）；生效中的价目表不受影响。</p>
      </Dialog>
    </>
  );
}

// ───────────────────────── 改动记录（第三批） ─────────────────────────

function ChangesCard({ setId }: { setId: number }) {
  const [priceOnly, setPriceOnly] = useState(false);
  const q = useQuery({
    queryKey: ['admin', 'price-catalog', 'changes', setId, 'all', priceOnly],
    queryFn: () => api.get<PriceChange[]>(`/api/admin/price-catalog/sets/${setId}/changes${priceOnly ? '?priceOnly=1' : ''}`),
  });
  const columns: DataColumn<PriceChange>[] = [
    { key: 'at', header: '时间', cell: (c) => <span className="num text-[12.5px] text-ink-3">{formatDateTime(c.createdAt)}</span>, dataLabel: '时间' },
    { key: 'who', header: '经办人', cell: (c) => c.staffName, dataLabel: '经办人' },
    {
      key: 'what',
      header: '项目',
      cell: (c) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={c.priceChanged ? 'ember' : 'neutral'}>{PRICE_CHANGE_LABELS[c.action]}</Badge>
          <span className="font-semibold">{c.entryName}</span>
        </span>
      ),
      dataLabel: '项目',
    },
    { key: 'lines', header: '改了什么（旧 → 新）', cell: (c) => <ChangeLines change={c} />, dataLabel: '改了什么' },
    { key: 'reason', header: '原因', cell: (c) => <span className="text-ink-3">{c.reason || '—'}</span>, dataLabel: '原因' },
  ];
  return (
    <Card className="p-5" data-testid="price-catalog-changes">
      <SectionTitle
        aside={
          <Segmented
            size="sm"
            value={priceOnly ? 'price' : 'all'}
            onChange={(v) => setPriceOnly(v === 'price')}
            ariaLabel="看哪些改动"
            options={[
              { value: 'all', label: '全部改动' },
              { value: 'price', label: '只看改价' },
            ]}
          />
        }
      >
        改动记录
      </SectionTitle>
      {q.isPending ? (
        <Skeleton className="mt-3 h-24" />
      ) : q.isError ? (
        <LoadFailed title="改动记录取不回来" onRetry={() => void q.refetch()} />
      ) : (
        <DataTable className="mt-3" columns={columns} rows={q.data} rowKey={(c) => c.id} rowTestId={() => 'price-change'} empty="还没有改动：价格照导入时的表格" testId="price-catalog-change-list" />
      )}
    </Card>
  );
}

// ───────────────────────── 草稿与生效对比 ─────────────────────────

function DiffCard({ current, other }: { current: PriceCatalogSet; other: PriceCatalogSet }) {
  const draft = current.status === 'draft' ? current : other;
  const active = current.status === 'active' ? current : other;
  const diffs = useMemo(() => diffPriceCatalogs(draft.entries, active.entries), [draft, active]);
  const label = { added: '草稿新增', removed: '草稿里没有', changed: '改了价' } as const;
  return (
    <Card className="p-5" data-testid="price-catalog-diff">
      <SectionTitle>草稿与生效对比</SectionTitle>
      {diffs.length === 0 ? (
        <p className="mt-2 text-[13px] text-pine">草稿与生效中的价目表价格完全一致。</p>
      ) : (
        <ul className="mt-2 divide-y divide-line/70 rounded-lg border border-line text-[13px]">
          {diffs.map((d) => {
            const e = (d.draft ?? d.active)!;
            return (
              <li key={d.key} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="price-diff-row" data-change={d.change}>
                <Badge tone={d.change === 'removed' ? 'clay' : d.change === 'added' ? 'pine' : 'ember'}>{label[d.change]}</Badge>
                <span className="text-ink-3">{PRICE_SHEET_NAMES[e.sheet]}</span>
                <span className="font-semibold">{e.name}</span>
                <span className="ml-auto">
                  {d.active && <span className="text-ink-3">{priceText(d.active, formatYuan)}</span>}
                  {d.active && d.draft && <span className="mx-1 text-ink-4">→</span>}
                  {d.draft && <span className="font-bold">{priceText(d.draft, formatYuan)}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ───────────────────────── 导入 ─────────────────────────

/** 导入成草稿以后直接看草稿（onImported） */
function ImportCard({ onImported }: { onImported: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<LoadedTable | null>(null);
  const [preview, setPreview] = useState<(PriceImportPreview & { digest: string; opKey: string }) | null>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const choose = async (f: File | undefined) => {
    setPreview(null);
    setError(null);
    setDone(null);
    if (!f) return;
    try {
      const loaded = await loadTableFile(f);
      if (!loaded.xlsxBase64) throw new Error('价目表要用 Excel（.xlsx）导入：六张工作表在一个文件里');
      setFile(loaded);
    } catch (e) {
      setFile(null);
      setError(errorMessage(e));
    }
  };
  const runPreview = async () => {
    if (!file) return;
    setBusy('preview');
    setError(null);
    try {
      // 每次预览配一个操作编号：导入结果不确定（断网、超时）再点一次导入用同一个编号，服务端返回第一次的结果、不再替换草稿
      const p = await api.post<PriceImportPreview & { digest: string }>('/api/admin/price-catalog/import/preview', { fileName: file.fileName, xlsxBase64: file.xlsxBase64 });
      setPreview({ ...p, opKey: uuid() });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const runImport = async () => {
    if (!file || !preview) return;
    setBusy('import');
    setError(null);
    try {
      const set = await api.post<PriceCatalogSet>('/api/admin/price-catalog/import', { fileName: file.fileName, xlsxBase64: file.xlsxBase64, previewDigest: preview.digest, opKey: preview.opKey });
      setDone(`已存成草稿「${set.title}」：${set.total.actual} 项。核对下面的条数与价格，确认后再切换生效。`);
      setPreview(null);
      setFile(null);
      onImported();
      await qc.invalidateQueries({ queryKey: overviewKey });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const errors = preview?.issues.filter((i) => i.level === 'error') ?? [];
  const warnings = preview?.issues.filter((i) => i.level === 'warning') ?? [];
  return (
    <Card className="p-5" data-testid="price-catalog-import">
      <SectionTitle
        aside={
          <a
            href="/api/admin/price-catalog/template"
            download="价目表导入模板.xlsx"
            className="tap relative flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3 hover:text-ink"
            data-testid="price-catalog-template"
          >
            <Download className="size-4" />
            下载导入模板
          </a>
        }
      >
        导入全品类价目表
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        选《汤崎宝安全品类价目表》（六张工作表在一个 Excel 里）→ 预览逐行核对 → 没有问题再导入。导入先存成草稿（替换原来的草稿），不影响正在用的价格；核对条数后再切换生效。
      </p>
      <label className="mt-3 flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong px-4 py-3 text-[13px] hover:border-ink-3">
        <FileUp className="size-5 text-ink-3" />
        <span className="min-w-0 font-semibold break-all">{file ? file.fileName : '选择 Excel 文件（.xlsx）'}</span>
        <input type="file" accept=".xlsx" className="sr-only" aria-label="选择价目表" disabled={busy !== null} onChange={(e) => void choose(e.target.files?.[0])} data-testid="price-catalog-file" />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          icon={<FileSearch className="size-4" />}
          disabled={!file || busy !== null}
          loading={busy === 'preview'}
          onClick={() => void runPreview()}
          data-testid="price-catalog-preview"
        >
          预览
        </Button>
        <Button variant="primary" disabled={!preview || errors.length > 0 || busy !== null} loading={busy === 'import'} onClick={() => void runImport()} data-testid="price-catalog-apply">
          {preview && errors.length === 0 ? `导入成草稿（${preview.total.actual} 项）` : '导入成草稿'}
        </Button>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {done && <Notice tone="success" title={done} className="mt-3" data-testid="price-catalog-done" />}
      {preview && (
        <div className="mt-3 space-y-3" data-testid="price-catalog-preview-result">
          {errors.length > 0 ? (
            <Notice tone="error" title={`有 ${errors.length} 处问题，整份不能导入；改好表格再预览`} />
          ) : (
            <Notice tone="success" title={`没有问题：${preview.total.actual} 项（表格应有 ${preview.total.expected} 项）${warnings.length ? `，另有 ${warnings.length} 条提醒` : ''}`} />
          )}
          <CountTable counts={preview.counts} total={preview.total} />
          {preview.issues.length > 0 && (
            <ul className="max-h-72 divide-y divide-line/70 overflow-y-auto rounded-lg border border-line text-[12.5px]" data-testid="price-catalog-issues">
              {preview.issues.map((i, n) => (
                <li key={n} className="flex flex-wrap gap-x-2 px-3 py-1.5" data-level={i.level}>
                  <Badge tone={i.level === 'error' ? 'clay' : 'ember'}>{i.level === 'error' ? '问题' : '提醒'}</Badge>
                  <span className="text-ink-3">
                    {i.sheet}
                    {i.row !== null ? ` 第 ${i.row} 行` : ''} · {i.field}
                  </span>
                  <span>{i.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
