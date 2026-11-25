// 后台「餐饮规则」里的「菜单小分类」（8.1.39 餐饮 B，R4 菜单分类分界面）：餐厅、水吧各自的小分类（点心、中餐、烧腊……），
// 点单页、菜品表、厨房屏、台账都按这里列。默认是原来的名单；果吧不细分。
// 还有菜在用的小分类不能删、不能改名（改名就是删掉旧的、加一个新的）：先在菜品表里把菜挪走。页面上的道数只算在售的菜，
// 保存时服务端连下架的、按默认归进来的一起核对（DINING_GROUP_IN_USE）。

import { useState } from 'react';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { DINING_OUTLET_LABELS, GROUPED_OUTLETS, MAX_DINING_GROUP_NAME, MAX_DINING_GROUPS, type DiningAdmin, type DiningOutletGroups, type GroupedOutlet } from '@shared/dining';
import { Button, Input } from '../../components/ui';

/** 名单对不对（与服务端同样的规矩）；没问题返回 null */
export function groupsProblem(groups: DiningOutletGroups): string | null {
  for (const o of GROUPED_OUTLETS) {
    const label = DINING_OUTLET_LABELS[o];
    const list = groups[o];
    if (list.length === 0) return `${label}至少要有一个小分类`;
    if (list.length > MAX_DINING_GROUPS) return `${label}最多 ${MAX_DINING_GROUPS} 个小分类`;
    if (new Set(list).size !== list.length) return `${label}的小分类重复了`;
  }
  return null;
}

const nameProblem = (name: string) =>
  !name ? '请写小分类的名字' : name.length > MAX_DINING_GROUP_NAME ? `小分类最多 ${MAX_DINING_GROUP_NAME} 个字` : /[:：\s]/.test(name) ? '小分类里不要带冒号或空格' : null;

export function OutletGroupsEditor({
  value,
  onChange,
  editable,
  items,
  saved,
}: {
  value: DiningOutletGroups;
  onChange: (v: DiningOutletGroups) => void;
  editable: boolean;
  items: DiningAdmin['items'];
  /** 现在存着的名单：只有存着的小分类才算「有菜在用」 */
  saved: DiningOutletGroups;
}) {
  const [text, setText] = useState<Record<GroupedOutlet, string>>({ restaurant: '', water: '' });
  const [hint, setHint] = useState<string | null>(null);
  const usedBy = (o: GroupedOutlet, g: string) => (saved[o].includes(g) ? items.filter((i) => i.stationId !== null && !i.technicianRequired && i.slot.outlet === o && i.slot.group === g).length : 0);
  const set = (o: GroupedOutlet, list: string[]) => onChange({ ...value, [o]: list });
  const add = (o: GroupedOutlet) => {
    const name = text[o].trim();
    const bad =
      nameProblem(name) ??
      (value[o].includes(name) ? `${DINING_OUTLET_LABELS[o]}已经有「${name}」了` : value[o].length >= MAX_DINING_GROUPS ? `${DINING_OUTLET_LABELS[o]}最多 ${MAX_DINING_GROUPS} 个小分类` : null);
    setHint(bad);
    if (bad) return;
    set(o, [...value[o], name]);
    setText({ ...text, [o]: '' });
  };

  return (
    <div className="py-3" data-testid="dining-groups-editor">
      <p className="text-[14px] font-bold">菜单小分类</p>
      <p className="text-[12.5px] text-ink-3">
        点单页先选餐厅 / 水吧 / 果吧，再按这里的小分类点（例如餐厅分点心、中餐、烧腊）。还有菜在用的小分类不能删、不能改名：先在「菜品」表里把菜挪到别的小类。果吧不细分。
      </p>
      <div className="mt-2 space-y-3">
        {GROUPED_OUTLETS.map((o) => (
          <div key={o} data-testid={`dining-groups-${o}`}>
            <p className="text-[13px] font-semibold text-ink-2">{DINING_OUTLET_LABELS[o]}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {value[o].map((g, i) => {
                const n = usedBy(o, g);
                return (
                  <span key={g} className="inline-flex h-11 items-center gap-0.5 rounded-full bg-pine-tint pr-1 pl-3 text-[13.5px] font-semibold text-pine" data-testid={`dining-group-${o}-${g}`}>
                    {g}
                    <span className="num ml-1 text-[12px] font-normal text-ink-3">{n} 道</span>
                    {editable && i > 0 && (
                      <button
                        type="button"
                        className="tap relative flex size-9 items-center justify-center rounded-full hover:bg-pine/10"
                        aria-label={`把「${g}」往前挪`}
                        onClick={() => set(o, [...value[o].slice(0, i - 1), g, value[o][i - 1]!, ...value[o].slice(i + 1)])}
                      >
                        <ArrowLeft className="size-3.5" />
                      </button>
                    )}
                    {editable && (
                      <button
                        type="button"
                        className="tap relative flex size-9 items-center justify-center rounded-full hover:bg-pine/10 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={`删除小分类 ${g}`}
                        title={n > 0 ? `还有 ${n} 道菜在用，先把菜挪走` : '删除这个小分类'}
                        disabled={n > 0 || value[o].length <= 1}
                        onClick={() =>
                          set(
                            o,
                            value[o].filter((x) => x !== g),
                          )
                        }
                        data-testid={`dining-group-remove-${o}-${g}`}
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </span>
                );
              })}
              {editable && (
                <span className="inline-flex items-center gap-1.5">
                  <Input
                    value={text[o]}
                    onChange={(e) => setText({ ...text, [o]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        add(o);
                      }
                    }}
                    maxLength={MAX_DINING_GROUP_NAME}
                    placeholder="新的小分类"
                    className="w-32"
                    fullWidth={false}
                    aria-label={`给${DINING_OUTLET_LABELS[o]}加小分类`}
                    data-testid={`dining-group-input-${o}`}
                  />
                  <Button variant="ghost" className="min-h-11" icon={<Plus className="size-4" />} onClick={() => add(o)} data-testid={`dining-group-add-${o}`}>
                    加
                  </Button>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      {hint && <p className="mt-1.5 text-[12.5px] font-semibold text-clay">{hint}</p>}
    </div>
  );
}
