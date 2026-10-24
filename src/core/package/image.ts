/**
 * 画像の検査。拡張子と署名の一致、容量、ヘッダーから読んだ縦横の画素数の上限を確かめる。
 * 画像は展開（デコード）しない。PNG は IHDR、GIF は論理画面記述子、JPEG は SOF（範囲を決めて走査）、
 * WebP は VP8・VP8L・VP8X のヘッダーだけを読む。ヘッダーが切れていても例外は出さず、失敗で返す。
 */
import { ascii, u16be, u16le, u24le, u32be, u32le } from './bytes.ts';
import { formatBytesLimit, PACKAGE_LIMITS } from './limits.ts';

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp';

/** 拡張子（ドットなし）から画像の種類を求める。大文字・小文字は区別しない。許可外は null。 */
export function imageKindOfExtension(extension: string): ImageKind | null {
  switch (extension.toLowerCase()) {
    case 'png':
      return 'png';
    case 'jpg':
    case 'jpeg':
      return 'jpeg';
    case 'gif':
      return 'gif';
    case 'webp':
      return 'webp';
    default:
      return null;
  }
}

export const IMAGE_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const satisfies Record<ImageKind, string>;

export interface ImageInfo {
  kind: ImageKind;
  mime: string;
  width: number;
  height: number;
}

export type ImageResult = { ok: true; info: ImageInfo } | { ok: false; message: string };

interface Size {
  width: number;
  height: number;
}

/** 先頭の署名から画像の種類を判定する。どれでもなければ null。 */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6) {
    const head = ascii(b, 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return null;
}

function readPng(b: Uint8Array): Size | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function readGif(b: Uint8Array): Size | null {
  if (b.length < 10) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

/** SOF0〜SOF15 のうち、DHT（C4）・JPG（C8）・DAC（CC）を除いたもの。 */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpeg(b: Uint8Array): Size | null {
  const limit = Math.min(b.length, PACKAGE_LIMITS.jpegScanBytes);
  let pos = 2;
  for (let markers = 0; markers < PACKAGE_LIMITS.jpegScanMarkers && pos < limit; markers++) {
    if (b[pos] !== 0xff) return null;
    while (pos < limit && b[pos] === 0xff) pos++;
    const marker = b[pos];
    pos++;
    if (marker === undefined || marker === 0x00) return null;
    // 長さを持たないマーカー
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // 画像データの前に SOF がなかった
    if (marker === 0xd9 || marker === 0xda) return null;
    if (pos + 2 > b.length) return null;
    const length = u16be(b, pos);
    if (length < 2) return null;
    if (isSof(marker)) {
      if (pos + 7 > b.length) return null;
      return { height: u16be(b, pos + 3), width: u16be(b, pos + 5) };
    }
    pos += length;
  }
  return null;
}

function readWebp(b: Uint8Array): Size | null {
  if (b.length < 16) return null;
  switch (ascii(b, 12, 4)) {
    case 'VP8 ':
      if (b.length < 30) return null;
      if (((b[20] ?? 1) & 1) !== 0) return null;
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    case 'VP8L': {
      if (b.length < 25 || b[20] !== 0x2f) return null;
      const bits = u32le(b, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X':
      if (b.length < 30) return null;
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    default:
      return null;
  }
}

function readSize(kind: ImageKind, b: Uint8Array): Size | null {
  switch (kind) {
    case 'png':
      return readPng(b);
    case 'gif':
      return readGif(b);
    case 'jpeg':
      return readJpeg(b);
    case 'webp':
      return readWebp(b);
  }
}

/**
 * 画像のバイト列を検査する。`expected` は拡張子（または data URL の MIME 型）から決めた種類。
 * 容量 → 署名 → ヘッダーの寸法 → 寸法の上限、の順に確かめる。
 */
export function inspectImage(bytes: Uint8Array, expected: ImageKind): ImageResult {
  const fail = (message: string): ImageResult => ({ ok: false, message });
  if (bytes.length > PACKAGE_LIMITS.imageBytes) {
    return fail(`画像が上限（1枚 ${formatBytesLimit(PACKAGE_LIMITS.imageBytes)}）を超えています`);
  }
  const kind = sniffImage(bytes);
  if (kind === null) {
    return fail('画像として認識できません。PNG・JPEG・GIF・WebP のいずれでもありません');
  }
  if (kind !== expected) return fail('拡張子と画像の中身の形式が一致しません');
  const size = readSize(kind, bytes);
  if (size === null) return fail('画像のヘッダーが途中で切れているか壊れていて、寸法を読み取れません');
  const { width, height } = size;
  if (width === 0 || height === 0) return fail('画像の寸法が 0 です');
  const side = PACKAGE_LIMITS.imageSide;
  if (width > side || height > side) {
    return fail(`画像の寸法が上限（${String(side)}×${String(side)} px 以内）を超えています`);
  }
  if (width * height > PACKAGE_LIMITS.imagePixels) {
    return fail(`画像の画素数が上限（${PACKAGE_LIMITS.imagePixels.toLocaleString('en-US')} 画素）を超えています`);
  }
  return { ok: true, info: { kind, mime: IMAGE_MIME[kind], width, height } };
}
