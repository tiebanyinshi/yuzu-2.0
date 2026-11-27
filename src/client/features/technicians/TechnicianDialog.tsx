// 新建、编辑技师的对话框：门店「技师管理 → 名册」与后台「技师 → 技师名册」共用（8.1.15 从后台的名册卡片里搬出来，
// 补上花名、类型、入职日期）。保存走原来的名册接口（/api/admin/technicians，要「维护技师名册」权限）。
// 8.2.2：手机（只显示打码的，留空不改）、身高、体重、星级。

import { useRef, useState } from 'react';
import { ImagePlus, Trash2, UserRound } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { PRICE_TIER_LABELS, PRICE_TIERS, type PriceTier } from '@shared/catalog';
import type { TechnicianAdminView } from '@shared/technician-admin';
import { MAX_TECH_NAME, MAX_TECH_STAR, TECH_NO_PATTERN, type Technician, type TechnicianAdmin } from '@shared/technicians';
import { api, errorMessage, isRejected, notSentAsRejection } from '../../lib/api';
import { cn } from '../../lib/utils';
import { imagePayload } from '../../components/Images';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Segmented, Select } from '../../components/ui';
import { useTechAdminRefresh } from './queries';

/** photoUrl：门店「技师管理 → 名册」带着（技师榜单的照片，docs/TECH_RANKING.md）；后台的名册不带，不显示照片 */
export type EditableTechnician = Technician & { lineCount?: number; photoUrl?: string | null; photoVersion?: number; phoneMasked?: string };

export function TechnicianDialog({
  target,
  categories,
  kinds,
  onClose,
}: {
  target: EditableTechnician | 'new' | null;
  /** 项目分类（可做的分类从这里选） */
  categories: string[];
  /** 技师类型的清单 */
  kinds: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const isNew = target === 'new';
  const existing = target && target !== 'new' ? target : null;
  const [techNo, setTechNo] = useState('');
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [kind, setKind] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('female');
  const [grade, setGrade] = useState<PriceTier>('standard');
  const [skills, setSkills] = useState<string[]>([]);
  const [hiredOn, setHiredOn] = useState('');
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [sortOrder, setSortOrder] = useState('0');
  const [phone, setPhone] = useState('');
  const [clearPhone, setClearPhone] = useState(false);
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [star, setStar] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<typeof target>(null);
  if (target !== last) {
    setLast(target);
    setTechNo(existing?.techNo ?? '');
    setName(existing?.name ?? '');
    setNickname(existing?.nickname ?? '');
    setKind(existing?.kind ?? '');
    setGender(existing?.gender ?? 'female');
    setGrade(existing?.grade ?? 'standard');
    setSkills(existing?.skills ?? []);
    setHiredOn(existing?.hiredOn ?? '');
    setNote(existing?.note ?? '');
    setActive(existing?.active ?? true);
    setSortOrder(String(existing?.sortOrder ?? 0));
    setPhone('');
    setClearPhone(false);
    setHeight(existing?.heightCm ? String(existing.heightCm) : '');
    setWeight(existing?.weightKg ? String(existing.weightKg) : '');
    setStar(existing?.star ? String(existing.star) : '');
    setError(null);
  }
  // 名册里的分类可能已不在价目表里（项目改了分类），照样列出，方便去掉；类型同理
  const options = [...new Set([...categories, ...skills])];
  const kindOptions = [...new Set([...kinds, ...(kind ? [kind] : [])])];
  const num = (v: string) => (v.trim() ? Number(v.trim()) : null);
  const between = (v: string, lo: number, hi: number) => !v.trim() || (/^\d+$/.test(v.trim()) && Number(v) >= lo && Number(v) <= hi);
  const problem =
    isNew && !TECH_NO_PATTERN.test(techNo.trim())
      ? '工号为 1–6 位数字或字母，例如 08、A12'
      : !name.trim()
        ? '请填写技师名字'
        : !/^\d{1,4}$/.test(sortOrder)
          ? '排序请填 0–9999 的整数'
          : phone.trim() && !/^1\d{10}$/.test(phone.replace(/[\s-]/g, ''))
            ? '手机号应为 11 位'
            : !between(height, 100, 230)
              ? '身高写 100–230 的整数厘米'
              : !between(weight, 30, 200)
                ? '体重写 30–200 的整数公斤'
                : !between(star, 1, MAX_TECH_STAR)
                  ? `星级写 1–${MAX_TECH_STAR}`
                  : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      nickname: nickname.trim(),
      kind,
      gender,
      grade,
      skills,
      hiredOn: hiredOn || null,
      note: note.trim(),
      active,
      sortOrder: Number(sortOrder),
      // 手机：没输不改（只看得到打码的）；点了清掉的清空
      ...(phone.trim() ? { phone: phone.trim() } : clearPhone ? { phone: '' } : {}),
      heightCm: num(height),
      weightKg: num(weight),
      star: num(star),
    };
    try {
      const next = isNew
        ? await api.post<TechnicianAdmin>('/api/admin/technicians', { ...body, techNo: techNo.trim() })
        : await api.put<TechnicianAdmin>(`/api/admin/technicians/${existing!.id}`, body);
      qc.setQueryData(['admin', 'technicians'], next);
      refresh();
      toast({ tone: 'success', title: isNew ? `已添加技师 ${techNo.trim()} 号 ${name.trim()}` : '已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={isNew ? '新建技师' : `编辑技师 · ${existing?.techNo} 号`}
      description={
        isNew
          ? '工号保存后不能改；离职的技师停用即可，不删除。'
          : existing?.lineCount !== undefined
            ? `${existing.lineCount} 项明细记在这位技师名下，改名字后历史明细也显示新名字。`
            : '工号保存后不能改；改名字后历史明细也显示新名字。'
      }
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={save} data-testid="technician-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[120px_minmax(0,1fr)]">
          <Field label="工号" htmlFor="t-no">
            {isNew ? (
              <Input id="t-no" value={techNo} maxLength={6} onChange={(e) => setTechNo(e.target.value)} className="num" placeholder="08" data-autofocus data-testid="technician-no" />
            ) : (
              <p className="num flex h-11 items-center text-[18px] font-bold">{existing?.techNo}</p>
            )}
          </Field>
          <Field label="名字" htmlFor="t-name" hint="艺名或姓名，前台与小票上显示">
            <Input id="t-name" value={name} maxLength={MAX_TECH_NAME} onChange={(e) => setName(e.target.value)} data-testid="technician-name" />
          </Field>
        </div>
        {existing && existing.photoUrl !== undefined && <PhotoField key={existing.id} techId={existing.id} initial={existing.photoUrl} version={existing.photoVersion ?? 0} />}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="花名" htmlFor="t-nickname" hint="选填；钟房里跟在名字后面，叫号时念花名">
            <Input id="t-nickname" value={nickname} maxLength={MAX_TECH_NAME} onChange={(e) => setNickname(e.target.value)} placeholder="例如：小雅" data-testid="technician-nickname" />
          </Field>
          <Field label="类型" htmlFor="t-kind" hint="钟房按类型筛选；清单在「技师管理 → 名册」里改">
            <Select id="t-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="h-11" data-testid="technician-kind">
              <option value="">不设</option>
              {kindOptions.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="性别">
            <Segmented
              ariaLabel="技师性别"
              value={gender}
              onChange={setGender}
              className="w-full"
              options={[
                { value: 'female', label: '女' },
                { value: 'male', label: '男' },
              ]}
            />
          </Field>
          <Field label="等级" hint="价格跟技师等级时按这一档取价">
            <Segmented ariaLabel="技师等级" value={grade} onChange={setGrade} className="w-full" options={PRICE_TIERS.map((g) => ({ value: g, label: PRICE_TIER_LABELS[g] }))} />
          </Field>
        </div>
        <Field label="可做的项目分类" hint={skills.length ? `只能挂这 ${skills.length} 类的项目` : '不勾选 = 全部需要技师的项目都能做'}>
          <div className="flex flex-wrap gap-1.5">
            {options.length === 0 && <span className="text-[12.5px] text-ink-3">价目表里还没有项目分类</span>}
            {options.map((c) => {
              const on = skills.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSkills(on ? skills.filter((x) => x !== c) : [...skills, c])}
                  className={cn(
                    'h-9 rounded-full border px-3 text-[13px] font-semibold transition-colors',
                    on ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4',
                  )}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
          <Field label="入职日期" htmlFor="t-hired" hint="选填">
            <Input id="t-hired" type="date" value={hiredOn} onChange={(e) => setHiredOn(e.target.value)} data-testid="technician-hired" />
          </Field>
          <Field label="排序" htmlFor="t-sort" hint="小的在前">
            <Input id="t-sort" value={sortOrder} inputMode="numeric" maxLength={4} onChange={(e) => setSortOrder(e.target.value)} className="num" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="手机" htmlFor="t-phone" hint={existing?.phoneMasked ? (clearPhone ? '保存后清掉' : `现在 ${existing.phoneMasked}，留空不改`) : '选填'}>
            <Input id="t-phone" value={phone} inputMode="tel" maxLength={13} onChange={(e) => setPhone(e.target.value)} className="num" data-testid="technician-phone" />
            {existing?.phoneMasked && !phone && (
              <button type="button" className="mt-1 text-[12px] font-semibold text-clay" onClick={() => setClearPhone(!clearPhone)}>
                {clearPhone ? '不清了' : '清掉手机号'}
              </button>
            )}
          </Field>
          <Field label="身高（厘米）" htmlFor="t-height">
            <Input id="t-height" value={height} inputMode="numeric" maxLength={3} onChange={(e) => setHeight(e.target.value)} className="num" />
          </Field>
          <Field label="体重（公斤）" htmlFor="t-weight">
            <Input id="t-weight" value={weight} inputMode="numeric" maxLength={3} onChange={(e) => setWeight(e.target.value)} className="num" />
          </Field>
          <Field label="星级" htmlFor="t-star" hint="提成可以按星级定">
            <Input id="t-star" value={star} inputMode="numeric" maxLength={2} onChange={(e) => setStar(e.target.value)} className="num" placeholder={`1–${MAX_TECH_STAR}`} />
          </Field>
        </div>
        <Field label="备注" htmlFor="t-note">
          <Input id="t-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} placeholder="例如：擅长足疗，周二休" />
        </Field>
        {!isNew && (
          <Field label="状态" hint={existing?.leftOn ? `离职日期 ${existing.leftOn}` : undefined}>
            <Segmented
              ariaLabel="技师状态"
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              className="w-full"
              options={[
                { value: 'on', label: '在职' },
                { value: 'off', label: '离职（停用，前台不能再选）' },
              ]}
            />
          </Field>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 照片（技师榜单，TR5）：选了就上传（浏览器先压缩），不跟着「保存」走；去掉也是马上生效 */
function PhotoField({ techId, initial, version: initialVersion }: { techId: number; initial: string | null; version: number }) {
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const [url, setUrl] = useState(initial);
  // 照片的版本号：带着它提交，别人刚改过就被拒绝（没收到结果的原样重提，服务端原样返回）
  const [version, setVersion] = useState(initialVersion);
  const [busy, setBusy] = useState(false);
  // 结果待确认：发出去没收到结果（超时、断网、服务器出错）时留着原请求（含当时的版本号），只能原样重提或放弃
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /** 放弃或被拒绝以后：按名册读回现在的照片与版本号 */
  const reload = async () => {
    refresh();
    try {
      const v = await api.get<TechnicianAdminView>('/api/technician-admin');
      const t = v.technicians.find((x) => x.id === techId);
      if (t) {
        setUrl(t.photoUrl);
        setVersion(t.photoVersion);
      }
    } catch {
      /* 读不回来就照旧显示，下次打开编辑框再读 */
    }
  };
  const send = async (payload: Record<string, unknown>, retry: boolean) => {
    setBusy(true);
    try {
      const r = await api.put<{ photoUrl: string | null; photoVersion: number }>(`/api/admin/technicians/${techId}/photo`, payload, { timeoutMs: 30_000 });
      setPending(null);
      setUrl(r.photoUrl);
      setVersion(r.photoVersion);
      refresh();
      toast({ tone: 'success', title: r.photoUrl ? '照片已更新' : '照片已去掉' });
    } catch (e) {
      const err = retry ? e : notSentAsRejection(e);
      if (isRejected(err)) {
        // 明确没处理：别人刚改过（PHOTO_CHANGED）或内容不对；读回现在的照片
        setPending(null);
        toast({ tone: 'error', title: '照片没有存上', body: errorMessage(err) });
        if (err.code === 'PHOTO_CHANGED') void reload();
      } else {
        setPending(payload);
        toast({ tone: 'info', title: '照片结果待确认', body: '可能已经存上了。请点「原样重提」核对（不会重复改），或「放弃」后看现在的照片' });
      }
    } finally {
      setBusy(false);
    }
  };
  const put = (body: Record<string, unknown>) => send({ ...body, version }, false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      await put(await imagePayload(file));
    } catch (e) {
      toast({ tone: 'error', title: '照片读不了', body: errorMessage(e) });
    }
  };
  return (
    <Field label="照片" hint="技师榜单上显示；选了马上生效，不用再点保存">
      <div className="flex items-center gap-3" data-testid="technician-photo">
        <div className="flex h-24 w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-paper-3 text-ink-4">
          {url ? <img src={url} alt="技师照片" className="size-full object-cover" /> : <UserRound className="size-9" strokeWidth={1.25} aria-label="没有照片" />}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
          data-testid="technician-photo-input"
        />
        <Button variant="secondary" icon={<ImagePlus className="size-4" />} loading={busy} disabled={!!pending} onClick={() => input.current?.click()} data-testid="technician-photo-pick">
          {url ? '换一张' : '上传照片'}
        </Button>
        {url && (
          <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={busy || !!pending} onClick={() => void put({ remove: true })} data-testid="technician-photo-remove">
            去掉
          </Button>
        )}
      </div>
      {pending && (
        <Notice tone="warning" title="照片的结果待确认" className="mt-2" data-testid="technician-photo-pending">
          <p>刚才那次没收到结果，可能已经存上了。原样重提会核对，不会重复改，也不会覆盖别人之后的修改。</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void send(pending, true)} data-testid="technician-photo-retry">
              原样重提
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPending(null);
                void reload();
              }}
              data-testid="technician-photo-abandon"
            >
              放弃，看现在的照片
            </Button>
          </div>
        </Notice>
      )}
    </Field>
  );
}
