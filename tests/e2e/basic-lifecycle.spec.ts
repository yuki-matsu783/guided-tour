/**
 * 基本の動作のうち、再起動・終了・バージョン・権限・複数サイト・キーボード操作・ショートカット（AC-21〜27）の E2E。
 */
import { test, expect, ownUi, importTour, beginTour } from './support/fixtures.ts';
import { readProductionManifest } from './support/build.ts';
import { expectMiniGuideStep, expectNoOwnUi, expectPanelStep, hasProgress, sleep } from './support/flows.ts';
import { openPanel as openPanelOf } from './support/panel.ts';
import { standardTour, tourOn, yamlFile } from './support/tour.ts';
import type { FileChooser, Page } from '@playwright/test';
import { z } from 'zod';

test('E-21: 一時中断せずにブラウザを再起動しても、「続きから」で同じステップから再開できる', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const tour = standardTour({ origin: server.origin });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await panel.next();
  await expectPanelStep(panel, '2/4');
  // 進捗が保存されるのを待つ
  await expect.poll(() => hasProgress(ext, tour.id)).toBe(true);

  // 同じユーザーデータでブラウザを閉じて起動し直す（実行中の状態は失われ、進捗は残る）
  const restarted = await ext.restart();
  expect(await restarted.storageSession('tour')).toBeUndefined();
  const tab2 = await restarted.openTab(server.url('/internal/'));
  const panel2 = await openPanelOf(restarted);
  const card = panel2.card(tour.name);
  await expect(card).toContainText('2/4 ステップまで進みました');
  await expect(card.getByRole('button', { name: '続きから' })).toBeVisible();
  // 再起動しただけでは、ミニガイドは自動では出ない
  expect(await ownUi(tab2).hostCount()).toBe(0);

  await panel2.resume(tour.name);
  await panel2.useTab();
  await expectPanelStep(panel2, '2/4');
  await expectMiniGuideStep(ownUi(tab2), '2/4');
});

test('E-22: 途中で終了すると進捗が破棄され、次回は最初から開始される', async ({ ext, server, openTab, openPanel }) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const tour = standardTour({ origin: server.origin });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await panel.next();
  await expectPanelStep(panel, '2/4');
  await panel.next();
  await expectPanelStep(panel, '3/4');
  await expect.poll(() => hasProgress(ext, tour.id)).toBe(true);

  await panel.stop();
  await expect(panel.page.getByRole('status').filter({ hasText: 'ツアーを終了しました' })).toBeVisible();
  await expect(panel.card(tour.name).getByRole('button', { name: '続きから' })).toHaveCount(0);
  await expect(panel.card(tour.name).getByRole('button', { name: '最初から', exact: true })).toBeVisible();
  await expect.poll(() => hasProgress(ext, tour.id)).toBe(false);

  // 再度開始すると最初のステップから（進捗が破棄されているので「続きから」は無い）
  await beginTour(panel, tour.name, tab);
  await expectPanelStep(panel, '1/4');
  await expect(panel.hintText()).toContainText('名前を入力してください');
});

test('E-22: 終了したあと、同じタブで（再読み込みせずに）再び開始すると、ミニガイドが最初のステップで出る', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = standardTour({ origin: server.origin });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/4');
  await panel.stop();
  await expectNoOwnUi(ui);

  await beginTour(panel, tour.name, tab);
  await expectPanelStep(panel, '1/4');
  await expectMiniGuideStep(ui, '1/4');
});

test('E-23: 要求バージョンを満たさないツアーは開始されず、現在と必要なバージョンが表示される', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const tour = tourOn(server.origin, { exact: '/static' }, [{ id: 'only', title: '唯一の手順' }], {
    id: 'e2e-newer',
    name: '新しい版が要るツアー',
    minExtensionVersion: '99.0.0',
  });
  await importTour(panel, tour);
  await tab.bringToFront();
  await panel.start(tour.name);

  const current = (await readProductionManifest()).version;
  await expect(panel.page.getByRole('alert')).toContainText(`現在 ${current}`);
  await expect(panel.page.getByRole('alert')).toContainText('必要 99.0.0 以上');
  await expect(panel.page.locator('.screen-running')).toHaveCount(0);
  await expect(panel.card(tour.name)).toBeVisible();
  await expectNoOwnUi(ownUi(tab));
});

test('E-24: 実行中にサイトの許可を取り消すと一時中断になり、理由と再び許可する手段が出て、表示が消える（手動で補う）', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  // 許可のダイアログそのものは E2E で操作できない（手動）。取り消しは、利用者がサイトへのアクセスを外す操作で再現する
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = standardTour({ origin: server.origin });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/4');

  await ext.revokeSite('http://localhost/*');
  await expect(panel.page.locator('.screen-paused')).toBeVisible();
  await expect(panel.page.locator('.screen-paused .notice')).toContainText('許可が取り消されたため、一時中断しました');
  await expect(panel.page.locator('.screen-paused')).toContainText(`必要なサイト: ${server.origin}`);
  await expect(panel.page.getByRole('button', { name: '再び許可して再開' })).toBeVisible();
  await expectNoOwnUi(ui);

  // 許可が戻ったあと、再開の操作で続けられる（許可済みなら確認は出ない）
  await ext.grantSite('http://localhost/*');
  await panel.resumePaused();
  await expect(panel.page.locator('.screen-running')).toBeVisible();
  await expectMiniGuideStep(ui, '1/4');
});

test('E-25: ツアー A で権限を得たサイトでも、origins に含まないツアー B の実行中は、何も表示されず通信もしない', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const tourA = standardTour({
    origin: server.origin,
    extraOrigins: [server.altOrigin],
    id: 'e2e-tour-a',
    name: 'ツアー A（localhost と 127.0.0.1）',
  });
  const tourB = standardTour({ origin: server.origin, id: 'e2e-tour-b', name: 'ツアー B（localhost だけ）' });
  await importTour(panel, tourA);
  await importTour(panel, tourB);
  const recorder = await ext.recordMessages();

  // ツアー A の実行で、127.0.0.1 の権限を持つ
  await beginTour(panel, tourA.name, tab);
  await expectMiniGuideStep(ownUi(tab), '1/4');
  expect((await ext.permissions()).origins).toContain('http://127.0.0.1/*');
  await panel.stop();

  // ツアー B を実行し、127.0.0.1 のページを開く
  await beginTour(panel, tourB.name, tab);
  await expectMiniGuideStep(ownUi(tab), '1/4');
  await recorder.take();
  const outside = await openTab(server.url('/internal/', '127.0.0.1'));
  await sleep(2500);
  expect(await ownUi(outside).hostCount()).toBe(0);
  expect((await recorder.take()).filter((m) => m.tabId !== null && m.type !== 'LOG')).toEqual([]);
  // ツアー B の対象のタブには、引き続き表示が出ている
  await expectMiniGuideStep(ownUi(tab), '1/4');
});

test('E-26: マウスを使わず、キーボードだけで主な操作をすべて実行でき、フォーカスが見える', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  test.setTimeout(120_000);
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const page = panel.page;
  const tour = standardTour({ origin: server.origin });
  const file = yamlFile(tour);

  /** Tab キーで `target` にフォーカスを進める（実際のキー入力）。フォーカスの見た目も確かめる。 */
  const tabTo = async (target: ReturnType<Page['locator']>): Promise<void> => {
    for (let i = 0; i < 80; i++) {
      if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
        const look = await target.evaluate((el) => ({
          visible: el.matches(':focus-visible'),
          outline: parseFloat(getComputedStyle(el).outlineWidth) || 0,
        }));
        expect(look.visible).toBe(true);
        expect(look.outline).toBeGreaterThan(0);
        return;
      }
      await page.keyboard.press('Tab');
    }
    throw new Error('Tab キーでフォーカスが届かなかった');
  };
  const activate = async (target: ReturnType<Page['locator']>, key = 'Enter'): Promise<void> => {
    await tabTo(target);
    await page.keyboard.press(key);
  };

  // 取り込み（ファイル選択）。同じ ID をもう一度取り込むと、上書きの確認が出る
  // ファイル選択の受け口は、キーを押す前に用意しておく（後から用意すると、取りこぼす）
  const chooser: { current: FileChooser | null } = { current: null };
  page.on('filechooser', (c) => {
    chooser.current = c;
  });
  const readChooser = (): FileChooser | null => chooser.current;
  const importOnce = async (): Promise<void> => {
    chooser.current = null;
    await tabTo(page.getByRole('button', { name: 'ファイルを選ぶ' }));
    await page.keyboard.press('Enter');
    await expect.poll(() => readChooser() !== null).toBe(true);
    await readChooser()?.setFiles([file]);
  };
  await importOnce();
  await expect(page.locator('.result-ok')).toHaveCount(1);
  await importOnce();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.result-cancelled')).toHaveCount(1);
  await importOnce();
  await expect(dialog).toBeVisible();
  await activate(dialog.getByRole('button', { name: '上書きする' }));
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.result-ok')).toHaveCount(1);

  // 設定の変更（ミニガイドの表示とログレベル）
  await activate(page.getByRole('button', { name: '設定', exact: true }));
  await activate(page.getByRole('checkbox', { name: 'ミニガイドを表示しない' }), 'Space');
  await expect(page.getByRole('checkbox', { name: 'ミニガイドを表示しない' })).toBeChecked();
  await page.keyboard.press('Space');
  await expect(page.getByRole('checkbox', { name: 'ミニガイドを表示しない' })).not.toBeChecked();
  await tabTo(page.getByRole('combobox', { name: 'ログレベル' }));
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('combobox', { name: 'ログレベル' })).toHaveValue('info');
  await expect
    .poll(async () => {
      const settings = await ext.storageLocal('settings');
      const level: unknown = typeof settings === 'object' && settings !== null ? Reflect.get(settings, 'logLevel') : undefined;
      return level;
    })
    .toBe('info');
  await activate(page.getByRole('button', { name: '一覧へ戻る' }));

  // 開始と、役割のタブの対応付け
  await tab.bringToFront();
  await activate(panel.card(tour.name).getByRole('button', { name: '最初から', exact: true }));
  await activate(page.getByRole('button', { name: /として使う$/ }).first());
  await expect(page.locator('.screen-running')).toBeVisible();
  await expectMiniGuideStep(ui, '1/4');

  // ステップ移動（次へ・戻る・ステップ一覧）
  // 新しい表示から 500 ミリ秒は移動が受け付けられないので、ステップの表示が変わるまで押し直す
  const activateMove = async (target: ReturnType<Page['locator']>, step: string, key = 'Enter'): Promise<void> => {
    await expect(async () => {
      if ((await panel.stepBadge().textContent()) === step) return;
      await activate(target, key);
      await expectPanelStep(panel, step);
    }).toPass({ timeout: 20_000 });
  };
  await activateMove(page.getByRole('button', { name: '次へ', exact: true }), '2/4');
  await activateMove(page.getByRole('button', { name: '戻る', exact: true }), '1/4');
  await activateMove(page.getByRole('button', { name: /^3\. / }), '3/4', 'Space');

  // 表示の切り替え
  await activate(page.getByRole('button', { name: '表示を消す' }));
  await expect(page.getByRole('button', { name: '表示を戻す' })).toBeVisible();
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).toBeNull();
  await activate(page.getByRole('button', { name: '表示を戻す' }));
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();

  // ミニガイドの操作（ページの Tab 順を進んで、実際のキーで操作する）
  await tab.bringToFront();
  const focus = async (label: string | RegExp): Promise<void> => {
    const found = await ui.tabTo(label);
    expect(found.focusVisible).toBe(true);
    expect(found.outlineWidth).toBeGreaterThan(0);
  };
  await focus('ミニガイドの幅');
  const before = (await ui.miniGuide())?.width ?? 0;
  await tab.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await ui.miniGuide())?.width).toBe(before + 16);
  await tab.keyboard.press('ArrowRight');
  await expect.poll(async () => (await ui.miniGuide())?.width).toBe(before);
  // ここも移動のボタン。新しい表示から 500 ミリ秒は受け付けられないので、ステップの表示が変わるまで押し直す
  const pressMove = async (label: string, step: string): Promise<void> => {
    await expect(async () => {
      if ((await panel.stepBadge().textContent()) === step) return;
      await focus(label);
      await tab.keyboard.press('Enter');
      await expectPanelStep(panel, step);
    }).toPass({ timeout: 20_000 });
  };
  await pressMove('戻る', '2/4');
  await pressMove('次へ', '3/4');
  await focus('最小化');
  await tab.keyboard.press('Enter');
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('bar');
  await focus(/^ガイドを開く/);
  await tab.keyboard.press('Enter');
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('expanded');

  // 一時中断と再開、終了
  await activate(page.getByRole('button', { name: '一時中断' }));
  await expect(page.locator('.screen-paused')).toBeVisible();
  await expectNoOwnUi(ui);
  await activate(page.getByRole('button', { name: '再開', exact: true }));
  await expect(page.locator('.screen-running')).toBeVisible();
  await activate(page.getByRole('button', { name: '終了', exact: true }));
  await expect(page.getByRole('status').filter({ hasText: 'ツアーを終了しました' })).toBeVisible();
  await expectNoOwnUi(ui);
});

test('E-27: ショートカットキーでサイドパネルを開く定義が、manifest とブラウザにある（手動で補う）', async ({ ext }) => {
  // 実際のキー入力は Playwright からは拡張機能のショートカットに届かない（手動）。ここでは定義の読み取りだけを確かめる
  const worker = await ext.worker();
  const raw: unknown = await worker.evaluate(() => chrome.runtime.getManifest());
  const manifest = z
    .object({
      commands: z.object({ _execute_action: z.object({ suggested_key: z.object({ default: z.string() }) }) }),
      side_panel: z.object({ default_path: z.string() }),
    })
    .parse(raw);
  expect(manifest.commands._execute_action.suggested_key.default).toBe('Alt+Shift+G');
  expect(manifest.side_panel.default_path).toBe('sidepanel.html');
  const names = await worker.evaluate(async () => (await chrome.commands.getAll()).map((c) => c.name));
  expect(names).toContain('_execute_action');
  // 拡張機能のアイコン（ショートカットも同じ操作）でサイドパネルが開く設定になっている
  await expect
    .poll(() => worker.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick))
    .toBe(true);
});
