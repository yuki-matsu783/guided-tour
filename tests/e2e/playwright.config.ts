/**
 * Playwright Test の設定。拡張機能を読み込んだ Chromium（ヘッドレス）で、テスト用のローカルページを使って受け入れ基準を通す。
 * 拡張機能は globalSetup が作る（作り方は support/build.ts の説明を参照）。Vitest の対象外。
 * `E2E_HEADED=1` で画面ありにできる（support/launch.ts）。
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  globalSetup: './global-setup.ts',
  // 1テストが拡張機能付きの Chromium を1つ起動する。テスト同士は独立なので並列にできる
  fullyParallel: true,
  workers: process.env.E2E_WORKERS === undefined ? 4 : Number(process.env.E2E_WORKERS),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results/e2e',
});
