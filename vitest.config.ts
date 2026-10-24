/**
 * Vitest の設定。
 * 既定の実行環境は node。jsdom が要るファイルは、先頭に `// @vitest-environment jsdom` を書いて切り替える。
 * tests/e2e/ は Playwright で動かすので対象外にする。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    passWithNoTests: true,
  },
});
