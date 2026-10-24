/**
 * 技術検証用の拡張機能を tests/tech-check/dist/ に作る。本番の src/ は使わない。
 * manifest は本番の manifest.json をもとに、検証用のページ・スクリプトと localhost の権限を足す。
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../..');
export const dist = join(here, 'dist');

export async function buildTechCheck(): Promise<string> {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await build({
    entryPoints: {
      sw: join(here, 'src/sw.ts'),
      panel: join(here, 'src/panel.ts'),
      'content-doc': join(here, 'src/content-doc.ts'),
      'content-shadow': join(here, 'src/content-shadow.ts'),
    },
    outdir: dist,
    bundle: true,
    format: 'iife',
    target: 'chrome114',
    legalComments: 'none',
    logLevel: 'warning',
  });
  await cp(join(here, 'src/panel.html'), join(dist, 'panel.html'));
  const parsed: unknown = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const base = z.record(z.string(), z.unknown()).parse(parsed);
  const manifest = {
    ...base,
    name: 'Tech Check',
    background: { service_worker: 'sw.js' },
    side_panel: { default_path: 'panel.html' },
    host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
  };
  await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dist;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildTechCheck();
