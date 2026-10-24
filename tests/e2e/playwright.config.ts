/**
 * Playwright（実機の Chromium に拡張機能を読み込む検査）の設定置き場。
 * dist/ を読み込む前提なので、先に `pnpm run build` を実行する。Vitest の対象外。
 */
export const e2eConfig = {
  extensionPath: 'dist',
  channel: 'chromium',
} as const;
