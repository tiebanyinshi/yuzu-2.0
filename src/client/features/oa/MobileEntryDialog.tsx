// 手机端入口二维码（店主 2026-11-25《员工办公系统建设需求文档 v1.1》第二节；店主定：走外网正式服的 https 域名，docs/OA_MOBILE.md）：
// 「WCP 设置 → 组织架构」里点「手机端入口」，生成指向 <https 域名>/oa 的二维码，打印或截图贴在门店，员工用微信扫码打开、用员工账号登录。
// 门店内网的 http 地址在微信里拿不到定位、开不了摄像头（打卡用不了），所以只认 https 开头的地址。
// 二维码在浏览器里画，不存服务器；地址默认取这个页面的地址（已经是 https 时），否则用正式服域名。

import { useState } from 'react';
import { QrCode } from '../../components/QrCode';
import { Dialog } from '../../components/Overlay';
import { Field, Input, Notice } from '../../components/ui';

/** 正式服的系统域名（docs/WEBSITE.md 第 1 节，店主 2026-11-24） */
const PRODUCTION_ORIGIN = 'https://sys.yuzusystem.xyz';

function defaultOrigin(): string {
  return window.location.protocol === 'https:' ? window.location.origin : PRODUCTION_ORIGIN;
}

/** 填的地址 → 扫码打开的地址；不是 https 的返回 null */
function mobileEntryUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname) return null;
  return `${u.origin}/oa`;
}

export function MobileEntryDialog({ onClose }: { onClose: () => void }) {
  const [origin, setOrigin] = useState(defaultOrigin);
  const url = mobileEntryUrl(origin);
  return (
    <Dialog open onClose={onClose} title="手机端入口" description="员工用微信扫码打开 WCP，用自己的员工账号登录。打印或截图贴在门店。" width="max-w-md">
      <div className="space-y-4" data-testid="oa-mobile-entry">
        <Field label="系统地址（必须是 https）" htmlFor="oa-mobile-origin">
          <Input id="oa-mobile-origin" value={origin} onChange={(e) => setOrigin(e.target.value)} spellCheck={false} autoCapitalize="none" data-testid="oa-mobile-origin" />
        </Field>
        {url ? (
          <div className="flex flex-col items-center gap-2">
            <QrCode text={url} className="size-56 rounded-lg border border-line" />
            <p className="num text-[13px] font-semibold break-all text-ink" data-testid="oa-mobile-url">
              {url}
            </p>
          </div>
        ) : (
          <Notice tone="error" title="要填 https 开头的地址">
            门店内网的 http 地址在微信里拿不到定位、开不了摄像头，员工打不了卡。请填外网正式服的地址，例如 {PRODUCTION_ORIGIN}。
          </Notice>
        )}
        <p className="text-[12.5px] text-ink-3">扫码后先到登录页，登录后直接进 WCP 工作台；在电脑浏览器打开同一个地址也一样能用。</p>
      </div>
    </Dialog>
  );
}
