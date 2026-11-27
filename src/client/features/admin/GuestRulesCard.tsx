// 客人与提醒（8.2.3，docs/V8223_FRONTDESK.md）：后台「手牌与前台 → 客人与提醒」——客人类别、客人偏好的字段、进客诉台账的标签、
// 区域拥挤提示与高风险提示的阈值、高风险推给谁。存在 frontdesk_guest_rules（按店），只改提交的那一块。
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  MAX_CATEGORY_LENGTH,
  MAX_GUEST_CATEGORIES,
  MAX_PREF_FIELDS,
  MAX_PREF_LABEL,
  RISK_NOTIFY_LABELS,
  RISK_NOTIFY_LEVELS,
  type GuestPrefField,
  type GuestRules,
  type RiskNotifyLevel,
} from '@shared/frontdesk-v8223';
import { centsToInput, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';

/** 新加的偏好字段的编号：f + 时刻（小写字母与数字，改名不丢值） */
const newKey = () => `f${Date.now().toString(36)}`;

/** 一串名字（类别、标签）的编辑：每个一个框，可加可删 */
function NameList({ values, max, maxLength, label, onChange, testId }: { values: string[]; max: number; maxLength: number; label: string; onChange: (v: string[]) => void; testId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      {values.map((v, i) => (
        <span key={i} className="flex items-center gap-1">
          <Input
            fullWidth={false}
            value={v}
            maxLength={maxLength}
            onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
            className="h-9 w-28"
            aria-label={`${label} ${i + 1}`}
          />
          {values.length > 1 && (
            <button
              type="button"
              aria-label={`删掉${label}「${v}」`}
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              className="tap relative flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-clay-soft hover:text-clay"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </span>
      ))}
      {values.length < max && (
        <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => onChange([...values, ''])}>
          加一个
        </Button>
      )}
    </div>
  );
}

export function GuestRulesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['frontdesk', 'guest-rules'], queryFn: () => api.get<GuestRules>('/api/frontdesk/guest-rules') });
  const [categories, setCategories] = useState<string[]>([]);
  const [prefFields, setPrefFields] = useState<GuestPrefField[]>([]);
  const [complaintTags, setComplaintTags] = useState<string[]>([]);
  const [streak, setStreak] = useState('');
  const [areaMax, setAreaMax] = useState('');
  const [stayHours, setStayHours] = useState('');
  const [amount, setAmount] = useState('');
  const [notify, setNotify] = useState<RiskNotifyLevel>('page');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const r = rules.data;
    if (!r) return;
    setCategories(r.categories);
    setPrefFields(r.prefFields);
    setComplaintTags(r.complaintTags);
    setStreak(String(r.crowd.streak));
    setAreaMax(String(r.crowd.areaMax));
    setStayHours(String(r.risk.stayHours));
    setAmount(centsToInput(r.risk.amountCents));
    setNotify(r.risk.notify);
  }, [rules.data]);

  const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const amountCents = parseYuan(amount.trim() || '0');
      const body = {
        categories: categories.map((c) => c.trim()),
        prefFields: prefFields.map((f) => ({ key: f.key, label: f.label.trim() })),
        complaintTags: complaintTags.map((t) => t.trim()).filter(Boolean),
        crowd: { streak: int(streak), areaMax: int(areaMax) },
        risk: { stayHours: int(stayHours), amountCents: amountCents ?? NaN, notify },
      };
      if ([body.crowd.streak, body.crowd.areaMax, body.risk.stayHours, body.risk.amountCents].some((n) => Number.isNaN(n))) throw new Error('阈值要填 0 或正整数（金额按元填）');
      qc.setQueryData(['frontdesk', 'guest-rules'], await api.put<GuestRules>('/api/frontdesk/guest-rules', body));
      toast({ tone: 'success', title: '客人与提醒的设置已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="guest-rules-card">
      <SectionTitle aside={<PendingBadge title="类别、偏好字段与各个阈值是默认做法，待店主确认（docs/V8223_FRONTDESK.md 第 10 节）" />}>客人与提醒</SectionTitle>
      {rules.isPending ? (
        <Skeleton className="mt-3 h-48" />
      ) : rules.isError && !rules.data ? (
        <Notice tone="error" className="mt-3" title={`设置没取回来：${errorMessage(rules.error)}`} />
      ) : (
        <div className="mt-3 space-y-5">
          <section>
            <p className="text-[13px] font-bold text-ink-2">客人类别</p>
            <p className="mb-2 text-[12.5px] text-ink-3">发牌时选，发牌后在客人卡上能改；第一个是默认（手牌上不标），其余的在全店显示手牌的地方标出来。最多 {MAX_GUEST_CATEGORIES} 个。</p>
            <NameList values={categories} max={MAX_GUEST_CATEGORIES} maxLength={MAX_CATEGORY_LENGTH} label="类别" onChange={setCategories} testId="guest-rules-categories" />
          </section>
          <section>
            <p className="text-[13px] font-bold text-ink-2">客人偏好的字段</p>
            <p className="mb-2 text-[12.5px] text-ink-3">
              前台在客人卡上填，点单、房态中心、钟房派钟刷手牌都看得到。会员的跟着会员走（下次来自动带出），散客的只这一次。改名不丢以前填的；删掉的字段以前填的照旧留着，不再显示。
            </p>
            <div className="flex flex-wrap items-center gap-2" data-testid="guest-rules-prefs">
              {prefFields.map((f, i) => (
                <span key={f.key} className="flex items-center gap-1">
                  <Input
                    fullWidth={false}
                    value={f.label}
                    maxLength={MAX_PREF_LABEL}
                    onChange={(e) => setPrefFields(prefFields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    className="h-9 w-28"
                    aria-label={`偏好字段 ${i + 1}`}
                  />
                  <button
                    type="button"
                    aria-label={`删掉字段「${f.label}」`}
                    onClick={() => setPrefFields(prefFields.filter((_, j) => j !== i))}
                    className="tap relative flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-clay-soft hover:text-clay"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </span>
              ))}
              {prefFields.length < MAX_PREF_FIELDS && (
                <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setPrefFields([...prefFields, { key: newKey(), label: '' }])}>
                  加一个字段
                </Button>
              )}
            </div>
          </section>
          <section>
            <p className="text-[13px] font-bold text-ink-2">进客诉台账的备注标签</p>
            <p className="mb-2 text-[12.5px] text-ink-3">前台备注带了这些标签的进「前台 → 客诉台账」；要与「数据字典 → 前台备注的标签」里的字一样。</p>
            <NameList values={complaintTags.length ? complaintTags : ['']} max={10} maxLength={20} label="标签" onChange={setComplaintTags} testId="guest-rules-complaint-tags" />
          </section>
          <section className="grid gap-3 sm:grid-cols-2">
            <Field label="连续往同一区发几张后提示换区" hint="0 = 不按这个提示" htmlFor="crowd-streak">
              <Input id="crowd-streak" inputMode="numeric" value={streak} onChange={(e) => setStreak(e.target.value)} className="h-10" data-testid="guest-rules-streak" />
            </Field>
            <Field label="一个区在店超过几人提示换区" hint="0 = 不按这个提示" htmlFor="crowd-area">
              <Input id="crowd-area" inputMode="numeric" value={areaMax} onChange={(e) => setAreaMax(e.target.value)} className="h-10" data-testid="guest-rules-area-max" />
            </Field>
            <Field label="在店超过几小时算高风险" hint="0 = 不按时长" htmlFor="risk-hours">
              <Input id="risk-hours" inputMode="numeric" value={stayHours} onChange={(e) => setStayHours(e.target.value)} className="h-10" data-testid="guest-rules-stay-hours" />
            </Field>
            <Field label="挂账超过多少元算高风险" hint="0 = 不按金额（不含门票）" htmlFor="risk-amount">
              <MoneyInput id="risk-amount" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="guest-rules-amount" />
            </Field>
          </section>
          <section>
            <p className="mb-2 text-[13px] font-bold text-ink-2">高风险推给谁</p>
            <Segmented value={notify} onChange={setNotify} ariaLabel="高风险推给谁" options={RISK_NOTIFY_LEVELS.map((l) => ({ value: l, label: RISK_NOTIFY_LABELS[l] }))} />
            <p className="mt-1.5 text-[12.5px] text-ink-3">
              都会在发卡台、收银台的牌上标红、进「高风险」列表；选了推送的，每位客人每一样（超时、大额）推一次站内通知（接了企业微信等外发通道的跟着发）。
            </p>
          </section>
          {error && <Notice tone="error" title={error} />}
          <div className="flex justify-end">
            <Button variant="primary" loading={busy} onClick={() => void save()} data-testid="guest-rules-save">
              保存
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
