// 8.2.22 全角转半角（docs/V82222_HOTKEYS.md；收银 demo 的 toHalf）：中文输入法开着时敲出来的「８２０１」「Ａ０２３」「１２８．５」
// 按半角认，牌号、金额、读卡器的卡号都先过一遍。只换全角 ASCII（U+FF01–FF5E）与全角空格，别的字（中文、全角的「，」以外的符号）不动。

export function toHalfWidth(input: string): string {
  return input.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
}
