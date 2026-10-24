/**
 * E2E 用の拡張機能を作る。本番の dist/ と manifest.json は変えない。
 * `pnpm run build` が出す dist/ を一時ディレクトリへ写し、そのコピーの manifest にだけ
 * テスト用の `host_permissions`（localhost・127.0.0.1・example.com）を足す。
 *
 * `readProductionManifest()` は、本番の manifest.json（テスト用の書き換えを含まない）を読む。
 *
 * 作り方は環境変数 `E2E_BUILD` で選ぶ。
 * - 指定なし（既定）: `tools/build.ts` だけを実行して dist/ を作る（typecheck・lint・単体テストは省く。速い）
 * - `full`: `pnpm run build`（typecheck・lint・単体テストも含む）
 * - `skip`: すでにある dist/ をそのまま使う
 * 複数のプロセスが同時に dist/ を作り直して壊し合わないよう、作る間はロックを取る。
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = fileURLToPath(new URL('../../..', import.meta.url));

/** テスト用の manifest に足すホスト権限。本番の manifest には無い。 */
export const TEST_HOST_PERMISSIONS = [
  'http://localhost/*',
  'http://127.0.0.1/*',
  'https://example.com/*',
] as const;

const LOCK_DIR = join(tmpdir(), 'guided-tour-e2e-build.lock');
const LOCK_STALE_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(LOCK_DIR);
      return () => rm(LOCK_DIR, { recursive: true, force: true });
    } catch {
      if (Date.now() - startedAt > LOCK_STALE_MS) {
        // 作った側が落ちたロックは捨てる
        await rm(LOCK_DIR, { recursive: true, force: true });
      } else {
        await sleep(500);
      }
    }
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} が失敗した（終了コード ${String(code)}）`));
    });
  });
}

async function produceDist(mode: string): Promise<void> {
  if (mode === 'skip') return;
  if (mode === 'full') await run('pnpm', ['run', 'build']);
  else await run(process.execPath, ['--experimental-strip-types', 'tools/build.ts']);
}

export interface TestExtension {
  /** manifest を書き換えた、読み込み用のディレクトリ。 */
  dir: string;
  cleanup: () => Promise<void>;
}

/** dist/ をコピーして、テスト用の manifest にしたディレクトリを作る。 */
export async function buildTestExtension(): Promise<TestExtension> {
  const mode = process.env.E2E_BUILD ?? 'esbuild';
  const dir = await mkdtemp(join(tmpdir(), 'guided-tour-e2e-ext-'));
  const release = await acquireLock();
  try {
    await produceDist(mode);
    await cp(join(root, 'dist'), dir, { recursive: true });
  } finally {
    await release();
  }
  const manifestPath = join(dir, 'manifest.json');
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const base = z.record(z.string(), z.unknown()).parse(parsed);
  const manifest = { ...base, host_permissions: [...TEST_HOST_PERMISSIONS] };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const ProductionManifestSchema = z.looseObject({
  version: z.string(),
  host_permissions: z.array(z.string()).optional(),
  content_scripts: z.array(z.unknown()).optional(),
  permissions: z.array(z.string()).default([]),
  optional_host_permissions: z.array(z.string()).optional(),
  commands: z.record(z.string(), z.unknown()).optional(),
});

/** 本番の manifest.json（リポジトリ直下のもの。テスト用の書き換えを含まない）。 */
export async function readProductionManifest(): Promise<z.output<typeof ProductionManifestSchema>> {
  const parsed: unknown = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  return ProductionManifestSchema.parse(parsed);
}
