// 饭卡码（员工小程序线 E，docs/STAFF_MP.md 第 5.4 节；规则照柚子饭堂 docs/CANTEEN.md 第 5 节）：在手机上离线生成，没信号也能亮。
//   YZC1:<员工编号>:<时间段>:<签名>，30 秒一段；签名 = HMAC-SHA256(码钥匙, "canteen-code:v1:<时间段>") 的前几个字节转 base32 取 8 位。
// 小程序里没有 node:crypto，也不靠 WebCrypto：下面的 SHA-256 / HMAC 从 src/shared/hmac-sha256.ts 照抄（去掉数字分隔符），
// tests/meal-code.test.ts 拿主线的 signCanteenCode 逐字核对，两边算出来的码一模一样。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  // 补位：先补一个 0x80，再补 0 到差 8 个字节满 64 的倍数，最后 8 个字节是原文的比特数（大端）
  const total = Math.ceil((data.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = data.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 0x100000000));
  view.setUint32(total - 4, bits >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = w[i - 16]! + s0 + w[i - 7]! + s1;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
    h[5] = h[5]! + f;
    h[6] = h[6]! + g;
    h[7] = h[7]! + k;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = 64;
  const k = key.length > block ? sha256(key) : key;
  const inner = new Uint8Array(block + message.length);
  const outer = new Uint8Array(block + 32);
  for (let i = 0; i < block; i++) {
    const byte = k[i] ?? 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  inner.set(message, block);
  outer.set(sha256(inner), block);
  return sha256(outer);
}

export const CODE_STEP_SECONDS = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes: Uint8Array, length: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    buffer = (buffer << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** 码钥匙（base64url）解成字节 */
export function fromBase64Url(text: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  const clean = text.replace(/=+$/, '');
  for (let i = 0; i < clean.length; i++) {
    const ch = clean.charAt(i);
    const v = alphabet.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch);
    if (v < 0) throw new Error('码钥匙不对');
    buffer = ((buffer << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** ASCII 文字转字节（小程序里不一定有 TextEncoder；签的内容只有 ASCII） */
function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

export const codeStepOf = (ms: number) => Math.floor(ms / (CODE_STEP_SECONDS * 1000));

/** 这一刻的饭卡码；atMs 是按服务器时间修正过的「现在」 */
export function signMealCode(codeKey: string, employeeId: number, atMs: number): { text: string; step: number } {
  const step = codeStepOf(atMs);
  const mac = base32(hmacSha256(fromBase64Url(codeKey), ascii(`canteen-code:v1:${step}`)), 8);
  return { text: `YZC1:${employeeId.toString(36).toUpperCase()}:${step.toString(36).toUpperCase()}:${mac}`, step };
}

/** 这一段还剩几秒（码上方的细进度条用） */
export function secondsLeft(atMs: number): number {
  return CODE_STEP_SECONDS - Math.floor((atMs / 1000) % CODE_STEP_SECONDS);
}
