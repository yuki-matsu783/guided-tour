/**
 * 取り込みのテストが使う資料の組み立て（zip・画像・ツアー YAML）。
 * 悪意あるファイル（宣言サイズを偽った zip、重複した名前、寸法が巨大な小さい画像など）もバイト列から作る。
 * 製品のコードからは使わない。
 */
import { deflateSync } from 'fflate';
import type { Bytes } from '../bytes.ts';

const encoder = new TextEncoder();

export function utf8(text: string): Bytes {
  return encoder.encode(text);
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function le16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

/** 末尾に 0 を足して、ちょうど `size` バイトにする（画像のヘッダーはそのまま）。 */
export function padTo(bytes: Uint8Array, size: number): Bytes {
  if (bytes.length > size) throw new Error('padTo: すでに大きい');
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

// ---- 画像（ヘッダーだけの最小のもの。デコードはされない） ----

export function png(width: number, height: number): Bytes {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), ...ascii('IHDR'), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0,
  ]);
}

export function gif(width: number, height: number, version: '87a' | '89a' = '89a'): Bytes {
  return Uint8Array.from([...ascii(`GIF${version}`), ...le16(width), ...le16(height), 0, 0, 0]);
}

export interface JpegOptions {
  /** SOF のマーカー番号（既定 0xC0） */
  sof?: number;
  /** SOF の前に置く APP セグメントの中身の長さ */
  segments?: number[];
  /** SOF を置かない */
  noSof?: boolean;
  /** SOF の前に置く 0xFF の詰め物の数 */
  fill?: number;
}

export function jpeg(width: number, height: number, options: JpegOptions = {}): Bytes {
  const out: number[] = [0xff, 0xd8];
  for (const length of options.segments ?? []) {
    out.push(0xff, 0xe1, ...[(length + 2) >>> 8, (length + 2) & 0xff]);
    for (let i = 0; i < length; i++) out.push(0);
  }
  for (let i = 0; i < (options.fill ?? 0); i++) out.push(0xff);
  if (!options.noSof) {
    out.push(0xff, options.sof ?? 0xc0, 0, 11, 8, (height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff, 1, 1, 0x11, 0);
  }
  return Uint8Array.from(out);
}

function riff(chunk: string, body: number[]): Bytes {
  const payload = [...ascii('WEBP'), ...ascii(chunk), ...le32(body.length), ...body];
  return Uint8Array.from([...ascii('RIFF'), ...le32(payload.length), ...payload]);
}

export function webpVp8(width: number, height: number): Bytes {
  return riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0, 0, 0]);
}

export function webpVp8l(width: number, height: number): Bytes {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return riff('VP8L', [0x2f, ...le32(bits >>> 0), 0, 0, 0, 0]);
}

export function webpVp8x(width: number, height: number): Bytes {
  const w = width - 1;
  const h = height - 1;
  return riff('VP8X', [0, 0, 0, 0, w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff]);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${toBase64(bytes)}`;
}

// ---- zip ----

export interface ZipSpec {
  name: string;
  data?: Uint8Array | string;
  /** 既定は deflate。ディレクトリ（名前が `/` で終わる）は常に store。 */
  method?: 'store' | 'deflate';
  /** ヘッダーに書く展開後のサイズ（偽る） */
  declaredSize?: number;
  /** シンボリックリンクとして記録する（Unix の属性） */
  symlink?: boolean;
}

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = (crcTable[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 宣言サイズや名前を自由に書ける zip を組み立てる。 */
export function buildZip(specs: readonly ZipSpec[]): Bytes {
  const chunks: Uint8Array[] = [];
  const central: number[][] = [];
  let offset = 0;
  const push = (bytes: Uint8Array | number[]): void => {
    const chunk = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    chunks.push(chunk);
    offset += chunk.length;
  };
  for (const spec of specs) {
    const raw = typeof spec.data === 'string' ? utf8(spec.data) : (spec.data ?? new Uint8Array(0));
    const isDir = spec.name.endsWith('/');
    const method = isDir || spec.method === 'store' ? 0 : 8;
    const body = method === 8 ? deflateSync(raw, { level: 1 }) : raw;
    const name = utf8(spec.name);
    // 大きい資料では CRC の計算に時間がかかるので 0 にする（展開側は CRC を見ない）
    const crc = raw.length > 1024 * 1024 ? 0 : crc32(raw);
    const usize = spec.declaredSize ?? raw.length;
    const header = [
      ...le32(0x04034b50), ...le16(20), ...le16(0x800), ...le16(method), ...le16(0), ...le16(0x21),
      ...le32(crc), ...le32(body.length), ...le32(usize), ...le16(name.length), ...le16(0),
    ];
    const localOffset = offset;
    push(header);
    push(name);
    push(body);
    const unix = spec.symlink === true;
    const attributes = unix ? (0o120777 << 16) >>> 0 : 0;
    central.push([
      ...le32(0x02014b50), ...le16(unix ? (3 << 8) | 20 : 20), ...le16(20), ...le16(0x800), ...le16(method),
      ...le16(0), ...le16(0x21), ...le32(crc), ...le32(body.length), ...le32(usize), ...le16(name.length),
      ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(attributes), ...le32(localOffset), ...name,
    ]);
  }
  const centralOffset = offset;
  for (const entry of central) push(entry);
  const centralSize = offset - centralOffset;
  push([
    ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(central.length), ...le16(central.length),
    ...le32(centralSize), ...le32(centralOffset), ...le16(0),
  ]);
  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---- ツアー YAML ----

export interface TourYamlOptions {
  id?: string;
  name?: string;
  /** steps の中身（YAML のテキスト。インデント付きの行を並べる） */
  steps?: string;
  /** steps の前に足す最上位の行 */
  extra?: string;
}

/** 警告もエラーも出ない最小のツアー。steps を差し替えられる。 */
export function tourYaml(options: TourYamlOptions = {}): string {
  const steps =
    options.steps ??
    `  - id: s1
    title: 最初
    kind: guide
    body: 説明
`;
  return `schemaVersion: 3
id: ${options.id ?? 'sample'}
name: ${options.name ?? 'サンプル'}
origins:
  - https://example.com
${options.extra ?? ''}steps:
${steps}`;
}

/** `bodyFile` と `media` を持つ guide のステップ。 */
export function guideStep(id: string, fields: { bodyFile?: string; media?: string; alt?: string; body?: string }): string {
  let step = `  - id: ${id}\n    title: ${id}\n    kind: guide\n`;
  if (fields.body !== undefined) step += `    body: ${JSON.stringify(fields.body)}\n`;
  if (fields.bodyFile !== undefined) step += `    bodyFile: ${fields.bodyFile}\n`;
  if (fields.media !== undefined) {
    step += `    media:\n      src: ${JSON.stringify(fields.media)}\n      alt: ${fields.alt ?? '図'}\n`;
  }
  return step;
}
