// 错误码登记（8.1.56）：页面里按错误码分辨的都登记在 src/shared/error-codes.ts；登记的服务端（或共享代码）确实会发。秒级，不要数据库。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_ERROR_CODES } from '../src/shared/error-codes';

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const read = (dirs: string[]) => dirs.flatMap((d) => files(d)).map((f) => readFileSync(f, 'utf8'));

describe('错误码登记', () => {
  it('页面里写 code === / !== 的码都登记了', () => {
    const used = new Set<string>();
    for (const code of read(['src/client', 'src/canteen-app'])) for (const m of code.matchAll(/\bcode\s*[!=]==\s*'([A-Z][A-Z0-9_]+)'/g)) used.add(m[1]!);
    const missing = [...used].filter((c) => !(c in CLIENT_ERROR_CODES)).sort();
    expect(missing, '在 src/shared/error-codes.ts 登记这几个码').toEqual([]);
  });

  it('登记的码服务端或共享代码里确实有', () => {
    const all = read(['src/server', 'src/shared']).join('\n');
    const dead = Object.keys(CLIENT_ERROR_CODES).filter((c) => !all.includes(`'${c}'`));
    expect(dead, '没人发的码从登记里删掉').toEqual([]);
  });
});
