/**
 * dist/ にビルド成果物を出す。esbuild で 3 本のエントリを IIFE（chrome114）にまとめ、
 * manifest.json・sidepanel.html・public/ をコピーする。
 * typecheck・lint・test の検査は `pnpm run build` 側で先に行う。
 */
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: {
    background: join(root, 'src/background/index.ts'),
    content: join(root, 'src/content/index.ts'),
    sidepanel: join(root, 'src/sidepanel/index.tsx'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome114',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'info',
});

await cp(join(root, 'manifest.json'), join(dist, 'manifest.json'));
await cp(join(root, 'src/sidepanel/index.html'), join(dist, 'sidepanel.html'));
await cp(join(root, 'public'), dist, { recursive: true });
