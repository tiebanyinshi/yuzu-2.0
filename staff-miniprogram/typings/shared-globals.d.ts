// 只给类型检查用（不进小程序包）：小程序只引主线 src/shared/ 里的类型，可类型检查会顺带查那些文件；
// 那里给浏览器写的代码用到 globalThis.crypto，小程序的类型环境里没有，这里补一句声明。小程序自己的代码不要用它。
declare var crypto: { getRandomValues?: (array: Uint8Array) => Uint8Array } | undefined;
