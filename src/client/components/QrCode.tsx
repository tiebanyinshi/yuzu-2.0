// 二维码（SVG）：Design 工作台的预览码、WCP 手机端入口码共用。编码与画法见 @shared/qr-svg。

import { useMemo } from 'react';
import { QR_COLORS, qrShape } from '@shared/qr-svg';

export function QrCode({ text, className }: { text: string; className?: string }) {
  const shape = useMemo(() => qrShape(text), [text]);
  return (
    <svg viewBox={`-2 -2 ${shape.size + 4} ${shape.size + 4}`} className={className} role="img" aria-label="二维码">
      <rect x={-2} y={-2} width={shape.size + 4} height={shape.size + 4} fill={QR_COLORS.paper} />
      <path d={shape.modules} fill={QR_COLORS.module} />
      {shape.eyes.map((e) => (
        <g key={`${e.x}-${e.y}`}>
          <rect x={e.x + 0.5} y={e.y + 0.5} width="6" height="6" rx="1.8" fill="none" stroke={QR_COLORS.eye} strokeWidth="1" />
          <rect x={e.x + 2} y={e.y + 2} width="3" height="3" rx="0.9" fill={QR_COLORS.eye} />
        </g>
      ))}
    </svg>
  );
}
