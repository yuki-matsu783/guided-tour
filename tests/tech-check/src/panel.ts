/**
 * 技術検証用のサイドパネル（拡張機能のページ）。IndexedDB の読み書き（検証 1）と
 * fflate の逐次展開（検証 2）を公開し、Playwright から呼ぶ。
 */
import { Unzip, UnzipInflate } from 'fflate';
import { idbReadBlob, idbWriteBlob } from './idb.ts';
import type { BlobSummary } from './idb.ts';

export interface UnzipReport {
  readonly limit: number;
  readonly chunkSize: number;
  readonly aborted: boolean;
  /** 打ち切った時点までに数えた展開バイト数 */
  readonly counted: number;
  /** 1 回の ondata で受け取った最大のバイト数 */
  readonly maxOndata: number;
  readonly ondataCalls: number;
  readonly pushes: number;
  readonly pushedCompressed: number;
  readonly declared: readonly { name: string; size: number | null; originalSize: number | null }[];
  readonly errors: readonly string[];
  readonly ms: number;
}

declare global {
  interface Window {
    techCheck: {
      write: (key: string, size: number) => Promise<BlobSummary>;
      read: (key: string) => Promise<BlobSummary | null>;
      createObjectUrl: (key: string) => Promise<string | null>;
      unzip: (zipBase64: string, limit: number, chunkSize: number) => UnzipReport;
    };
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 展開したバイト数の合計が limit を超えたら、以降の push をやめて打ち切る。 */
function unzipWithLimit(zipBase64: string, limit: number, chunkSize: number): UnzipReport {
  const zip = fromBase64(zipBase64);
  const started = performance.now();
  const declared: { name: string; size: number | null; originalSize: number | null }[] = [];
  const errors: string[] = [];
  let counted = 0;
  let maxOndata = 0;
  let ondataCalls = 0;
  const state = { aborted: false };
  let pushes = 0;
  let pushedCompressed = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    declared.push({ name: file.name, size: file.size ?? null, originalSize: file.originalSize ?? null });
    file.ondata = (err, data) => {
      if (err) {
        errors.push(err.message);
        return;
      }
      if (state.aborted) return;
      ondataCalls++;
      counted += data.length;
      maxOndata = Math.max(maxOndata, data.length);
      if (counted > limit) {
        state.aborted = true;
        file.terminate();
      }
    };
    file.start();
  };
  try {
    for (let off = 0; off < zip.length && !state.aborted; off += chunkSize) {
      const end = Math.min(off + chunkSize, zip.length);
      pushes++;
      pushedCompressed = end;
      unzip.push(zip.subarray(off, end), end >= zip.length);
    }
  } catch (e) {
    errors.push(String(e));
  }
  return {
    limit, chunkSize, aborted: state.aborted, counted, maxOndata, ondataCalls, pushes, pushedCompressed,
    declared, errors, ms: Math.round(performance.now() - started),
  };
}

window.techCheck = {
  write: (key, size) => idbWriteBlob(key, size, 'extension-page'),
  read: (key) => idbReadBlob(key, 'extension-page'),
  createObjectUrl: async (key) => {
    const s = await idbReadBlob(key, 'extension-page');
    return s ? URL.createObjectURL(new Blob([new Uint8Array(s.size)])) : null;
  },
  unzip: unzipWithLimit,
};
