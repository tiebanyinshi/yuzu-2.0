// 操作编号（幂等键，AGENTS.md「开发约定」）：每次写操作一个 UUID v4，没收到回复时按原编号原样重提。

export function uuid(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex.charAt(8 + Math.floor(Math.random() * 4));
    else out += hex.charAt(Math.floor(Math.random() * 16));
  }
  return out;
}
