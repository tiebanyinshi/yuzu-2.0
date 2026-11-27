// 采购模块按单号查（8.2.6，《采购模块需求补充》R1）：采购单列表、流程进度顶上都有。
// 回车：精确命中一张 → 直接打开这张采购单（采购单抽屉里有流程进度）；需求单还没转采购单的打开需求单；
// 多条命中 → 列出候选点了下钻；没有 → 写清可能的原因。只读，不改任何单据

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Hash } from 'lucide-react';
import { DOC_LOOKUP_KIND_LABELS, type DocLookupHit, type DocLookupResult } from '@shared/purchase-lookup';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { Badge, Button } from '../../components/ui';

/** 点一条去哪：反查到采购单的开采购单；需求单开需求单；直接收货的开收货单 */
function lookupTarget(h: DocLookupHit): string {
  if (h.poId !== null) return `/purchasing?po=${h.poId}`;
  if (h.kind === 'request') return `/erp/requests?request=${h.id}`;
  return `/inventory/docs?doc=${h.id}`;
}

export function DocLookup({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [no, setNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DocLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!no.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<DocLookupResult>(`/api/purchase-lookup?no=${encodeURIComponent(no.trim())}`);
      if (r.exact && r.hits.length === 1) {
        setResult(null);
        navigate(lookupTarget(r.hits[0]!));
      } else setResult(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={className}>
      <form onSubmit={(e) => void submit(e)} className="flex items-center gap-1.5" role="search" aria-label="按单号查">
        <div className="relative min-w-[180px] flex-1">
          <Hash className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            value={no}
            onChange={(e) => setNo(e.target.value)}
            placeholder="单号直达：采购单 / 需求单 / 收货单"
            aria-label="按单号查"
            maxLength={64}
            className="h-9 w-full rounded-md border border-line-strong bg-card pr-3 pl-9 text-[13px] outline-none focus:border-pine"
            data-testid="doc-lookup-input"
          />
        </div>
        <Button size="sm" variant="secondary" type="submit" loading={busy} data-testid="doc-lookup-go">
          查
        </Button>
      </form>
      {error && <p className="mt-1.5 text-[12.5px] text-clay">{error}</p>}
      {result && (
        <div className="mt-2 rounded-lg border border-line bg-card p-2 shadow-card" data-testid="doc-lookup-result">
          {result.hits.length === 0 ? (
            <p className="px-2 py-1.5 text-[13px] text-ink-2" data-testid="doc-lookup-empty">
              未找到单号「{result.query}」：可能单号有误、没有权限查看，或单据已归档。
            </p>
          ) : (
            <>
              <p className="px-2 pb-1 text-[12px] text-ink-3">{result.exact ? '这个单号对应多张单据' : `没有完全一样的单号，相近的 ${result.hits.length} 张`}：</p>
              <ul>
                {result.hits.map((h) => (
                  <li key={`${h.kind}-${h.id}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setResult(null);
                        navigate(lookupTarget(h));
                      }}
                      className="flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-pine-tint/60"
                      data-testid={`doc-lookup-hit-${h.kind}-${h.id}`}
                    >
                      <Badge tone="neutral">{DOC_LOOKUP_KIND_LABELS[h.kind]}</Badge>
                      <span className="num font-bold">{h.docNo}</span>
                      <span className="text-ink-2">{h.party}</span>
                      {h.summary && <span className="min-w-0 truncate text-ink-3">{h.summary}</span>}
                      <span className="ml-auto text-[12px] text-ink-3">{formatDateTime(h.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
