// 8.1.39（餐饮 B，docs/V8139_DINING_B.md）：菜品编辑里的「售卖时段」与「档口时段」。
//   · 售卖时段：只在这几段时间里卖，到点自己停售（点单页灰掉、任何入口都下不了单），不用人去沽清；不设为全天卖；
//   · 档口时段：这几段时间里到另一个出品档口出品（例如夜宵时段到水吧出），不设的时候都在上面选的档口。
// 结束时间早于开始的是跨零点（22:00 到次日 02:00）。

import { Plus, Trash2 } from 'lucide-react';
import { MAX_SALE_WINDOWS, MAX_STATION_WINDOWS, formatMinute, parseMinute, windowsProblem, type DishStationWindow, type DishWindow } from '@shared/dining-v8139';
import { Button, Input, Select } from '../../components/ui';

export interface WindowDraft {
  start: string;
  end: string;
}
export interface StationWindowDraft extends WindowDraft {
  stationId: number | null;
}

export const saleDraftOf = (ws: readonly DishWindow[] | undefined): WindowDraft[] => (ws ?? []).map((w) => ({ start: formatMinute(w.start), end: formatMinute(w.end) }));
export const stationDraftOf = (ws: readonly DishStationWindow[] | undefined): StationWindowDraft[] =>
  (ws ?? []).map((w) => ({ start: formatMinute(w.start), end: formatMinute(w.end), stationId: w.stationId }));

/** 表单里的时段换成要交的；不对返回给人看的原因 */
export function windowsFromDraft(sale: WindowDraft[], station: StationWindowDraft[]): { saleWindows: DishWindow[]; stationWindows: { start: number; end: number; stationId: number }[] } | string {
  const saleWindows: DishWindow[] = [];
  for (const w of sale) {
    const start = parseMinute(w.start);
    const end = parseMinute(w.end);
    if (start === null || end === null) return '售卖时段的时间没填全，请按「11:00」这样填';
    saleWindows.push({ start, end });
  }
  const stationWindows: { start: number; end: number; stationId: number }[] = [];
  for (const w of station) {
    const start = parseMinute(w.start);
    const end = parseMinute(w.end);
    if (start === null || end === null) return '档口时段的时间没填全，请按「11:00」这样填';
    if (w.stationId === null) return '档口时段要选到哪个档口出品';
    stationWindows.push({ start, end, stationId: w.stationId });
  }
  return windowsProblem(saleWindows, '售卖时段', MAX_SALE_WINDOWS) ?? windowsProblem(stationWindows, '档口时段', MAX_STATION_WINDOWS) ?? { saleWindows, stationWindows };
}

function TimePair({ value, onChange, label, testId }: { value: WindowDraft; onChange: (v: WindowDraft) => void; label: string; testId: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Input
        type="time"
        step={60}
        value={value.start}
        onChange={(e) => onChange({ ...value, start: e.target.value })}
        aria-label={`${label}开始`}
        className="w-[118px]"
        fullWidth={false}
        data-testid={`${testId}-start`}
      />
      <span className="text-[13px] text-ink-3">到</span>
      <Input
        type="time"
        step={60}
        value={value.end}
        onChange={(e) => onChange({ ...value, end: e.target.value })}
        aria-label={`${label}结束`}
        className="w-[118px]"
        fullWidth={false}
        data-testid={`${testId}-end`}
      />
    </span>
  );
}

export function DishTimeFields({
  sale,
  station,
  stations,
  onChange,
}: {
  sale: WindowDraft[];
  station: StationWindowDraft[];
  stations: { id: number; name: string; active: boolean }[];
  onChange: (patch: { sale?: WindowDraft[]; station?: StationWindowDraft[] }) => void;
}) {
  return (
    <div className="space-y-4" data-testid="dish-time-fields">
      <div>
        <p className="text-[13px] font-semibold text-ink-2">售卖时段 {sale.length === 0 && <span className="font-normal text-ink-3">· 全天都卖</span>}</p>
        <p className="mt-0.5 text-[12px] text-ink-3">只在这几段时间里卖，到点自动停售（点单页灰掉，手牌、桌台、平板、小程序都下不了单），不用人去沽清。结束早于开始是跨零点。</p>
        <ul className="mt-2 space-y-2">
          {sale.map((w, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2" data-testid={`dish-sale-window-${i}`}>
              <TimePair value={w} label="售卖时段" testId={`dish-sale-${i}`} onChange={(v) => onChange({ sale: sale.map((x, j) => (j === i ? v : x)) })} />
              <button
                type="button"
                className="tap relative flex size-9 items-center justify-center rounded-full text-ink-3 hover:bg-paper-2 hover:text-clay"
                aria-label="去掉这一段售卖时段"
                onClick={() => onChange({ sale: sale.filter((_x, j) => j !== i) })}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
        {sale.length < MAX_SALE_WINDOWS && (
          <Button
            variant="ghost"
            className="mt-1.5 min-h-11"
            icon={<Plus className="size-4" />}
            onClick={() => onChange({ sale: [...sale, { start: '11:00', end: '14:00' }] })}
            data-testid="dish-sale-add"
          >
            加一段售卖时段
          </Button>
        )}
      </div>
      <div>
        <p className="text-[13px] font-semibold text-ink-2">档口时段 {station.length === 0 && <span className="font-normal text-ink-3">· 一直在上面选的档口出品</span>}</p>
        <p className="mt-0.5 text-[12px] text-ink-3">这几段时间里点的，送到另一个档口出品（不用为换档口另建一道菜）；已经下的单不跟着改。</p>
        <ul className="mt-2 space-y-2">
          {station.map((w, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2" data-testid={`dish-station-window-${i}`}>
              <TimePair value={w} label="档口时段" testId={`dish-station-${i}`} onChange={(v) => onChange({ station: station.map((x, j) => (j === i ? { ...x, ...v } : x)) })} />
              <Select
                fullWidth={false}
                className="min-h-11 w-[150px]"
                value={w.stationId ?? ''}
                onChange={(e) => onChange({ station: station.map((x, j) => (j === i ? { ...x, stationId: e.target.value ? Number(e.target.value) : null } : x)) })}
                aria-label="这一段到哪个档口"
                data-testid={`dish-station-${i}-station`}
              >
                <option value="">选档口</option>
                {stations
                  .filter((s) => s.active || s.id === w.stationId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.active ? '' : '（已停用）'}
                    </option>
                  ))}
              </Select>
              <button
                type="button"
                className="tap relative flex size-9 items-center justify-center rounded-full text-ink-3 hover:bg-paper-2 hover:text-clay"
                aria-label="去掉这一段档口时段"
                onClick={() => onChange({ station: station.filter((_x, j) => j !== i) })}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
        {station.length < MAX_STATION_WINDOWS && (
          <Button
            variant="ghost"
            className="mt-1.5 min-h-11"
            icon={<Plus className="size-4" />}
            onClick={() => onChange({ station: [...station, { start: '22:00', end: '02:00', stationId: null }] })}
            data-testid="dish-station-add"
          >
            加一段档口时段
          </Button>
        )}
      </div>
    </div>
  );
}
