// 只给类型检查用（不进小程序包）：小程序只引主线 src/shared/ 里的类型，可类型检查会顺带查那些文件；
// 那里给浏览器写的代码用到 globalThis.crypto，小程序的类型环境里没有，这里补一句声明。小程序自己的代码不要用它。
declare var crypto: { getRandomValues?: (array: Uint8Array) => Uint8Array } | undefined;
// 主线 src/shared/canteen.ts（浏览器用）用到 TextEncoder、src/shared/patrol.ts 用到 Array.prototype.at：一样只给类型检查用。
// 小程序自己的代码不用这两样（老手机的小程序运行环境不一定有；tests/pages.test.ts 查 src 里没有 .at(）。
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
interface Array<T> {
  at(index: number): T | undefined;
}
