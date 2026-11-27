// 打码收一份（8.1.56，后端评估 docs/BACKEND_REVIEW_V8148.md 第 6 节）：手机号、银行账号这类的打码只在这里写一次，
// 页面、服务端、导出都引用这里（labels、membership、oa-directory 里原来的名字照旧导出，指到这里）。

/** 没留手机号的会员（匿名卡，8.1.15）在页面、小票、导出里写的字 */
export const NO_PHONE_LABEL = '未留手机号';

/** 页面上显示：138 **** 8000；没留的写「未留手机号」；不是 11 位的原样（座机、境外号） */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return NO_PHONE_LABEL;
  return phone.length === 11 ? `${phone.slice(0, 3)} **** ${phone.slice(7)}` : phone;
}

/** 紧凑写法（审计、通讯录、给 AI 的数据）：138****8000；不是 11 位的一律 ****（不露） */
export function maskPhoneCompact(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : '****';
}

/** 银行账号、流水号：****1234；四位以内的全打码 */
export function maskAccount(value: string): string {
  return value.length <= 4 ? '*'.repeat(value.length) : `****${value.slice(-4)}`;
}
