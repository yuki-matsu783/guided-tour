/**
 * バイト列から整数を読む補助。範囲外は 0 を返すので、呼ぶ側が先に長さを確かめる。
 */
export function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}

export function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
}

export function u24le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
}

export function u32le(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0;
}

export function u32be(b: Uint8Array, i: number): number {
  return (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0;
}

/** ArrayBuffer を土台にしたバイト列（Blob や crypto にそのまま渡せる）。 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** `start` から `length` バイトを ASCII の文字列として読む。 */
export function ascii(b: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length; i++) out += String.fromCharCode(b[i] ?? 0);
  return out;
}

/** 部分のバイト列を1つにつなぐ。 */
export function concatBytes(parts: readonly Uint8Array[], total: number): Bytes {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
