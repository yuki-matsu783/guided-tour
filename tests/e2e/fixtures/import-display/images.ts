/**
 * 取り込み・表示の E2E が使う画像のバイト列の組み立て。
 * - `pngImage(w, h)` / `gifImage(w, h)`: ブラウザが実際に読み込める、単色の画像（寸法の確認用）。
 * - `paddedPng(size)`: PNG の署名とヘッダーだけが正しい、指定の大きさの画像（容量の上限の確認用。表示はしない）。
 */
import { deflateSync } from 'node:zlib';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(Array.from(type, (c) => c.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  return Uint8Array.from([...be32(data.length), ...body, ...be32(crc32(body))]);
}

/** 単色（赤）の PNG。 */
export function pngImage(width: number, height: number): Uint8Array {
  const header = Uint8Array.from([...be32(width), ...be32(height), 8, 2, 0, 0, 0]);
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw[y * (width * 3 + 1) + 1 + x * 3] = 255;
  }
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

function le16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

/**
 * 単色（白と黒の2色のうち黒）の GIF。LZW は圧縮せず、3 ビットの符号が広がらないよう
 * 「クリア符号 + 画素2つ」を繰り返して書く。
 */
export function gifImage(width: number, height: number): Uint8Array {
  const bits: number[] = [];
  const emit = (code: number): void => {
    for (let i = 0; i < 3; i++) bits.push((code >> i) & 1);
  };
  const total = width * height;
  for (let i = 0; i < total; i += 2) {
    emit(4);
    emit(0);
    if (i + 1 < total) emit(0);
  }
  emit(4);
  emit(5);
  const packed: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte |= (bits[i + j] ?? 0) << j;
    packed.push(byte);
  }
  const blocks: number[] = [];
  for (let i = 0; i < packed.length; i += 255) {
    const piece = packed.slice(i, i + 255);
    blocks.push(piece.length, ...piece);
  }
  return Uint8Array.from([
    ...Array.from('GIF89a', (c) => c.charCodeAt(0)),
    ...le16(width),
    ...le16(height),
    0x80,
    0,
    0,
    255, 255, 255, 0, 0, 0,
    0x2c, ...le16(0), ...le16(0), ...le16(width), ...le16(height), 0,
    2,
    ...blocks,
    0,
    0x3b,
  ]);
}

/** 先頭が PNG のヘッダー（寸法 1×1）で、残りを 0 で埋めた、ちょうど `size` バイトの画像。 */
export function paddedPng(size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(1), ...be32(1), 8, 2, 0, 0, 0, 0, 0, 0, 0]));
  return out;
}
