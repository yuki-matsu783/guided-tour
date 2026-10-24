/** 技術検証 2 用の zip を Node で作る。 */
import { zipSync } from 'fflate';

const MB = 1024 * 1024;

/** 全部 0 のファイル 1 つを最大圧縮した zip（圧縮率は約 1000:1）。 */
export function zeroZip(bytes: number): Uint8Array {
  return zipSync({ 'zeros.bin': new Uint8Array(bytes) }, { level: 9 });
}

/** 宣言サイズ（ローカルヘッダと中央ディレクトリの非圧縮サイズ）を偽った zip。 */
export function lyingZip(realBytes: number, declared: number): Uint8Array {
  const zip = zeroZip(realBytes);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let patched = 0;
  for (let i = 0; i + 4 <= zip.length; i++) {
    const sig = view.getUint32(i, true);
    if (sig === 0x04034b50) {
      view.setUint32(i + 22, declared, true);
      patched++;
    } else if (sig === 0x02014b50) {
      view.setUint32(i + 24, declared, true);
      patched++;
    }
  }
  if (patched !== 2) throw new Error(`宣言サイズの書き換え箇所が ${String(patched)} 個（期待は 2）`);
  return zip;
}

/** 正直な小さい zip（3 ファイル、合計 3 MB）。打ち切りが誤作動しない対照。 */
export function honestZip(): { zip: Uint8Array; total: number } {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const a = new Uint8Array(MB);
    for (let j = 0; j < a.length; j++) a[j] = (j * (i + 3)) % 253;
    files[`f${String(i)}.bin`] = a;
    total += a.length;
  }
  return { zip: zipSync(files, { level: 6 }), total };
}
