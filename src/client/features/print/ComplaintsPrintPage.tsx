import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { COMPLAINT_STATUS_LABELS, COMPLAINT_STATUSES, complaintsPath, type ComplaintLedger, type ComplaintStatus } from '@shared/frontdesk-v8223';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PrintedAt, PrintFrame, stamp } from './PrintFrame';

// 客诉台账（8.2.3，docs/V8223_FRONTDESK.md 第 3 条）的 A4 打印页：与台账页同一个接口、同样的筛选（营业日、状态；门店按当前门店或「合并看」）。

export function ComplaintsPrintPage() {
  const { from = '', to = '', status: raw = 'all' } = useParams();
  const status: ComplaintStatus = (COMPLAINT_STATUSES as readonly string[]).includes(raw) ? (raw as ComplaintStatus) : 'all';
  const session = useSession();
  const q = useQuery({
    queryKey: ['print', 'complaints', from, to, status],
    queryFn: () => api.get<ComplaintLedger>(complaintsPath(from, to, status)),
    enabled: !!from && !!to,
    refetchOnWindowFocus: false,
  });
  return (
    <PrintFrame title={`客诉台账 ${from} 至 ${to}`} ready={!!q.data} error={q.error ? errorMessage(q.error) : null} paper="a4">
      {q.data && (
        <div data-testid="print-complaints" className="text-[12px]">
          <h1 className="text-center text-[16px] font-bold">客诉台账</h1>
          <p className="mt-1 text-center">
            营业日 {from} 至 {to} · {COMPLAINT_STATUS_LABELS[status]} · 共 {q.data.rows.length} 条{q.data.truncated ? '（只列了最近 500 条）' : ''}
          </p>
          <ol className="mt-3 border-t border-black">
            {q.data.rows.map((r, i) => (
              <li key={r.remarkId} className="break-inside-avoid border-b border-black py-1.5">
                <p className="font-bold">
                  {i + 1}. {r.businessDate} · {r.storeName} · 手牌 {r.tagCode} · {r.guest} · 【{r.tag}】{r.removed ? '（已撤下）' : ''}
                </p>
                <p className="break-words">{r.note}</p>
                <p>
                  记录 {r.createdByName} {stamp(r.createdAt, session.timezone)}
                  {r.resolved ? ` · 已处理：${r.resolved.byName} ${stamp(r.resolved.at, session.timezone)}，${r.resolved.note}` : ' · 没处理'}
                </p>
              </li>
            ))}
          </ol>
          {q.data.rows.length === 0 && <p className="mt-3 text-center">这段时间没有客诉类备注</p>}
          <PrintedAt />
        </div>
      )}
    </PrintFrame>
  );
}
