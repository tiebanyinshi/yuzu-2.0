import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { badRequest } from './errors';

/** 校验请求体，失败时返回第一条中文提示。 */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.');
    throw badRequest(issue?.message ?? '提交的数据格式不正确', field ? { field } : undefined);
  }
  return result.data;
}

export const idParam = z.object({ id: z.coerce.number().int().positive('编号不正确') });
/** 日期参数（YYYY-MM-DD）：缺了或格式不对都给中文提示（v0.7.10，测试服回归报告：原来缺日期时是校验库默认的英文） */
export const dateSchema = (label = '日期') => z.string(`请填写${label}（YYYY-MM-DD）`).regex(ISO_DATE, `${label}格式应为 YYYY-MM-DD`);
export const cents = (label: string) => z.number(`${label}必须是数字`).int(`${label}必须精确到分`).nonnegative(`${label}不能为负数`).max(1_000_000_000, `${label}过大`);
export const positiveCents = (label: string) => cents(label).positive(`${label}必须大于 0`);

/**
 * 受邀人手机号（体验邀请、小程序邀请都用）：去掉空格与横线后要 11 位。
 * 放在这里而不放在 member-trials.ts：mp-entries.ts 在模块顶层用它建校验，两者互相引用，
 * 按某些加载顺序（命令行迁移）会在 member-trials 还没初始化时就读它
 */
export const InviteePhone = z
  .string('请输入受邀人的手机号')
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^1\d{10}$/, '请输入 11 位手机号'));
