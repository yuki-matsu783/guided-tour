/**
 * dist/ を fflate で zip にして release/ に出す（Node 上で動く）。
 * 先に `pnpm run build` で dist/ を作っておく。dist/ が無ければ失敗する。
 */
import { zipSync } from 'fflate';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const release = join(root, 'release');

/** ディレクトリ以下のファイルを、dist からの相対パス（/ 区切り）で集める。 */
async function collect(dir: string, files: Record<string, Uint8Array>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, files);
    } else {
      files[relative(dist, full).split(sep).join('/')] = new Uint8Array(await readFile(full));
    }
  }
}

const files: Record<string, Uint8Array> = {};
await collect(dist, files);
if (!('manifest.json' in files)) {
  throw new Error('dist/manifest.json がない。先に pnpm run build を実行する');
}

const manifest: unknown = JSON.parse(new TextDecoder().decode(files['manifest.json']));
const version =
  typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string'
    ? manifest.version
    : '0.0.0';

await mkdir(release, { recursive: true });
const out = join(release, `guided-setup-tour-${version}.zip`);
await writeFile(out, zipSync(files, { level: 9 }));
console.log(`${out}（${String(Object.keys(files).length)} ファイル）`);
