// 采购商城 v0.2（8.2.6，《汤崎 ERP｜采购商城模块 需求变更文档 v0.2》第 4 章，docs/MALL_V826.md）：
//   · FixModeFields：「仅补必补项」只列这一轮标的必补项，原值灰字回显在上面，逐项补
//   · TerminateButton：终止该申购（提单人申请，部门负责人或 BP 确认；负责人、BP、店主直接终止）
//   · MallFixSection：详情页的终止状态与确认、各轮必补项、版本快照

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { History, OctagonX } from 'lucide-react';
import { formatQty } from '@shared/quantity';
import { SHOP_CUSTOM_UNITS } from '@shared/shop';
import type { ImageRef, MallCustomSpec } from '@shared/requests';
import type { MallRequest } from '@shared/mall';
import { MALL_TERMINATION_STATUS_LABELS, MALL_VERSION_MODE_LABELS, type MallFixField, type MallFixItem, type MallVersion } from '@shared/mall-fix';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { ImagePicker } from '../../components/Images';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Textarea } from '../../components/ui';

const imageRef = (id: number): ImageRef => ({ id, url: `/api/erp/images/${id}` });

/** 这一轮还没补的必补项（最近一次退回标的） */
export function openFixItems(r: MallRequest): MallFixItem[] {
  const round = Math.max(0, ...r.fixItems.map((f) => f.round));
  return r.fixItems.filter((f) => f.round === round && !f.resolvedAt);
}

/** 一项补的内容：文字类写 text；图片、图纸文件写 images；图纸链接写 text */
export interface FixValue {
  text: string;
  images: ImageRef[] | null;
}

export const initialFixValues = (r: MallRequest, items: MallFixItem[]): Record<number, FixValue> =>
  Object.fromEntries(
    items.map((it) => {
      const line = r.lines.find((l) => l.id === it.lineId);
      const withImages = it.field === 'images' || it.field === 'spec.drawing';
      return [it.id, { text: it.field === 'spec.drawing' ? (line?.customSpec?.drawingUrl ?? '') : '', images: withImages && line ? line.imageIds.map(imageRef) : null }];
    }),
  );

/** 补了没有（空 = 都补了） */
export function fixValuesProblem(r: MallRequest, items: MallFixItem[], values: Record<number, FixValue>): string | null {
  for (const it of items) {
    const v = values[it.id];
    const line = r.lines.find((l) => l.id === it.lineId);
    const label = `${it.lineLabel ? `${it.lineLabel} · ` : ''}${it.fieldLabel}`;
    if (!v) return `还没补：${label}`;
    if (it.field === 'images') {
      if (!v.images?.length || v.images.map((i) => i.id).join() === line?.imageIds.join()) return `还没补：${label}（请换上 / 加上图片）`;
    } else if (it.field === 'spec.drawing') {
      const sameImages = (v.images ?? []).map((i) => i.id).join() === line?.imageIds.join();
      if (v.text.trim() === (line?.customSpec?.drawingUrl ?? '') && sameImages) return `还没补：${label}（上传图纸文件或填写图纸链接）`;
      if (v.text.trim() && !/^https?:\/\/\S+$/i.test(v.text.trim())) return '图纸链接要以 http:// 或 https:// 开头';
    } else if (!v.text.trim()) return `还没补：${label}`;
    else if (v.text.trim() === it.originalValue.trim()) return `「${label}」和原来一样，请照要求改`;
  }
  return null;
}

const fullSpec = (s: MallCustomSpec | null): Required<MallCustomSpec> => ({
  size: '',
  craft: '',
  scene: '',
  sample: false,
  budgetCents: null,
  material: '',
  tolerance: '',
  color: '',
  drawingUrl: '',
  designVersion: '',
  ...s,
});

const SPEC_KEY: Partial<Record<MallFixField, keyof MallCustomSpec>> = {
  'spec.size': 'size',
  'spec.material': 'material',
  'spec.tolerance': 'tolerance',
  'spec.color': 'color',
  'spec.craft': 'craft',
  'spec.designVersion': 'designVersion',
};
const LINE_TEXT: Partial<Record<MallFixField, 'name' | 'unit' | 'details' | 'brandModel' | 'link' | 'reasonText'>> = {
  name: 'name',
  unit: 'unit',
  details: 'details',
  brandModel: 'brandModel',
  link: 'link',
  reasonText: 'reasonText',
};

/**
 * 「仅补必补项」发给服务端的整张单：没标的项原样（行只带编号与数量，服务端按原来的补齐），标了的换成补的内容。
 * 服务端再核一遍：没标的项变了、标了的没补都会拦下
 */
export function fixModeBody(r: MallRequest, items: MallFixItem[], values: Record<number, FixValue>) {
  const head = { contactName: r.contactName, budgetProject: r.budgetProject, needBy: r.needBy ?? '', deliveryAddress: r.deliveryAddress, priority: r.priority, note: r.note };
  const lines = r.lines.map((l) => {
    const out: Record<string, unknown> = { id: l.id, qtyMilli: l.qtyMilli };
    let spec: Required<MallCustomSpec> | null = null;
    for (const it of items.filter((x) => x.lineId === l.id)) {
      const v = values[it.id]!;
      const text = v.text.trim();
      const specKey = SPEC_KEY[it.field];
      const lineKey = LINE_TEXT[it.field];
      if (it.field === 'qty') out.qtyMilli = Math.round(Number(text) * 1000);
      else if (lineKey) out[lineKey] = text;
      else if (specKey) spec = { ...(spec ?? fullSpec(l.customSpec)), [specKey]: text };
      else if (it.field === 'images') out.imageIds = (v.images ?? []).map((i) => i.id);
      else if (it.field === 'spec.drawing') {
        spec = { ...(spec ?? fullSpec(l.customSpec)), drawingUrl: text };
        out.imageIds = (v.images ?? []).map((i) => i.id);
      }
    }
    if (spec) out.customSpec = spec;
    return out;
  });
  for (const it of items.filter((x) => x.lineId === null)) (head as Record<string, string>)[it.field] = values[it.id]!.text.trim();
  return { ...head, lines };
}

/** 「仅补必补项」：逐项列出要补的，原值灰字在上 */
export function FixModeFields({
  r,
  items,
  values,
  setValues,
  onUploading,
}: {
  r: MallRequest;
  items: MallFixItem[];
  values: Record<number, FixValue>;
  setValues: (fn: (prev: Record<number, FixValue>) => Record<number, FixValue>) => void;
  onUploading: (busy: boolean) => void;
}) {
  const put = (id: number, patch: Partial<FixValue>) => setValues((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }));
  return (
    <div className="space-y-3" data-testid="shop-fix-fields">
      {items.map((it) => {
        const v = values[it.id] ?? { text: '', images: null };
        const line = r.lines.find((l) => l.id === it.lineId);
        const fid = `fix-${it.id}`;
        return (
          <Card key={it.id} className="space-y-2 p-4" data-testid={`shop-fix-item-${it.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="clay">本次必补</Badge>
              <span className="text-[14px] font-bold text-ink">
                {it.lineLabel ? `${it.lineLabel} · ` : ''}
                {it.fieldLabel}
              </span>
            </div>
            <p className="text-[12.5px] text-ink-3">原填写：{it.originalValue || '（空）'}</p>
            <p className="text-[13px] text-clay">要求：{it.requirement}</p>
            {it.field === 'images' || it.field === 'spec.drawing' ? (
              <div className="space-y-2">
                {it.field === 'spec.drawing' && (
                  <Field label="图纸链接（可查看的网址）" htmlFor={fid}>
                    <Input id={fid} maxLength={1000} value={v.text} placeholder="https://…" onChange={(e) => put(it.id, { text: e.target.value })} />
                  </Field>
                )}
                <p className="text-[12.5px] font-semibold text-ink-2">{it.field === 'spec.drawing' ? '图纸文件（图片格式）' : '参考图片'}</p>
                <ImagePicker value={v.images ?? []} onChange={(images) => put(it.id, { images })} max={9} onBusyChange={onUploading} testId={`${fid}-images`} />
              </div>
            ) : it.field === 'unit' ? (
              <Select id={fid} value={v.text} onChange={(e) => put(it.id, { text: e.target.value })} aria-label="单位">
                <option value="">选单位</option>
                {[...new Set([...SHOP_CUSTOM_UNITS, line?.unit ?? ''])].filter(Boolean).map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </Select>
            ) : it.field === 'needBy' ? (
              <Input id={fid} type="date" value={v.text} onChange={(e) => put(it.id, { text: e.target.value })} aria-label="期望到货日" />
            ) : it.field === 'qty' ? (
              <Input
                id={fid}
                inputMode="decimal"
                className="w-40"
                value={v.text}
                placeholder={line ? `原 ${formatQty(line.qtyMilli)} ${line.unit}` : ''}
                onChange={(e) => put(it.id, { text: e.target.value })}
                aria-label="数量"
              />
            ) : it.field === 'details' || it.field === 'reasonText' || it.field === 'note' ? (
              <Textarea id={fid} rows={2} maxLength={it.field === 'note' ? 500 : 800} value={v.text} onChange={(e) => put(it.id, { text: e.target.value })} aria-label={it.fieldLabel} />
            ) : (
              <Input id={fid} maxLength={200} value={v.text} onChange={(e) => put(it.id, { text: e.target.value })} aria-label={it.fieldLabel} data-testid={`${fid}-input`} />
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ───────────────────────── 终止该申购 ─────────────────────────

export function TerminateButton({ r, onDone, size = 'sm' }: { r: MallRequest; onDone: (next: MallRequest) => void; size?: 'sm' | 'md' }) {
  const toast = useToast();
  const qc = useQueryClient();
  const session = useSession();
  const url = `/api/erp/shop/requests/${r.id}/terminate`;
  // 本机还有一笔终止没确认结果（Codex 审查）：先在页面顶部查回、原样重提或确认作废，不另发新的
  const pending = useErpRecorded(['mall_terminate']).some((op) => op.staffId === session.staff.id && op.url === url);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!r.can.terminate) return null;
  const direct = r.can.terminate === 'direct';
  // 与补资料同一套「结果待确认」：本机先记下编号与内容、读回核对再发（记不下不发）；超时、断网、服务器出错不当成没终止，
  // 在页面顶部查回、原样重提或确认作废
  const send = async () => {
    setBusy(true);
    const key = uuid();
    try {
      const res = await sendErpOp<{ result: 'terminated' | 'pending'; request: MallRequest }>({
        key,
        type: 'mall_terminate',
        method: 'POST',
        url,
        body: { clientKey: key, reason: reason.trim() },
        summary: `${direct ? '终止申购' : '申请终止申购'} · ${r.docNo}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      void qc.invalidateQueries({ queryKey: ['shop'] });
      toast(res.result === 'terminated' ? { tone: 'success', title: '已终止这张申购', body: '已发配的记录照旧留着' } : { tone: 'info', title: '已申请终止', body: '等部门负责人或供应链 BP 确认' });
      setOpen(false);
      onDone(res.request);
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '终止结果待确认', body: '回复没收到，可能已经提交：记录留在本机，请在页面顶部查回、原样重提或确认作废' });
        void qc.invalidateQueries({ queryKey: ['shop'] });
        setOpen(false);
      } else toast({ tone: 'error', title: '没有终止', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="ghost" size={size} onClick={() => setOpen(true)} data-testid="shop-terminate-open">
        <OctagonX className="size-4" /> {direct ? '终止该申购' : '申请终止该申购'}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`终止申购 · ${r.docNo}`}
        description={direct ? '终止以后这张单结束，不能再改、不能再提交；已发配的记录照旧留着。' : '提交以后等部门负责人或供应链 BP 确认；确认以后这张单结束，不能再改。'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              不终止
            </Button>
            {pending && <span className="mr-auto text-[12.5px] text-clay">上一次终止还没确认结果：先在页面顶部处理</span>}
            <Button variant="danger" loading={busy} disabled={reason.trim().length < 2 || pending} onClick={() => void send()} data-testid="shop-terminate-send">
              {direct ? '确认终止' : '提交终止申请'}
            </Button>
          </>
        }
      >
        <Field label="终止原因" htmlFor="terminate-reason">
          <Textarea
            id="terminate-reason"
            rows={3}
            maxLength={200}
            value={reason}
            placeholder="例如：活动取消，不用做了"
            onChange={(e) => setReason(e.target.value)}
            data-testid="shop-terminate-reason"
          />
        </Field>
      </Dialog>
    </>
  );
}

function DecideTermination({ r, onDone }: { r: MallRequest; onDone: (next: MallRequest) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const next = await api.post<MallRequest>(`/api/erp/shop/requests/${r.id}/terminate/decide`, { approve, note: note.trim() });
      void qc.invalidateQueries({ queryKey: ['shop'] });
      toast({ tone: 'success', title: approve ? '已确认终止' : '已驳回终止申请' });
      onDone(next);
    } catch (e) {
      toast({ tone: 'error', title: '没有处理', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input className="max-w-xs" maxLength={200} value={note} placeholder="说明（驳回时写给提单人）" onChange={(e) => setNote(e.target.value)} aria-label="处理说明" />
      <Button variant="danger" size="sm" loading={busy} onClick={() => void decide(true)} data-testid="shop-terminate-approve">
        确认终止
      </Button>
      <Button variant="ghost" size="sm" loading={busy} onClick={() => void decide(false)} data-testid="shop-terminate-decline">
        驳回
      </Button>
    </div>
  );
}

// ───────────────────────── 详情页：终止状态、必补记录、版本 ─────────────────────────

export function MallFixSection({ r, onChange }: { r: MallRequest; onChange: (next: MallRequest) => void }) {
  const [viewing, setViewing] = useState<MallVersion | null>(null);
  const toast = useToast();
  const t = r.termination;
  const rounds = [...new Set(r.fixItems.map((f) => f.round))];
  const view = async (no: number) => {
    try {
      setViewing(await api.get<MallVersion>(`/api/erp/shop/requests/${r.id}/versions/${no}`));
    } catch (e) {
      toast({ tone: 'error', title: '打不开这一版', body: errorMessage(e) });
    }
  };
  return (
    <div className="space-y-3" data-testid="shop-fix-section">
      {t && (t.status === 'pending' || t.status === 'declined') && (
        <Notice tone={t.status === 'pending' ? 'warning' : 'info'} title={`${MALL_TERMINATION_STATUS_LABELS[t.status]}：${t.reason}`} data-testid="shop-termination">
          {t.requestedByName} 于 {formatDateTime(t.requestedAt)} 申请
          {t.decidedByName && `；${t.decidedByName} ${formatDateTime(t.decidedAt!)} 驳回${t.decideNote ? `：${t.decideNote}` : ''}`}
          {r.can.decideTermination && <DecideTermination r={r} onDone={onChange} />}
        </Notice>
      )}
      {rounds.length > 0 && (
        <Card className="space-y-3 p-4" data-testid="shop-fix-history">
          <p className="text-[14px] font-bold text-ink">退回补资料记录</p>
          {rounds.map((round) => (
            <div key={round} className="space-y-1.5">
              <p className="text-[12.5px] font-semibold text-ink-2">
                第 {round} 次退回 · {r.fixItems.find((f) => f.round === round)!.returnedByName} · {formatDateTime(r.fixItems.find((f) => f.round === round)!.returnedAt)}
              </p>
              <ul className="space-y-1 text-[12.5px]">
                {r.fixItems
                  .filter((f) => f.round === round)
                  .map((f) => (
                    <li key={f.id} className="rounded-lg bg-paper-2/60 px-3 py-2">
                      <span className="font-semibold text-ink">
                        {f.lineLabel ? `${f.lineLabel} · ` : ''}
                        {f.fieldLabel}
                      </span>
                      <span className="text-clay">（{f.requirement}）</span>
                      <span className="block text-ink-3">原填写：{f.originalValue || '（空）'}</span>
                      <span className="block text-ink-2">{f.resolvedAt ? `补的：${f.suppliedValue ?? ''}（${formatDateTime(f.resolvedAt)}）` : '还没补'}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </Card>
      )}
      {r.versions.length > 0 && (
        <Card className="space-y-2 p-4" data-testid="shop-versions">
          <p className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
            <History className="size-4" /> 提交版本
          </p>
          <ul className="flex flex-wrap gap-2">
            {r.versions.map((v) => (
              <li key={v.versionNo}>
                <Button variant="ghost" size="sm" onClick={() => void view(v.versionNo)} data-testid={`shop-version-${v.versionNo}`}>
                  V{v.versionNo} · {MALL_VERSION_MODE_LABELS[v.mode]} · {formatDateTime(v.createdAt)}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="flex justify-end">
        <TerminateButton r={r} onDone={onChange} />
      </div>
      <Dialog open={!!viewing} onClose={() => setViewing(null)} title={viewing ? `V${viewing.versionNo} · ${MALL_VERSION_MODE_LABELS[viewing.mode]}` : ''} width="max-w-2xl">
        {viewing && (
          <div className="space-y-3 text-[13px]" data-testid="shop-version-view">
            <p className="text-ink-3">
              {viewing.createdByName} · {formatDateTime(viewing.createdAt)}（只读）
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-ink-3">经办人</dt>
              <dd>{viewing.snapshot.header.contactName}</dd>
              <dt className="text-ink-3">期望到货</dt>
              <dd>{viewing.snapshot.header.needBy ?? '—'}</dd>
              <dt className="text-ink-3">收货地点</dt>
              <dd>{viewing.snapshot.header.deliveryAddress}</dd>
              <dt className="text-ink-3">预算项目</dt>
              <dd>{viewing.snapshot.header.budgetProject}</dd>
            </dl>
            {viewing.snapshot.lines.map((l) => (
              <div key={l.id} className="rounded-lg bg-paper-2/60 px-3 py-2">
                <p className="font-semibold">
                  第 {l.lineNo} 行 · {l.name} · {formatQty(l.qtyMilli)} {l.unit}
                </p>
                <p className="whitespace-pre-wrap text-ink-2">{l.details}</p>
                {l.imageIds.length > 0 && <p className="text-ink-3">图片 {l.imageIds.length} 张</p>}
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </div>
  );
}
