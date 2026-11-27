// 换密钥（8.1.52，后端评估 docs/BACKEND_REVIEW_V8148.md 第 6 节）：<名字>_PREVIOUS 里的旧密钥换密钥期间照样认——
// 商城服务密钥、饭卡码、工资表原件；新签发、新加密一律用当前那把。不要数据库，秒级。
import { describe, expect, it } from 'vitest';
import { codeStepOf } from '@shared/canteen';
import { loadPreviousKeys } from '../src/server/config';
import { sharedKeyMatcher } from '../src/server/lib/http-kit';
import { checkCanteenCodeAny, codeMac, employeeCodeKey } from '../src/server/modules/canteen/code';
import { decryptFile, encryptFile, payrollKeyFor, payrollKeyOf } from '../src/server/modules/oa/payroll';

const NEW = 'n'.repeat(40);
const OLD = 'o'.repeat(40);

describe('换密钥', () => {
  it('配置：逗号分隔、每把至少 32 位；没配为空', () => {
    expect(loadPreviousKeys({})).toEqual({ canteenCode: [], payrollFile: [], mallApi: [] });
    expect(loadPreviousKeys({ MALL_API_KEY_PREVIOUS: ` ${OLD} , ${'p'.repeat(32)} ` }).mallApi).toEqual([OLD, 'p'.repeat(32)]);
    expect(() => loadPreviousKeys({ PAYROLL_FILE_KEY_PREVIOUS: 'short' })).toThrow(/PAYROLL_FILE_KEY_PREVIOUS/);
  });

  it('服务密钥：当前的、旧的都认，别的不认', () => {
    const match = sharedKeyMatcher(NEW, [OLD]);
    expect(match(NEW)).toBe(true);
    expect(match(OLD)).toBe(true);
    expect(match('x'.repeat(40))).toBe(false);
    expect(sharedKeyMatcher(NEW)(OLD)).toBe(false);
  });

  it('饭卡码：旧码钥匙签的照样认，换掉以后不认', () => {
    const at = Date.UTC(2026, 10, 27, 4, 0, 0);
    const step = codeStepOf(at);
    const oldMac = codeMac(employeeCodeKey(OLD, 7, 1), step);
    expect(checkCanteenCodeAny([NEW, OLD], 7, 1, step, oldMac, at)).toBe('ok');
    expect(checkCanteenCodeAny([NEW], 7, 1, step, oldMac, at)).toBe('invalid');
    expect(checkCanteenCodeAny([NEW, OLD], 7, 1, step - 100, codeMac(employeeCodeKey(OLD, 7, 1), step - 100), at)).toBe('expired');
  });

  it('工资表原件：按记下的 key_id 找钥匙，旧密钥加密的放进 PREVIOUS 就能解开', () => {
    const oldCfg = { env: 'production' as const, payrollFileKey: OLD, previousKeys: { canteenCode: [], payrollFile: [], mallApi: [] } };
    const sealed = encryptFile(payrollKeyOf(oldCfg)!, Buffer.from('工资表'));
    const rotated = { ...oldCfg, payrollFileKey: NEW, previousKeys: { ...oldCfg.previousKeys, payrollFile: [OLD] } };
    const key = payrollKeyFor(rotated, sealed.keyId);
    expect(key).not.toBeNull();
    expect(decryptFile(key!, sealed).toString()).toBe('工资表');
    expect(payrollKeyFor({ ...rotated, previousKeys: oldCfg.previousKeys }, sealed.keyId)).toBeNull();
    expect(payrollKeyOf(rotated)!.id).not.toBe(sealed.keyId);
  });
});
