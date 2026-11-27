// 商品图批量导入（8.1.55）：选一份 Excel（WPS「嵌入单元格」的图片，一列物料编码或名称、一列或几列图片）→ 预览逐行核对 → 写入。
// 写入可以原样再发（追加不重复、替换结果一样），所以不走「结果待确认」那一套：没收到结果时再点一次写入即可。

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import type { ShopImageImportResult } from '@shared/shop';
import { api, errorMessage } from '../../lib/api';
import { bytesToBase64 } from '../../lib/import-file';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Notice, Segmented } from '../../components/ui';

export function ShopImageImportButton({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setOpen(true)} data-testid="shop-img-import-btn">
        <FileUp className="size-4" />
        批量导入商品图
      </Button>
      {open && <ImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ fileName: string; xlsxBase64: string } | null>(null);
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [preview, setPreview] = useState<ShopImageImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (f: { fileName: string; xlsxBase64: string }, m: 'append' | 'replace', apply: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<ShopImageImportResult>('/api/erp/shop/materials/images/import', { ...f, mode: m, apply });
      if (apply) {
        toast({ tone: 'success', title: `商品图已导入：改了 ${r.changedCount} 样物料` });
        void qc.invalidateQueries({ queryKey: ['shop'] });
        onClose();
      } else setPreview(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (f: File | undefined) => {
    setPreview(null);
    setError(null);
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) return setError('只能导入 Excel（.xlsx）文件');
    if (f.size > 10 * 1024 * 1024) return setError('Excel 文件超过 10 MB，请分几份导入');
    const loaded = { fileName: f.name, xlsxBase64: bytesToBase64(await f.arrayBuffer()) };
    setFile(loaded);
    await send(loaded, mode, false);
  };

  const changeMode = (m: 'append' | 'replace') => {
    setMode(m);
    if (file) void send(file, m, false);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="批量导入商品图"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!file || !preview || preview.issueCount > 0 || preview.changedCount === 0}
            onClick={() => file && void send(file, mode, true)}
            data-testid="shop-img-import-apply"
          >
            写入{preview ? `（${preview.changedCount} 样物料）` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p className="text-ink-2">
          表头要有一列「物料编码」（没有编码时写「物料名称」）和至少一列名字里带「图」的列；图片用 WPS「嵌入单元格」插入。每样物料最多 6 张、每张不超过 1 MB，第 1 张是封面。
        </p>
        <Segmented
          ariaLabel="导入方式"
          value={mode}
          onChange={changeMode}
          options={[
            { value: 'append', label: '追加到已有的后面' },
            { value: 'replace', label: '替换成表里的' },
          ]}
        />
        <div>
          <input ref={input} type="file" accept=".xlsx" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} data-testid="shop-img-import-file" />
          <Button size="sm" variant="secondary" loading={busy && !preview} onClick={() => input.current?.click()}>
            {file ? `换一份（现在：${file.fileName}）` : '选择 Excel 文件'}
          </Button>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {preview && (
          <div className="space-y-2" data-testid="shop-img-import-preview">
            <p className="font-semibold text-ink">
              共 {preview.rows.length} 行：要改 {preview.changedCount} 样物料{preview.issueCount ? `，${preview.issueCount} 行有问题（改好后重新选文件，有问题时一行都不写）` : ''}
            </p>
            <ul className="max-h-72 divide-y divide-line overflow-auto rounded-lg border border-line">
              {preview.rows.map((r) => (
                <li key={r.row} className="flex items-start justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">
                      第 {r.row} 行 · {r.materialName || r.materialCode || '（没写物料）'}
                      {r.materialCode ? <span className="text-ink-3"> · {r.materialCode}</span> : null}
                    </p>
                    {r.issues.map((i) => (
                      <p key={i} className="text-ember">
                        {i}
                      </p>
                    ))}
                  </div>
                  {r.issues.length ? (
                    <Badge tone="ember">有问题</Badge>
                  ) : r.changed ? (
                    <Badge tone="pine">
                      {r.before} → {r.after} 张
                    </Badge>
                  ) : (
                    <Badge tone="neutral">不变</Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
