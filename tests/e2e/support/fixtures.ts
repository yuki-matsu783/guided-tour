/**
 * E2E のテストが使う `test` と `expect`。各 spec はここから import する。
 *
 * フィクスチャ:
 * - `server`（ワーカー単位）: テスト用 Web サーバー（server.ts）。`server.url('/static')`。
 * - `ext`: 拡張機能を読み込んだ Chromium（launch.ts）。テストごとに新しく起動し、終わりに閉じる。
 * - `openTab(url, inWindowOf?)`: 新しいタブを開いて返す（`ext.openTab`）。既定は最初のウィンドウ。`inWindowOf` に別のタブの
 *   `Page` を渡すと、そのタブと同じウィンドウに開く。開いたタブがそのウィンドウの選択中のタブになる。
 * - `openWindow(url)`: 別のウィンドウでタブを開いて返す（`ext.openWindow`）。ヘッドレスでは最後に作ったウィンドウが前面になる。
 * - `openPanel()`: サイドパネルを別ウィンドウのタブで開く（panel.ts）。元のウィンドウのフォーカスは変えない。
 *
 * フィクスチャではない補助（import して使う）:
 * - `ownUi(page)`: ページ上の表示の検査と操作（own-ui.ts）。
 * - `importTour(panel, source)`: ツアーを取り込み、成功を待つ（`TourSpec`・YAML 文字列・`ImportFile`）。
 * - `beginTour(panel, name, tab)`: 一覧からツアーを「最初から」開始し、`tab` を役割のタブとして対応付ける。
 *   開始後、サイドパネルが実行中の画面になるまで待つ。
 *
 * 複数のテストが同時に動くので、テスト同士で状態を共有しない（ブラウザもサーバーのページもテストごとに独立）。
 */
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeAllExtensions, launchExtension } from './launch.ts';
import type { Extension } from './launch.ts';
import { ownUi } from './own-ui.ts';
import { openPanel } from './panel.ts';
import type { SidePanel } from './panel.ts';
import { startServer } from './server.ts';
import type { TestServer } from './server.ts';
import { yamlFile } from './tour.ts';
import type { ImportFile, TourSpec } from './tour.ts';

export interface Fixtures {
  ext: Extension;
  openTab: (url: string, inWindowOf?: Page) => Promise<Page>;
  openWindow: (url: string) => Promise<Page>;
  openPanel: () => Promise<SidePanel>;
}

interface WorkerFixtures {
  server: TestServer;
}

function isImportFile(source: TourSpec | string | ImportFile): source is ImportFile {
  return typeof source === 'object' && 'buffer' in source && 'mimeType' in source;
}

/** ツアーを取り込み、成功の表示を待つ。 */
export async function importTour(panel: SidePanel, source: TourSpec | string | ImportFile): Promise<void> {
  const file = isImportFile(source) ? source : yamlFile(source);
  await panel.importFiles([file]);
  await expect(panel.importResults().locator('.result-ok')).toHaveCount(1);
  await panel.press(panel.importResults().getByRole('button', { name: '結果を閉じる' }));
}

/** 一覧からツアーを「最初から」開始し、`tab` を役割のタブとして対応付けて、実行中の画面を待つ。 */
export async function beginTour(panel: SidePanel, tourName: string | RegExp, tab: Page): Promise<void> {
  await tab.bringToFront();
  await panel.start(tourName);
  await panel.useTab();
  await expect(panel.page.locator('.screen-running')).toBeVisible();
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  server: [
    // Playwright は第1引数をオブジェクトの分割代入で書くことを求める（依存するフィクスチャが無いので空になる）
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const server = await startServer();
      await provide(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  // eslint-disable-next-line no-empty-pattern
  ext: async ({}, provide) => {
    const ext = await launchExtension();
    await provide(ext);
    await closeAllExtensions();
  },

  openTab: async ({ ext }, provide) => {
    await provide(async (url, inWindowOf) =>
      ext.openTab(url, inWindowOf === undefined ? undefined : (await ext.tabInfo(inWindowOf)).windowId),
    );
  },

  openWindow: async ({ ext }, provide) => {
    await provide((url) => ext.openWindow(url));
  },

  openPanel: async ({ ext }, provide) => {
    await provide(() => openPanel(ext));
  },
});

export { expect, ownUi };
