/**
 * 全テストの前に、E2E 用の拡張機能を1回だけ作る。場所は環境変数 `E2E_EXTENSION_DIR` で各テストへ渡す。
 * 終わったら一時ディレクトリを消す。
 */
import { buildTestExtension } from './support/build.ts';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const extension = await buildTestExtension();
  process.env.E2E_EXTENSION_DIR = extension.dir;
  return extension.cleanup;
}
