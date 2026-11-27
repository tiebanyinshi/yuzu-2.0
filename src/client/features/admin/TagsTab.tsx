import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileUp, Lock, Nfc, Plus, ShieldCheck, Trash2, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import {
  MAX_VIP_LEVEL,
  TAG_CODE_PATTERN,
  TAG_GENERATE_MAX,
  TAG_KIND_LABELS,
  TAG_SERVICE_LABELS,
  TAG_SERVICE_STATUSES,
  TAG_ZONES,
  ZONE_LABELS,
  ZONES,
  type FrontdeskRules,
  type HandTag,
  type TagKind,
  type TagServiceStatus,
  type Zone,
} from '@shared/frontdesk';
import { CARD_UID_PATTERN, normalizeCardUid, type FrontdeskRiskRules } from '@shared/frontdesk-risk';
import { MAX_OVERTIME_HOURLY_CENTS } from '@shared/frontdesk-v8117';
import { parseHandTagCsv, type HandTagCsvResult, type HandTagImportReport } from '@shared/hand-tag-import';
import { formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { readImportFile } from '../../lib/import-file';
import { useCan, useReasons, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { groupTags, tagKindText, TAG_SERVICE_STYLE, VipChip, ZoneChip, ZONE_STYLE } from '../frontdesk/parts';
import { BlacklistPane } from '../frontdesk/blacklist';
import { ReaderStatusLine, useCardReader, type CardMessage } from '../frontdesk/TagCardInput';
import { SubPane } from '../../components/SubNav';
import { AdminPage } from './AdminShell';
import { BuyCodesCard } from './BuyCodesCard';
import { CashierRulesCard } from './CashierRulesCard';
import { GuestRulesCard } from './GuestRulesCard';

type AdminTag = HandTag & { inUse: boolean; lockedByName: string | null; lockedAt: string | null; cardUid: string | null };

const LEVELS = Array.from({ length: MAX_VIP_LEVEL }, (_, i) => i + 1);

/**
 * 手牌池：按清单导入、按规则批量添加（2026-11-24）、改牌号与删除、暂停 / 维修、锁定 / 解锁、改分区与柜型、停用；前台规则（更正时限、丢牌赔偿、VIP 等级）。
 * 8.1.15（docs/FRONTDESK_RISK_V8115.md）：手牌绑 / 解绑芯片号（点一张牌）、发牌前风控的开关（前台规则页签）、黑名单页签
 */
export function TagsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const tags = useQuery({ queryKey: ['frontdesk', 'tags'], queryFn: () => api.get<AdminTag[]>('/api/frontdesk/tags') });
  const rules = useQuery({ queryKey: ['frontdesk', 'rules'], queryFn: () => api.get<FrontdeskRules>('/api/frontdesk/rules') });
  const [editing, setEditing] = useState<AdminTag | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['frontdesk'] });
  };

  // 二级页签（8.0.17）：规则 → 清单 → 导入与工具。前台规则只有能改经营规则的岗位（店主）能改；
  // 值班经理在这里只维护手牌池，看不到「前台规则」这个页签
  const tabs = [
    ...(can('settings.manage') ? [{ key: 'rules', label: '前台规则' }] : []),
    // 8.2.3：客人类别、偏好字段、客诉标签、区域拥挤与高风险提示（docs/V8223_FRONTDESK.md）
    ...(can('settings.manage') ? [{ key: 'guest', label: '客人与提醒' }] : []),
    { key: 'pool', label: '手牌池' },
    ...(can('frontdesk.blacklist') ? [{ key: 'blacklist', label: '黑名单' }] : []),
    { key: 'create', label: '批量添加与导入' },
  ];
  return (
    <AdminPage section="tags" description="前台规则、手牌池（分区、VIP 柜、芯片号、暂停 / 维修、锁定与停用）、黑名单、按规则批量生成与柜号清单导入。" tabs={tabs}>
      {can('settings.manage') && (
        <SubPane tab="rules" className="space-y-5">
          <RulesCard
            rules={rules.data}
            onSaved={() => {
              refresh();
              toast({ tone: 'success', title: '前台规则已保存' });
            }}
          />
          <RiskSwitchCard />
          {/* 8.2.1 收银台：单项打折各档的下限、手牌押金先填好的金额 */}
          <CashierRulesCard
            rules={rules.data}
            onSaved={() => {
              refresh();
              toast({ tone: 'success', title: '收银台规则已保存' });
            }}
          />
          {/* 8.1.44 收银台买角：数字代号 → 项目（清单待业务提供） */}
          <BuyCodesCard
            rules={rules.data}
            onSaved={() => {
              refresh();
              toast({ tone: 'success', title: '买角代号已保存' });
            }}
          />
        </SubPane>
      )}
      {can('settings.manage') && (
        <SubPane tab="guest">
          <GuestRulesCard />
        </SubPane>
      )}
      {can('frontdesk.blacklist') && (
        <SubPane tab="blacklist">
          <BlacklistPane />
        </SubPane>
      )}
      <SubPane tab="create" className="space-y-5">
        <ErpPendingPanel types={['hand_tag_generate']} className="space-y-2" onFound={refresh} />
        <GenerateCard onCreated={refresh} />
        <ImportCard onImported={refresh} />
      </SubPane>

      <SubPane tab="pool">
        <Card className="p-5">
          <SectionTitle>手牌池</SectionTitle>
          <p className="mt-1 text-[12.5px] text-ink-3">
            点一张手牌可改牌号、分区与柜型，标「暂停使用 / 维修中」，锁定 / 解锁、停用、删除，或绑定 / 解绑芯片号（绑了的牌带 <Nfc className="inline size-3.5 align-[-2px]" />{' '}
            标，发牌时刷卡就能带出牌号）。在店手牌不能改牌号、删除、标暂停或维修，请先在前台给客人换牌。
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3" data-testid="tag-pool-legend">
            <span className="rounded-md border border-line bg-card px-2 py-0.5 font-semibold text-ink-2">空闲</span>
            <span className={cn('rounded-md border px-2 py-0.5 font-semibold', TAG_SERVICE_STYLE.paused)}>{TAG_SERVICE_LABELS.paused}</span>
            <span className={cn('rounded-md border px-2 py-0.5 font-semibold', TAG_SERVICE_STYLE.repair)}>{TAG_SERVICE_LABELS.repair}</span>
            <span className="rounded-md border border-clay/40 bg-clay-soft/60 px-2 py-0.5 font-semibold text-clay">锁定</span>
            <span className="rounded-md border border-line bg-paper-2 px-2 py-0.5 font-semibold text-ink-4 line-through">停用</span>
            <span>在店的按分区颜色显示；暂停、维修、锁定、停用的前台都发不出</span>
          </p>
          {tags.isPending ? (
            <Skeleton className="mt-3 h-40" />
          ) : tags.data?.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">还没有手牌，先在上方导入柜号清单</p>
          ) : (
            TAG_ZONES.map((z) => {
              const list = tags.data?.filter((t) => t.zone === z) ?? [];
              if (list.length === 0) return null;
              return (
                <div key={z} className="mt-5" data-testid={`admin-zone-${z}`}>
                  <p className="mb-2 flex flex-wrap items-center gap-2 text-[13px] font-semibold text-ink-3">
                    <ZoneChip zone={z} size="md" /> 共 {list.length} 张 · 在店 {list.filter((t) => t.inUse).length} · 锁定 {list.filter((t) => t.locked).length} · 停用{' '}
                    {list.filter((t) => !t.active).length} · 暂停 {list.filter((t) => t.serviceStatus === 'paused').length} · 维修 {list.filter((t) => t.serviceStatus === 'repair').length} · 已绑芯片{' '}
                    {list.filter((t) => t.cardUid).length}
                    {z === 'child' && <span className="text-clay">儿童区已取消，请把这些牌改为男宾或女宾，或停用</span>}
                  </p>
                  {groupTags(list).map((g) => (
                    <div key={g.key} className="mb-3">
                      <p className="mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold text-ink-3">
                        {g.kind === 'vip' ? <VipChip level={g.vipLevel!} size="md" /> : <span className="font-bold text-ink-2">{g.area ? `${g.area} 区` : '普通柜'}</span>}
                        <span className="num">{g.tags.length} 张</span>
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {g.tags.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setEditing(t)}
                            title={`${t.locked ? `锁定：${t.lockReason}` : t.inUse ? '在店' : !t.active ? '已停用' : t.serviceStatus !== 'normal' ? `${TAG_SERVICE_LABELS[t.serviceStatus]}${t.serviceNote ? `：${t.serviceNote}` : ''}` : '空闲'}${t.cardUid ? ` · 芯片号 ${t.cardUid}` : ' · 没绑芯片号'}`}
                            data-testid={`admin-tag-${t.code}`}
                            data-card={t.cardUid ?? ''}
                            data-service={t.serviceStatus}
                            className={cn(
                              'num flex h-8 items-center gap-1 rounded-md border px-2.5 text-[13px] font-bold',
                              !t.active
                                ? 'border-line bg-paper-2 text-ink-4 line-through'
                                : t.locked
                                  ? 'border-clay/40 bg-clay-soft/60 text-clay'
                                  : t.serviceStatus !== 'normal'
                                    ? TAG_SERVICE_STYLE[t.serviceStatus]
                                    : t.inUse
                                      ? cn('border-transparent', ZONE_STYLE[t.zone].chip)
                                      : 'border-line bg-card text-ink-2 hover:border-line-strong',
                            )}
                          >
                            {t.locked && <Lock className="size-3" />}
                            {!t.locked && t.serviceStatus === 'repair' && <Wrench className="size-3" />}
                            {t.code}
                            {t.cardUid && <Nfc className="size-3 opacity-70" aria-label="已绑芯片号" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </Card>
      </SubPane>

      {editing && (
        <TagDialog
          tag={editing}
          onClose={() => setEditing(null)}
          onDone={(msg) => {
            setEditing(null);
            refresh();
            toast({ tone: 'success', title: msg });
          }}
        />
      )}
    </AdminPage>
  );
}

// ───────────────────────── 按清单导入 ─────────────────────────

function ImportCard({ onImported }: { onImported: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<HandTagCsvResult | null>(null);
  const [deactivateMissing, setDeactivateMissing] = useState(false);
  const [preview, setPreview] = useState<HandTagImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (dryRun: boolean, rows = parsed?.rows ?? [], deactivate = deactivateMissing) => {
    setBusy(true);
    setError(null);
    try {
      const report = await api.post<HandTagImportReport>('/api/frontdesk/tags/import', { rows, deactivateMissing: deactivate, dryRun });
      if (dryRun) {
        setPreview(report);
      } else {
        toast({
          tone: 'success',
          title: `已导入 ${report.total} 个柜号`,
          body: `新建 ${report.created} · 更新 ${report.updated} · 未变 ${report.unchanged}${report.deactivated ? ` · 停用 ${report.deactivated}` : ''}${report.blocked.length ? ` · ${report.blocked.length} 张在店未改` : ''}`,
        });
        setParsed(null);
        setPreview(null);
        setFileName('');
        onImported();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    setPreview(null);
    setError(null);
    if (!file) return;
    let loaded: Awaited<ReturnType<typeof readImportFile>>;
    try {
      loaded = await readImportFile(file);
    } catch (e) {
      setFileName(file.name);
      setParsed(null);
      setError(errorMessage(e));
      return;
    }
    setFileName(loaded.label);
    const result = parseHandTagCsv(loaded.text);
    setParsed(result);
    if (result.errors.length === 0) await run(true, result.rows, deactivateMissing);
  };

  return (
    <Card className="p-5" data-testid="tag-import">
      <SectionTitle>
        <span className="flex items-center gap-2">按清单导入柜号</span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        CSV 列为 <code className="num">code,gender,kind,area,vip_level</code>（与 docs/data/hand-tags-2026-10-27.csv
        相同）。先预览再导入；已有牌号以清单为准更新分区、柜型与等级，锁定状态不变，在店的手牌不改。
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="tag-import-file" />
        <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()} loading={busy && !preview}>
          选择 CSV 文件
        </Button>
        {fileName && <span className="num text-[13px] text-ink-2">{fileName}</span>}
      </div>
      <div className="mt-3">
        <ConfirmCheck
          checked={deactivateMissing}
          onChange={(v) => {
            setDeactivateMissing(v);
            if (parsed && parsed.errors.length === 0) void run(true, parsed.rows, v);
          }}
        >
          同时停用不在清单里的手牌
          <span className="block text-[12.5px] font-normal text-ink-3">例如试用期间按号段建的旧牌；有在店客人的不会停用</span>
        </ConfirmCheck>
      </div>

      {parsed && parsed.errors.length > 0 && (
        <Notice tone="error" title={`清单有 ${parsed.errors.length} 处需要修改，未导入`} className="mt-3">
          <ul className="mt-1 space-y-0.5 text-[12.5px]">
            {parsed.errors.slice(0, 8).map((e) => (
              <li key={`${e.line}-${e.message}`}>
                第 {e.line} 行：{e.message}
              </li>
            ))}
            {parsed.errors.length > 8 && <li>……共 {parsed.errors.length} 处</li>}
          </ul>
        </Notice>
      )}

      {preview && (
        <div className="mt-3 space-y-3" data-testid="tag-import-preview">
          <p className="text-[13.5px] text-ink-2">
            清单共 <b className="num">{preview.total}</b> 个柜号：新建 <b className="num">{preview.created}</b> · 更新 <b className="num">{preview.updated}</b> · 未变{' '}
            <b className="num">{preview.unchanged}</b>
            {deactivateMissing && (
              <>
                {' '}
                · 停用清单外 <b className="num">{preview.deactivated}</b>
              </>
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {preview.groups.map((g) => (
              <span key={`${g.zone}-${g.kind}-${g.vipLevel}-${g.area}`} className="flex items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-1 text-[12.5px] font-semibold">
                <ZoneChip zone={g.zone} />
                {g.kind === 'vip' ? <VipChip level={g.vipLevel!} /> : <span>{g.area ? `${g.area} 区` : TAG_KIND_LABELS.normal}</span>}
                <span className="num text-ink-3">{g.count}</span>
              </span>
            ))}
          </div>
          {preview.blocked.length > 0 && (
            <Notice tone="warning" title={`${preview.blocked.length} 张在店手牌不会改动`}>
              {preview.blocked
                .slice(0, 6)
                .map((b) => `${b.code}（${b.reason}）`)
                .join('；')}
            </Notice>
          )}
          <Button variant="primary" loading={busy} onClick={() => void run(false)} data-testid="tag-import-confirm">
            确认导入 {preview.total} 个柜号
          </Button>
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Card>
  );
}

// ───────────────────────── 按规则批量添加 ─────────────────────────

type GeneratePlan = { codes: string[]; skippedByRule: number; skippedExisting: string[]; exhausted: boolean; created: number };
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** 一排 0–9 的数字开关（排除规则用） */
function DigitPicker({ value, onChange, label, testId }: { value: number[]; onChange: (v: number[]) => void; label: string; testId: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label} data-testid={testId}>
      {DIGITS.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())}
            className={cn('num size-9 rounded-md border text-[14px] font-bold', on ? 'border-clay bg-clay-soft text-clay line-through' : 'border-line bg-card text-ink-2 hover:border-line-strong')}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 按规则批量添加（店主 2026-11-24，docs/FRONTDESK_TAGS_V8127.md）：数量、起始号码、位数、前缀，排除尾数 / 含某数字的号；
 * 已有的牌号（含删除了的）自动跳过、接着往后凑够数量，不会重号。先预览，再生成；改了规则要重新预览。
 */
function GenerateCard({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const session = useSession();
  const blocked = useErpRecorded(['hand_tag_generate']).length > 0;
  const [zone, setZone] = useState<Zone>('male');
  const [kind, setKind] = useState<TagKind>('normal');
  const [vipLevel, setVipLevel] = useState(1);
  const [prefix, setPrefix] = useState('A');
  const [start, setStart] = useState('1');
  const [count, setCount] = useState('50');
  const [width, setWidth] = useState('3');
  const [skipEnd, setSkipEnd] = useState<number[]>([4]);
  const [skipAny, setSkipAny] = useState<number[]>([]);
  const [plan, setPlan] = useState<{ key: string; result: GeneratePlan } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = Number(start);
  const c = Number(count);
  const w = Number(width);
  const problem = !/^[A-Z]{0,2}$/.test(prefix)
    ? '前缀只能是 0–2 个英文字母'
    : start.trim() === '' || !Number.isInteger(s) || s < 0
      ? '起始号码要是 0 或正整数'
      : !Number.isInteger(w) || w < 1 || w > 5
        ? '位数 1–5'
        : String(s).length > w
          ? '起始号码的位数超过了设定位数'
          : !Number.isInteger(c) || c < 1 || c > TAG_GENERATE_MAX
            ? `数量 1–${TAG_GENERATE_MAX}`
            : new Set([...skipEnd, ...skipAny]).size >= 10
              ? '排除的数字不能把 0–9 都排除了'
              : null;
  const body = { prefix, start: s, count: c, width: w, zone, kind, vipLevel: kind === 'vip' ? vipLevel : null, skipEndDigits: skipEnd, skipAnyDigits: skipAny };
  const key = JSON.stringify(body);
  const current = plan?.key === key ? plan.result : null;

  const call = async (preview: boolean) => {
    // 上一次批量添加的结果待确认：先在上方查回、原样重提或作废，免得原来那次晚到又多建一批
    if (!preview && blocked) return setError('上一次批量添加的结果待确认：请先在上方查回、按原内容重新提交或作废，再添加');
    setBusy(true);
    setError(null);
    try {
      if (preview) {
        setPlan({ key, result: await api.post<GeneratePlan>('/api/frontdesk/tags/generate', { ...body, preview: true }) });
        return;
      }
      // 添加带操作编号：先记在本机再发，没收到结果时按原编号查回、原样重提（返回第一次的结果）或确认作废
      const op = uuid();
      const r = await sendErpOp<GeneratePlan>({
        key: op,
        type: 'hand_tag_generate',
        url: '/api/frontdesk/tags/generate',
        body: { ...body, clientKey: op, storeId: session.store.id },
        summary: `手牌批量添加 · ${ZONE_LABELS[zone].title} ${current?.codes.length ?? c} 张（${current?.codes[0] ?? ''} 起）`,
        staffName: session.staff.displayName,
      });
      setPlan(null);
      toast({ tone: 'success', title: `已添加 ${r.created} 张${ZONE_LABELS[zone].title}牌`, body: `${r.codes[0]} – ${r.codes[r.codes.length - 1]}` });
      onCreated();
    } catch (e) {
      if (e instanceof UncertainError) {
        setPlan(null);
        toast({ tone: 'info', title: '批量添加结果待确认', body: '已记在本机：请在上方查回、按原内容重新提交或作废；确认前不要再添加。' });
      } else {
        setError(errorMessage(e));
        if (!preview && !(e instanceof ErpPendingStoreError)) setPlan(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="tag-generate">
      <SectionTitle aside={<PendingBadge title="排除规则的默认值（排除尾数 4）待确认（docs/PENDING_DECISIONS.md PC32）" />}>按规则批量添加</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        从起始号码往后数，按排除规则跳过不要的号（比如尾数是 4、7 的），已有的牌号自动跳过、接着往后补，凑够数量，不会重号。分区决定能发给哪类宾客，VIP 柜按等级使用。先预览，确认再添加。
      </p>
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap gap-3">
          <Segmented value={zone} onChange={setZone} ariaLabel="分区" options={ZONES.map((z) => ({ value: z, label: ZONE_LABELS[z].title }))} />
          <Segmented
            value={kind}
            onChange={(k) => {
              setKind(k);
              setPrefix(k === 'vip' ? '' : 'A');
            }}
            ariaLabel="柜型"
            options={[
              { value: 'normal', label: TAG_KIND_LABELS.normal },
              { value: 'vip', label: TAG_KIND_LABELS.vip },
            ]}
          />
          {kind === 'vip' && (
            <Select value={vipLevel} onChange={(e) => setVipLevel(Number(e.target.value))} fullWidth={false} aria-label="VIP 等级" className="w-32">
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  第 {l} 级
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="数量" hint={`一次最多 ${TAG_GENERATE_MAX} 张`}>
            <Input value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" className="num" data-testid="gen-count" />
          </Field>
          <Field label="起始号码">
            <Input value={start} onChange={(e) => setStart(e.target.value)} inputMode="numeric" className="num" data-testid="gen-start" />
          </Field>
          <Field label="数字位数" hint="不足补 0">
            <Input value={width} onChange={(e) => setWidth(e.target.value)} inputMode="numeric" className="num" data-testid="gen-width" />
          </Field>
          <Field label="前缀（区号）" hint="0–2 个字母，可不填">
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} maxLength={2} className="num" data-testid="gen-prefix" />
          </Field>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Field label="排除尾数" hint="尾数是这些数字的号跳过">
            <DigitPicker value={skipEnd} onChange={setSkipEnd} label="排除尾数" testId="gen-skip-end" />
          </Field>
          <Field label="排除含有" hint="任何一位含这些数字的号都跳过（比尾数更严）">
            <DigitPicker value={skipAny} onChange={setSkipAny} label="排除含有的数字" testId="gen-skip-any" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" icon={<Eye className="size-4" />} disabled={!!problem} loading={busy && !current} onClick={() => call(true)} data-testid="gen-preview">
            预览
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} disabled={!!problem || !current} loading={busy && !!current} onClick={() => call(false)} data-testid="gen-create">
            {current ? `添加这 ${current.codes.length} 张` : '添加'}
          </Button>
          {problem ? <span className="text-[13px] text-clay">{problem}</span> : !current && <span className="text-[13px] text-ink-3">先预览，看清楚要添加哪些号</span>}
        </div>
        {current && (
          <div className="rounded-lg border border-line bg-paper/60 p-4" data-testid="gen-plan">
            <p className="text-[13px] text-ink-2">
              将添加 <b className="num">{current.codes.length}</b> 张{ZONE_LABELS[zone].title}
              {kind === 'vip' ? ` VIP 第 ${vipLevel} 级柜` : '普通柜'}
              {current.skippedByRule > 0 && (
                <>
                  ，按排除规则跳过 <b className="num">{current.skippedByRule}</b> 个号
                </>
              )}
              {current.skippedExisting.length > 0 && (
                <>
                  ，已有（或删除过）的 <b className="num">{current.skippedExisting.length}</b> 个号跳过
                </>
              )}
            </p>
            {current.exhausted && current.codes.length < c && (
              <p className="mt-1 text-[12.5px] text-clay">
                {w} 位数的号码用完了，只凑出 {current.codes.length} 张；要更多请加大位数或换前缀
              </p>
            )}
            <div className="mt-2 flex max-h-40 flex-wrap gap-1 overflow-y-auto">
              {current.codes.map((code) => (
                <span key={code} className="num rounded border border-line bg-card px-1.5 py-0.5 text-[12.5px] font-semibold">
                  {code}
                </span>
              ))}
            </div>
          </div>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Card>
  );
}

// ───────────────────────── 前台规则 ─────────────────────────

const yuan = (cents: number) => String(cents / 100);

function RulesCard({ rules, onSaved }: { rules: FrontdeskRules | undefined; onSaved: () => void }) {
  const [minutes, setMinutes] = useState('');
  const [fee, setFee] = useState('');
  const [grace, setGrace] = useState('0');
  /** 超时加收：每超 1 小时多少（元，8.1.17 BW-1）；0 = 不算价 */
  const [hourly, setHourly] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!rules) return;
    setMinutes(String(rules.selfVoidMinutes));
    setFee(yuan(rules.lostTagFeeCents));
    setGrace(String(rules.overtimeGraceMinutes ?? 0));
    setHourly(yuan(rules.overtimeSurchargeHourlyCents ?? 0));
  }, [rules]);

  const n = Number(minutes);
  const g = Number(grace);
  const feeCents = parseYuan(fee);
  const hourlyCents = hourly.trim() === '' ? 0 : parseYuan(hourly);
  const problem =
    !Number.isInteger(n) || n < 0 || n > 120
      ? '更正时限应为 0–120 分钟'
      : !Number.isInteger(g) || g < 0 || g > 120
        ? '跳档宽限应为 0–120 分钟'
        : feeCents === null
          ? '丢牌赔偿金额不正确'
          : hourlyCents === null || hourlyCents < 0 || hourlyCents > MAX_OVERTIME_HOURLY_CENTS
            ? `超时加收每小时填 0 到 ${formatYuan(MAX_OVERTIME_HOURLY_CENTS)}`
            : null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/frontdesk/rules', {
        selfVoidMinutes: n,
        lostTagFeeCents: feeCents,
        overtimeGraceMinutes: g,
        overtimeSurchargeHourlyCents: hourlyCents,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="frontdesk-rules">
      <SectionTitle>前台规则</SectionTitle>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="店员自行更正时限（分钟）" hint="店员可在此时间内作废本人登记的明细、撤销本人开的牌；超时或他人登记的由值班经理、店总处理">
          <Input value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" className="num" aria-label="店员自行更正时限" />
        </Field>
        <Field label="丢牌赔偿（元）" hint="换牌原因为手牌丢失时挂到客人账单；填 0 表示不收">
          <Input value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" className="num" aria-label="丢牌赔偿" />
        </Field>
        <Field
          label={
            <span className="flex items-center gap-1.5">
              门票跳档宽限（分钟） <PendingBadge title="店主 ❓6：默认 0（超过 12 小时分界点即跳档），待确认" />
            </span>
          }
          hint="每个 12 小时分界点之后多少分钟内不跳档；0 表示超过即跳档"
        >
          <Input value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="numeric" className="num" aria-label="门票跳档宽限" data-testid="rules-grace" />
        </Field>
        <Field
          label={
            <span className="flex items-center gap-1.5">
              超时加收：每超 1 小时（元） <PendingBadge title="8.1.17 BW1：默认 0（不算价）；超过 12 小时以后不足 1 小时按 1 小时算，待确认" />
            </span>
          }
          hint="在店超过 12 小时以后，客人卡上点「加收」时按超了几个小时（不足 1 小时按 1 小时）× 这个价先填好金额，照旧要人确认、照旧的权限与授权，不自动收钱；填 0 不算价（照旧手填）"
        >
          <MoneyInput value={hourly} onChange={(e) => setHourly(e.target.value)} aria-label="超时加收每小时" data-testid="rules-overtime-hourly" />
        </Field>
      </div>

      {/* VIP 柜（8.0.4 起归「会员权益」，docs/MEMBERSHIP_V804.md 第 2 节）：原来这里的当场授权开关搬过去了，这里只留跳转 */}
      <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper/60 p-4" data-testid="vip-moved">
        <ShieldCheck className="size-5 shrink-0 text-pine" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-bold text-ink">VIP 柜已移到「会员权益」</p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">各档能用到几级 VIP 柜、当场授权散客或等级不够的会员使用 VIP 柜，都在「会员权益 → VIP 柜」设置；原来的设置已原样搬过去。</p>
        </div>
        <Link to="/admin/vip-lockers" className="inline-flex h-9 items-center rounded-full bg-pine px-4 text-[13px] font-semibold text-paper hover:bg-pine/90" data-testid="vip-moved-link">
          去设置
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!rules || !!problem} loading={busy} onClick={save} data-testid="frontdesk-rules-save">
          保存前台规则
        </Button>
        {problem && <span className="text-[13px] text-clay">{problem}</span>}
        {!problem && rules && <span className="text-[12.5px] text-ink-3">当前丢牌赔偿 {formatYuan(rules.lostTagFeeCents)}</span>}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Card>
  );
}

// ───────────────────────── 单张手牌 ─────────────────────────

function TagDialog({ tag, onClose, onDone }: { tag: AdminTag; onClose: () => void; onDone: (message: string) => void }) {
  const legacy = tag.zone === 'child';
  const lockReasons = useReasons('lockReasons');
  const [zone, setZone] = useState<Zone>(tag.zone === 'child' ? 'male' : tag.zone);
  const [kind, setKind] = useState<TagKind>(tag.kind);
  const [vipLevel, setVipLevel] = useState(tag.vipLevel ?? 1);
  const [active, setActive] = useState(tag.active);
  const [code, setCode] = useState(tag.code);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeOk = TAG_CODE_PATTERN.test(code.trim().toUpperCase());
  const changed = legacy || code.trim().toUpperCase() !== tag.code || zone !== tag.zone || active !== tag.active || kind !== tag.kind || (kind === 'vip' && vipLevel !== tag.vipLevel);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone(message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          手牌 <span className="num">{tag.code}</span> <ZoneChip zone={tag.zone} size="md" />
          {tag.kind === 'vip' && <VipChip level={tag.vipLevel!} size="md" />}
          {tag.inUse && <Badge tone="pine">在店</Badge>}
          {tag.locked && <Badge tone="clay">已锁定</Badge>}
          {tag.serviceStatus !== 'normal' && (
            <span className={cn('rounded-full border px-2 py-0.5 text-[12px] font-semibold', TAG_SERVICE_STYLE[tag.serviceStatus])}>{TAG_SERVICE_LABELS[tag.serviceStatus]}</span>
          )}
        </span>
      }
      description={tagKindText(tag)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="primary"
            disabled={busy || !changed || !codeOk}
            data-testid="tag-save"
            onClick={() =>
              run(
                () => api.put(`/api/frontdesk/tags/${tag.id}`, { code: code.trim().toUpperCase(), zone, active, kind, vipLevel: kind === 'vip' ? vipLevel : null }),
                `${code.trim().toUpperCase()} 已更新`,
              )
            }
          >
            保存修改
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {legacy && (
          <Notice tone="warning" title="这是已取消的儿童区手牌">
            请改为男宾或女宾后保存，或选择停用。
          </Notice>
        )}
        <Field label="牌号" hint={tag.inUse ? '在店的不能改牌号' : '只有没发过的牌能改号（历史单据按牌号显示）；0–2 个字母加 1–5 位数字'}>
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={7} disabled={tag.inUse} className="num w-40" data-testid="tag-code" />
        </Field>
        <Field label="分区">
          <Segmented value={zone} onChange={setZone} options={ZONES.map((z) => ({ value: z, label: ZONE_LABELS[z].title }))} />
        </Field>
        <Field label="柜型">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              value={kind}
              onChange={setKind}
              options={[
                { value: 'normal', label: TAG_KIND_LABELS.normal },
                { value: 'vip', label: TAG_KIND_LABELS.vip },
              ]}
            />
            {kind === 'vip' && (
              <Select value={vipLevel} onChange={(e) => setVipLevel(Number(e.target.value))} fullWidth={false} aria-label="VIP 等级" className="w-32">
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    第 {l} 级
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Field>
        <Field label="启用">
          <Segmented
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        </Field>
        <TagServiceField tag={tag} onDone={onDone} />
        <TagCardField tag={tag} onDone={onDone} />
        <div className="rounded-lg border border-line bg-paper/60 p-4">
          {tag.locked ? (
            <>
              <p className="text-[13.5px]">
                锁定原因：<b>{tag.lockReason}</b>
                {tag.lockedByName && <span className="text-ink-3"> · {tag.lockedByName}</span>}
              </p>
              <Button className="mt-3" variant="secondary" loading={busy} onClick={() => run(() => api.post(`/api/frontdesk/tags/${tag.id}/unlock`), `${tag.code} 已解锁`)}>
                解锁（已找回 / 已修好）
              </Button>
            </>
          ) : (
            <>
              <p className="text-[13px] font-semibold text-ink-2">锁定后前台不能发出这张牌</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {lockReasons.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className={cn('h-8 rounded-full border px-3 text-[13px] font-semibold', reason === r ? 'border-clay bg-clay-soft text-clay' : 'border-line bg-card text-ink-2')}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <Button
                className="mt-3"
                variant="danger"
                disabled={reason.trim().length < 2 || tag.inUse || legacy}
                loading={busy}
                onClick={() => run(() => api.post(`/api/frontdesk/tags/${tag.id}/lock`, { reason }), `${tag.code} 已锁定`)}
              >
                锁定
              </Button>
              {tag.inUse && <p className="mt-2 text-[12.5px] text-clay">这张牌上有在店客人，请先在前台给客人换牌并勾选「锁定原手牌」。</p>}
            </>
          )}
        </div>
        <TagDeleteField tag={tag} onDone={onDone} />
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 手牌柜「暂停使用 / 维修中」：标了前台发不出，改回正常就能发；在店的不能标（先换牌） */
function TagServiceField({ tag, onDone }: { tag: AdminTag; onDone: (message: string) => void }) {
  const [status, setStatus] = useState<TagServiceStatus>(tag.serviceStatus);
  const [note, setNote] = useState(tag.serviceNote ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = status !== 'normal' && tag.inUse;
  const changed = status !== tag.serviceStatus || (status !== 'normal' && note.trim() !== (tag.serviceNote ?? ''));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/frontdesk/tags/${tag.id}/service`, { status, note: status === 'normal' ? '' : note.trim() });
      onDone(status === 'normal' ? `${tag.code} 已恢复正常，前台可以发了` : `${tag.code} 已标「${TAG_SERVICE_LABELS[status]}」，前台发不出`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-line bg-paper/60 p-4" data-testid="tag-service-field">
      <p className="text-[13px] font-semibold text-ink-2">柜子状态：暂停使用、维修中的前台发不出，改回正常就能发</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Segmented value={status} onChange={setStatus} ariaLabel="柜子状态" options={TAG_SERVICE_STATUSES.map((v) => ({ value: v, label: TAG_SERVICE_LABELS[v] }))} />
        {status !== 'normal' && (
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} placeholder="说明（可不填），如：锁坏了" className="w-56" aria-label="说明" data-testid="tag-service-note" />
        )}
        <Button variant="secondary" disabled={!changed || blocked} loading={busy} onClick={save} data-testid="tag-service-save">
          保存状态
        </Button>
      </div>
      {blocked && <p className="mt-2 text-[12.5px] text-clay">这张牌上有在店客人，请先在前台给客人换牌，再标暂停或维修。</p>}
      {error && <Notice tone="error" className="mt-2" title={error} />}
    </div>
  );
}

/** 删除手牌：二次确认；在店的不能删。删了的列表、前台都不再有，牌号不会再生成；发过的历史照旧可查，按清单导入同一牌号可恢复 */
function TagDeleteField({ tag, onDone }: { tag: AdminTag; onDone: (message: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/frontdesk/tags/${tag.id}/delete`);
      onDone(`${tag.code} 已删除`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-clay/30 p-4" data-testid="tag-delete-field">
      {!asking ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={tag.inUse} onClick={() => setAsking(true)} data-testid="tag-delete">
            删除这张手牌
          </Button>
          {tag.inUse && <span className="text-[12.5px] text-clay">在店的不能删，请先在前台给客人换牌</span>}
        </div>
      ) : (
        <div className="space-y-3">
          <ConfirmCheck checked={sure} onChange={setSure} tone="clay">
            确认删除手牌 <b className="num">{tag.code}</b>：删除后后台列表和前台都不再有这张牌，牌号也不会再被批量生成；发过的来访历史照旧可查，要恢复用「按清单导入」导入同一牌号。
          </ConfirmCheck>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => (setAsking(false), setSure(false))}>
              取消
            </Button>
            <Button variant="danger" disabled={!sure} loading={busy} onClick={remove} data-testid="tag-delete-confirm">
              确认删除
            </Button>
          </div>
        </div>
      )}
      {error && <Notice tone="error" className="mt-2" title={error} />}
    </div>
  );
}

// ───────────────────────── 芯片号、发牌前风控（8.1.15） ─────────────────────────

/** 一张手牌的芯片号：点「绑定」后刷一下（本机读卡器 / 键盘式读卡器），或手输；绑着的可以解绑 */
function TagCardField({ tag, onDone }: { tag: AdminTag; onDone: (message: string) => void }) {
  const [binding, setBinding] = useState(false);
  const [uid, setUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<CardMessage | null>(null);
  const normalized = normalizeCardUid(uid);
  const ok = CARD_UID_PATTERN.test(normalized);
  const save = async (cardUid: string | null) => {
    setBusy(true);
    setNote(null);
    try {
      await api.put(`/api/frontdesk/tags/${tag.id}/card`, { cardUid });
      onDone(cardUid ? `${tag.code} 已绑定芯片号 ${cardUid}` : `${tag.code} 已解绑芯片号`);
    } catch (e) {
      setNote({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  // 绑定时刷一下：读到的卡号填进来，核对后点「确认绑定」
  useCardReader(binding, {
    onCard: (card) => {
      setUid(normalizeCardUid(card));
      setNote({ tone: 'ok', text: '已读到卡号，核对后点「确认绑定」' });
    },
    onReadError: (text) => setNote({ tone: 'error', text }),
  });
  return (
    <div className="rounded-lg border border-line bg-paper/60 p-4" data-testid="tag-card-field">
      <div className="flex flex-wrap items-center gap-2">
        <Nfc className="size-4 text-ink-3" />
        <p className="text-[13px] font-semibold text-ink-2">芯片号</p>
        {tag.cardUid ? (
          <span className="num rounded-md bg-card px-2 py-0.5 text-[16px] font-bold" data-testid="tag-card-uid">
            {tag.cardUid}
          </span>
        ) : (
          <span className="text-[13px] text-ink-3" data-testid="tag-card-none">
            还没绑；绑了以后发牌时刷这张牌就能带出牌号
          </span>
        )}
        <span className="flex-1" />
        {!binding && (
          <Button size="lg" variant="secondary" disabled={busy} onClick={() => setBinding(true)} data-testid="tag-card-bind">
            {tag.cardUid ? '换一张卡' : '绑定'}
          </Button>
        )}
        {!binding && tag.cardUid && (
          <Button size="lg" variant="ghost" loading={busy} onClick={() => void save(null)} data-testid="tag-card-unbind">
            解绑
          </Button>
        )}
      </div>
      {binding && (
        <div className="mt-3 space-y-2">
          <ReaderStatusLine message={note} />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              fullWidth={false}
              autoFocus
              value={uid}
              onChange={(e) => setUid(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ok && !busy) {
                  e.preventDefault();
                  void save(normalized);
                }
              }}
              placeholder="把手牌放到读卡器上，或手输芯片号"
              autoComplete="off"
              className="num h-11 min-w-0 flex-1 basis-56"
              aria-label="芯片号"
              invalid={!!uid && !ok}
              data-testid="tag-card-input"
            />
            <Button size="lg" variant="primary" disabled={!ok} loading={busy} onClick={() => void save(normalized)} data-testid="tag-card-save">
              确认绑定
            </Button>
            <Button size="lg" variant="ghost" disabled={busy} onClick={() => setBinding(false)}>
              取消
            </Button>
          </div>
          {uid && !ok && <p className="text-[12.5px] font-medium text-clay">芯片号应为 4–32 位数字或字母（刷卡带出来的原样填）</p>}
        </div>
      )}
      {!binding && note && <p className="mt-2 text-[12.5px] font-semibold text-clay">{note.text}</p>}
    </div>
  );
}

/** 发牌前风控的开关（功能开关，默认开）：黑名单、未结离店授权、重复到店提示、预约带出与核销 */
function RiskSwitchCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['frontdesk', 'risk-rules'], queryFn: () => api.get<FrontdeskRiskRules>('/api/frontdesk/risk-rules') });
  const [busy, setBusy] = useState(false);
  const set = async (enabled: boolean) => {
    setBusy(true);
    try {
      qc.setQueryData(['frontdesk', 'risk-rules'], await api.put<FrontdeskRiskRules>('/api/frontdesk/risk-rules', { enabled }));
      void qc.invalidateQueries({ queryKey: ['frontdesk'] });
      toast({ tone: 'success', title: enabled ? '发牌前风控已开启' : '发牌前风控已关闭', body: enabled ? undefined : '发牌与以前一样：不查黑名单、不拦未结离店、不带预约。' });
    } catch (e) {
      toast({ tone: 'error', title: '没有保存', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5" data-testid="risk-switch">
      <SectionTitle aside={<PendingBadge title="发牌前风控的做法是默认值，待确认（docs/PENDING_DECISIONS.md「块 A：前台」FK1 起）" />}>发牌前风控</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        开着时，接待发牌选了会员会核对四样：在黑名单里的不能发；名下有没处理完的「未结离店」的要值班经理及以上当场授权；今天来过的提示第几次到店；今天待到店的预约带出来，发牌成功后自动标「已到店」（派对房除外）。关掉以后发牌与以前一样。
      </p>
      {rules.isPending ? (
        <Skeleton className="mt-3 h-10 w-48" />
      ) : rules.isError && !rules.data ? (
        <Notice tone="error" className="mt-3" title={`开关没取回来：${errorMessage(rules.error)}`} />
      ) : (
        <Segmented
          className="mt-3"
          value={rules.data!.enabled ? 'on' : 'off'}
          onChange={(v) => {
            if (!busy && (v === 'on') !== rules.data!.enabled) void set(v === 'on');
          }}
          ariaLabel="发牌前风控"
          options={[
            { value: 'on', label: '开启' },
            { value: 'off', label: '关闭' },
          ]}
        />
      )}
    </Card>
  );
}
