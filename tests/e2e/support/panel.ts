/**
 * サイドパネルの操作の補助。
 *
 * Playwright からは本物のサイドパネルを操作できないので、`chrome-extension://<id>/sidepanel.html` を
 * 別ウィンドウのタブとして開いて操作する（実物と同じ画面）。別ウィンドウ・非フォーカスで開くので、
 * テスト用ページのタブは「注目中のタブ」のまま（`windows.get().focused` が真）になる。
 *
 * 使い方（`const panel = await openPanel(ext)`）:
 * - `panel.page`: サイドパネルの Playwright の `Page`。画面の文言は src/sidepanel/components/ を読んで合わせる。
 * - `panel.press(locator)`: 任意のボタンなどを押す（下の理由で、実際のマウスを使わない）。
 * - `panel.card(name)`: 一覧のツアーのカード（ツアー名で探す）。`panel.start(name)` は「最初から」、`panel.resume(name)` は「続きから」を押す。
 * - `panel.importFiles(files)`: 取り込み（`input[type=file]` に `setInputFiles`）。`panel.importResults()` が結果の領域。
 * - `panel.dropFiles(files)`: `data-testid="dropzone"` へドロップして取り込む。
 * - `panel.next()` / `prev()` / `finish()` / `gotoStep(n)`: 実行中の画面の移動（`gotoStep` は 1 始まりの番号）。
 *   新しい表示から 500 ミリ秒は移動の操作が受け付けられないので、押してステップの表示（n/N）か完了の表示が
 *   変わるまで待ち、変わらなければ押し直す（押し直しても、二重には移動しない）。
 * - `panel.pause()` / `stop()` / `resumePaused()` / `restartPaused()`: 一時中断・終了・再開・最初からやり直し。
 * - `panel.useTab(pattern?)` / `openHere()` / `openNew()` / `focusRole()` / `recheck()`: タブの操作。`useTab` は「〜として使う」の先頭（`pattern` で選べる）。
 *   既存タブの一覧は、役割のタブが無い間はタブの作成・移動・閉鎖で自動で更新される。`recheck()`（再確認）で取り直すこともできる。
 * - `panel.heading()` / `panel.stepBadge()` / `panel.hintText()` / `panel.notice()`: 画面の文言の読み取り。
 * - `panel.openSettings()` / `panel.setMiniGuideHidden(bool)` / `panel.backToList()`: 設定。
 * - `panel.confirm()` / `panel.cancel()`: 確認の画面（上書き・付け替え・削除・消去）。
 */
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Extension } from './launch.ts';
import type { ImportFile } from './tour.ts';

export interface SidePanel {
  readonly page: Page;
  readonly windowId: number;
  /** ボタンなどを、ユーザージェスチャーつきで押す。実際のマウスは使わない（理由はファイル先頭）。 */
  press(target: Locator): Promise<void>;
  card(name: string | RegExp): Locator;
  start(name: string | RegExp): Promise<void>;
  resume(name: string | RegExp): Promise<void>;
  importFiles(files: ImportFile[]): Promise<void>;
  dropFiles(files: ImportFile[]): Promise<void>;
  importResults(): Locator;
  next(): Promise<void>;
  prev(): Promise<void>;
  finish(): Promise<void>;
  gotoStep(oneBased: number): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  resumePaused(): Promise<void>;
  restartPaused(): Promise<void>;
  useTab(pattern?: string | RegExp): Promise<void>;
  openHere(): Promise<void>;
  openNew(): Promise<void>;
  focusRole(): Promise<void>;
  recheck(): Promise<void>;
  heading(): Locator;
  stepBadge(): Locator;
  hintText(): Locator;
  notice(): Locator;
  openSettings(): Promise<void>;
  setMiniGuideHidden(hidden: boolean): Promise<void>;
  backToList(): Promise<void>;
  confirm(): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/** サイドパネルを別ウィンドウのタブで開く。元のウィンドウのフォーカスは変えない。 */
export async function openPanel(ext: Extension): Promise<SidePanel> {
  const worker = await ext.worker();
  const url = `chrome-extension://${ext.id}/sidepanel.html`;
  const [page, windowId] = await Promise.all([
    ext.context.waitForEvent('page'),
    worker.evaluate(async (u): Promise<number> => {
      const w = await chrome.windows.create({ url: u, type: 'normal', focused: false });
      return w?.id ?? -1;
    }, url),
  ]);
  await page.waitForURL(url);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const cdp = await ext.context.newCDPSession(page);
  const MARK = 'data-e2e-press';
  /** 実際のマウスを使わずに、ユーザージェスチャーつきで `click()` する（理由はファイル先頭を参照）。 */
  const press = async (target: Locator): Promise<void> => {
    await expect(target).toBeVisible();
    await expect(target).toBeEnabled();
    await target.evaluate((el, mark) => {
      el.setAttribute(mark, '');
    }, MARK);
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector('[${MARK}]'); el?.removeAttribute('${MARK}'); el?.click(); })()`,
      userGesture: true,
    });
  };
  const button = (name: string | RegExp): Locator => page.getByRole('button', { name, exact: typeof name === 'string' });
  const click = async (name: string | RegExp): Promise<void> => {
    await press(button(name));
  };
  const stepText = async (): Promise<string | null> => {
    const badge = page.locator('.screen-header [aria-label$="ステップ"]');
    return (await badge.count()) === 0 ? null : badge.first().textContent();
  };
  /** 移動の操作。ステップの表示が変わる（完了なら表示が消える）まで待ち、変わらなければ押し直す。 */
  const move = async (act: () => Promise<void>): Promise<void> => {
    const before = await stepText();
    await expect(async () => {
      // 前の押下の効果が遅れて届いたときは、押し直さない（押すボタンが無くなっていることもある）
      if ((await stepText()) !== before) return;
      await act();
      await expect.poll(stepText, { timeout: 2000 }).not.toBe(before);
    }).toPass({ timeout: 20_000 });
  };
  const card = (name: string | RegExp): Locator =>
    page.locator('li.tour-card').filter({ has: page.getByRole('heading', { level: 3, name }) });
  const setFiles = async (files: ImportFile[]): Promise<void> => {
    await page.locator('input[type=file]').setInputFiles(files);
  };

  return {
    page,
    windowId,
    press,
    card,
    async start(name) {
      await press(card(name).getByRole('button', { name: '最初から', exact: true }));
    },
    async resume(name) {
      await press(card(name).getByRole('button', { name: '続きから', exact: true }));
    },
    importFiles: setFiles,
    async dropFiles(files) {
      const dataTransfer = await page.evaluateHandle((list) => {
        const dt = new DataTransfer();
        for (const f of list) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.mimeType }));
        return dt;
      }, files.map((f) => ({ name: f.name, mimeType: f.mimeType, bytes: [...f.buffer] })));
      await page.getByTestId('dropzone').dispatchEvent('drop', { dataTransfer });
    },
    importResults: () => page.getByRole('status', { name: '取り込みの結果' }),
    next: () => move(() => click('次へ')),
    prev: () => move(() => click('戻る')),
    finish: () => move(() => click('完了')),
    async gotoStep(oneBased) {
      await move(() => press(page.getByRole('button', { name: new RegExp(`^${String(oneBased)}\\. `) })));
    },
    pause: () => click('一時中断'),
    stop: () => click('終了'),
    resumePaused: () => click(/^(再開|再び許可して再開)$/),
    restartPaused: () => click('最初からやり直し'),
    async useTab(pattern) {
      const re = pattern ?? /として使う$/;
      await press(page.getByRole('button', { name: re }).first());
    },
    openHere: () => click('今のタブで開く'),
    openNew: () => click('新しいタブで開く'),
    focusRole: () => click(/のタブへ移動$/),
    recheck: () => click('再確認'),
    heading: () => page.getByRole('heading', { level: 1 }),
    stepBadge: () => page.locator('.screen-header [aria-label$="ステップ"]'),
    hintText: () => page.getByRole('region', { name: '完了の目安' }),
    notice: () => page.locator('.notice, .flash').first(),
    openSettings: () => click('設定'),
    async setMiniGuideHidden(hidden) {
      // 状態は応答のあとに更新されるので、押してから反映を待つ
      const box = page.getByRole('checkbox', { name: 'ミニガイドを表示しない' });
      if ((await box.isChecked()) !== hidden) await press(box);
      await expect(box).toBeChecked({ checked: hidden });
    },
    backToList: () => click('一覧へ戻る'),
    async confirm() {
      await press(page.getByRole('alertdialog').locator('button.danger'));
    },
    async cancel() {
      await press(page.getByRole('alertdialog').locator('button:not(.danger)'));
    },
    async close() {
      await page.close();
    },
  };
}
