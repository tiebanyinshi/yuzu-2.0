// 采购商城对外接口的契约（8.1.56）：docs/contracts/mall-api.json 与代码里的校验模式一致，注册的路由一个不漏。秒级，不要数据库。
// 改了接口：UPDATE_CONTRACTS=1 npx vitest run tests/mall-contract.test.ts 重新生成，连同文件一起提交（商城那边照它对接）。
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MALL_PREFIX } from '../src/shared/mall';
import { MALL_API_CONTRACT } from '../src/server/modules/mall';

const FILE = 'docs/contracts/mall-api.json';
const schema = (s: z.ZodType | undefined) => (s ? z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) : undefined);

function generate() {
  return {
    说明: '采购商城对外接口（/api/erp/mall/*）的契约，由 src/server/modules/mall.ts 的 MALL_API_CONTRACT 生成，不要手改。请求头 x-mall-key 带服务密钥；返回的类型见 src/shared/mall.ts；出错时 { error: { code, message, details? } }。',
    prefix: MALL_PREFIX,
    endpoints: MALL_API_CONTRACT.map((e) => ({
      method: e.method,
      path: e.path,
      auth: e.auth,
      ...('params' in e ? { params: schema(e.params) } : {}),
      ...('query' in e ? { query: schema(e.query) } : {}),
      ...('body' in e ? { body: schema(e.body) } : {}),
      returns: e.returns,
    })),
  };
}

describe('采购商城的契约', () => {
  it('docs/contracts/mall-api.json 与代码一致', () => {
    const text = `${JSON.stringify(generate(), null, 2)}\n`;
    if (process.env.UPDATE_CONTRACTS) writeFileSync(FILE, text);
    expect(readFileSync(FILE, 'utf8'), '接口改了：UPDATE_CONTRACTS=1 重新生成契约文件').toBe(text);
  });

  it('注册的路由都写进了契约', () => {
    const src = readFileSync('src/server/modules/mall.ts', 'utf8');
    const routes = [...src.matchAll(/app\.(get|post|put|patch|delete)\(`\$\{P\}([^`]+)`/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`).sort();
    expect(routes.length).toBeGreaterThan(10);
    expect(MALL_API_CONTRACT.map((e) => `${e.method} ${e.path}`).sort()).toEqual(routes);
  });
});
