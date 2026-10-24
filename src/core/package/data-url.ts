/**
 * 画像の data URL の検査と復号。許可するのは image/png・jpeg・gif・webp の base64 だけ。
 * 復号したバイト列は、ファイルの画像と同じ `inspectImage` の検査にかける。不正な入力でも例外は出さない。
 */
import { IMAGE_MIME, type ImageKind } from './image.ts';
import { PACKAGE_LIMITS } from './limits.ts';

export type DataUrlResult = { ok: true; bytes: Uint8Array; kind: ImageKind } | { ok: false; message: string };

const MIME_TO_KIND = new Map<string, ImageKind>([
  [IMAGE_MIME.png, 'png'],
  [IMAGE_MIME.jpeg, 'jpeg'],
  [IMAGE_MIME.gif, 'gif'],
  [IMAGE_MIME.webp, 'webp'],
]);

/** data URL の形か（大文字・小文字を区別しない）。 */
export function isDataUrl(src: string): boolean {
  return /^data:/i.test(src);
}

/** base64 の文字列の最大の長さ（画像の上限をちょうど収められる長さ）。 */
const MAX_BASE64_LENGTH = Math.ceil(PACKAGE_LIMITS.imageBytes / 3) * 4;

export function decodeDataUrl(src: string): DataUrlResult {
  const fail = (message: string): DataUrlResult => ({ ok: false, message });
  const comma = src.indexOf(',');
  if (comma < 0) return fail('data URL の形式が正しくありません');
  const header = src.slice('data:'.length, comma).toLowerCase();
  const [mime = '', ...params] = header.split(';');
  const kind = MIME_TO_KIND.get(mime);
  if (kind === undefined) {
    return fail('data URL で使えるのは image/png・image/jpeg・image/gif・image/webp だけです');
  }
  if (params.length !== 1 || params[0] !== 'base64') {
    return fail('data URL は ;base64 の形だけ使えます');
  }
  const payload = src.slice(comma + 1).replace(/[\t\n\f\r ]/g, '');
  if (payload.length > MAX_BASE64_LENGTH) return fail('data URL の画像が大きすぎます');
  if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    return fail('data URL が base64 として正しくありません');
  }
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { ok: true, bytes, kind };
  } catch {
    return fail('data URL が base64 として正しくありません');
  }
}
