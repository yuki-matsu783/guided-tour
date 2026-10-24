/**
 * 受け入れ基準に直接ない振る舞い（要件のうち FR・エラー表）の E2E。
 * 一覧の表示（FR-29〜31）、タブの付け替え（FR-86）、一時中断（FR-99・102）、改訂後の続きから（FR-103）、
 * 対象を表示・追従（FR-41〜43）、組み込めないページ（エラー表）、劣化（FR-77・72）、設定の画面（FR-108〜114）。
 */
import { createServer } from 'node:net';
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { test, expect, ownUi, importTour, beginTour } from './support/fixtures.ts';
import type { Fixtures } from './support/fixtures.ts';
import type { TestServer } from './support/server.ts';
import { expectMiniGuideStep, expectNoOwnUi, expectPanelStep, hasProgress, sleep } from './support/flows.ts';
import type { Extension } from './support/launch.ts';
import { openPanel as openPanelOf } from './support/panel.ts';
import { standardTour, tourOn, urlCond, yamlFile } from './support/tour.ts';
import type { StepSpec, TourSpec } from './support/tour.ts';

/** 移動の操作は、新しい表示が届いてから 500 ミリ秒の間は受け付けられない（製品の仕様）。その分を待つ。 */
const MOVE_WAIT_MS = 600;

const StateSchema = z.object({
  status: z.string(),
  stepId: z.string(),
  tabs: z.record(z.string(), z.object({ tabId: z.number() })),
});

async function tourState(ext: Extension): Promise<z.output<typeof StateSchema>> {
  return StateSchema.parse(await ext.storageSession('tour'));
}

/** 対象が決まらず保守記録に「矛盾」が残る、1ステップのツアー（`/loc/guard-name`）。 */
function conflictTour(origin: string, id: string, name: string): TourSpec {
  return tourOn(
    origin,
    { exact: '/loc/guard-name' },
    [{ id: 'only', title: '矛盾する手順', target: { tourId: 'g-target', require: { name: ['保存'] }, fallbackText: '案内です' } }],
    { id, name },
  );
}

test('E-74: 一覧にツアーの名称・概要・ステップ数・対象サイト・出所・許可・要確認が出て、進捗があれば「続きから」「最初から」が出る', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const tour = standardTour({ origin: server.origin });
  await importTour(panel, tour);
  const card = panel.card(tour.name);
  await expect(card).toContainText('E2E 用の標準ツアー');
  await expect(card.locator('.facts')).toContainText('ステップ数');
  await expect(card.locator('.facts')).toContainText('4');
  await expect(card.locator('.facts')).toContainText(server.origin);
  await expect(card.locator('.badges')).toContainText('取り込み');
  await expect(card.locator('.badges')).toContainText('サイトの許可あり');
  await expect(card.getByRole('button', { name: '続きから' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '最初から', exact: true })).toBeVisible();

  // 進捗が残った状態（再起動）で、到達したステップと保存日時が示される
  await beginTour(panel, tour.name, tab);
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '2/4');
  await expect.poll(() => hasProgress(ext, tour.id)).toBe(true);
  const restarted = await ext.restart();
  const panel2 = await openPanelOf(restarted);
  const card2 = panel2.card(tour.name);
  await expect(card2).toContainText('2/4 ステップまで進みました（保存:');
  await expect(card2.getByRole('button', { name: '続きから' })).toBeVisible();
  await expect(card2.getByRole('button', { name: '最初から', exact: true })).toBeVisible();
  await expect(card2.locator('.badges')).not.toContainText('要確認');

  // 保守記録が残ると「要確認」が付く
  const other = conflictTour(server.origin, 'e2e-review', '要確認になるツアー');
  const tab2 = await restarted.openTab(server.url('/loc/guard-name'));
  await importTour(panel2, other);
  await beginTour(panel2, other.name, tab2);
  await expect
    .poll(async () => JSON.stringify(await panel2.page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' }))), { timeout: 20_000 })
    .toContain('conflict');
  await panel2.stop();
  await expect(panel2.card(other.name).locator('.badges')).toContainText('要確認');
});

test('E-75: すでに別の役割に対応付けたタブを別の役割に選ぶと、その旨が示され、付け替えの確認が出て、承認すると付け替わる', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const any = urlCond(server.origin, { prefix: '/' });
  const tour: TourSpec = {
    id: 'e2e-two-roles',
    name: '2つの役割のツアー',
    origins: [server.origin],
    tabs: {
      main: { label: 'メイン', open: server.url('/static'), url: any },
      sub: { label: 'サブ', open: server.url('/project'), url: any },
    },
    steps: [
      { id: 's1', title: 'メインを使う', tab: 'main' },
      { id: 's2', title: 'サブを使う', tab: 'sub' },
    ],
  };
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  const mainTabId = (await tourState(ext)).tabs.main?.tabId;
  expect(mainTabId).toBeDefined();
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '2/2');

  // 「サブ」には、「メイン」に対応付け済みのタブが候補に出る
  await expect(panel.page.locator('.candidates')).toContainText('「main」に対応付け済み');
  await panel.useTab();
  await expect(panel.page.getByRole('alertdialog')).toContainText('すでに「main」に対応付けられています');
  await panel.cancel();
  expect((await tourState(ext)).tabs.sub).toBeUndefined();

  await panel.useTab();
  await panel.confirm();
  await expect.poll(async () => (await tourState(ext)).tabs.sub?.tabId).toBe(mainTabId);
  await expectMiniGuideStep(ownUi(tab), '2/2');
});

test('E-76: 一時中断すると、ページ上の表示とミニガイドがすべて消え、再開・最初からやり直し・終了の選択肢と、一時中断と終了の違いの説明が出る', async ({
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
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '2/4');
  await expectMiniGuideStep(ui, '2/4');

  await panel.pause();
  const paused = panel.page.locator('.screen-paused');
  await expect(paused).toBeVisible();
  await expectNoOwnUi(ui);
  await expect(paused.getByRole('button', { name: '再開' })).toBeVisible();
  await expect(paused.getByRole('button', { name: '最初からやり直し' })).toBeVisible();
  await expect(paused.getByRole('button', { name: '終了', exact: true })).toBeVisible();
  await expect(paused.locator('.explain')).toContainText('一時中断');
  await expect(paused.locator('.explain')).toContainText('終了');
  await expect(paused.locator('.explain')).toContainText('進捗は残る');
  await expect(paused.locator('.explain')).toContainText('進捗を破棄');

  // 再開: 同じステップ
  await panel.resumePaused();
  await expectPanelStep(panel, '2/4');
  await expectMiniGuideStep(ui, '2/4');
  // 最初からやり直し
  await panel.pause();
  await expectNoOwnUi(ui, 300);
  await panel.restartPaused();
  await expectPanelStep(panel, '1/4');
  await expectMiniGuideStep(ui, '1/4');
  // 終了
  await panel.pause();
  await panel.stop();
  await expect(panel.page.getByRole('status').filter({ hasText: 'ツアーを終了しました' })).toBeVisible();
  await expectNoOwnUi(ui, 300);
});

test('E-77: 保存されたステップが新版に無いツアーで「続きから」を選ぶと、「ツアーが更新されたため最初から開始します」と表示され、最初のステップから始まる', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const tour = standardTour({ origin: server.origin, id: 'e2e-revised', name: '改訂されるツアー' });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '2/4');
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '3/4');
  await expect.poll(() => hasProgress(ext, tour.id)).toBe(true);

  // 再起動し、保存されたステップ（s3）を無くした新版を取り込む
  const restarted = await ext.restart();
  const tab2 = await restarted.openTab(server.url('/internal/'));
  const panel2 = await openPanelOf(restarted);
  const revised: TourSpec = { ...tour, steps: tour.steps.map((s: StepSpec) => (s.id === 's3' ? { ...s, id: 's3-new' } : s)) };
  await panel2.importFiles([yamlFile(revised)]);
  await panel2.confirm();
  await expect(panel2.importResults().locator('.result-ok')).toHaveCount(1);
  await expect(panel2.card(tour.name)).toContainText('3/4 ステップまで進みました');

  await panel2.resume(tour.name);
  await panel2.useTab();
  await expect(panel2.page.getByText('ツアーが更新されたため最初から開始します')).toBeVisible();
  await expectPanelStep(panel2, '1/4');
  await expectMiniGuideStep(ownUi(tab2), '1/4');
});

const farStep = (id: string): StepSpec => ({
  id,
  title: '下の方のボタン',
  target: { tourId: 'far-button', fallbackText: '下の方のボタンが対象です' },
});

test('E-78: 「対象を表示」を押すと画面外の要素までスクロールし、対象の位置・大きさが変わると枠と吹き出しが追従する', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static-tall'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = tourOn(server.origin, { exact: '/static-tall' }, [farStep('only')], { id: 'e2e-far', name: '画面外のツアー' });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/1');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null, { timeout: 15_000 }).not.toBeNull();
  await tab.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await expect.poll(() => tab.evaluate(() => window.scrollY)).toBe(0);

  await panel.press(panel.page.getByRole('button', { name: '対象を表示' }));
  await expect.poll(() => tab.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  const inView = async (): Promise<boolean> => {
    const frame = (await ui.overlay())?.frame;
    const height = await tab.evaluate(() => window.innerHeight);
    return frame !== undefined && frame !== null && frame.y >= 0 && frame.y < height - 10;
  };
  await expect.poll(inView).toBe(true);

  // 位置・大きさを変えると、枠と吹き出しが追従する
  const before = (await ui.overlay())?.frame;
  const bubbleBefore = (await ui.overlay())?.bubble?.rect;
  await tab.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-tour-id=far-button]');
    if (el === null) return;
    el.style.marginLeft = '260px';
    el.style.width = '300px';
  });
  await expect
    .poll(async () => {
      const now = (await ui.overlay())?.frame;
      return now !== undefined && now !== null && before !== undefined && before !== null && now.x - before.x > 200 && now.width - before.width > 100;
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const bubble = (await ui.overlay())?.bubble?.rect;
      return bubble !== undefined && bubbleBefore !== undefined && bubble.x !== bubbleBefore.x;
    })
    .toBe(true);
});

/** 注目中・注目中でないときに、ステップに入ったあとのスクロールの量を見る。 */
async function enterTallStep(
  ctx: Pick<Fixtures, 'ext' | 'openTab' | 'openPanel'> & { server: TestServer },
  attended: boolean,
): Promise<{ tab: Page; scrolled: () => Promise<number> }> {
  const tab = await ctx.openTab(ctx.server.url('/static-tall'));
  const panel = await ctx.openPanel();
  const tour = tourOn(
    ctx.server.origin,
    { exact: '/static-tall' },
    [{ id: 'first', title: '最初の手順' }, farStep('second')],
    { id: `e2e-scroll-${String(attended)}`, name: 'スクロールのツアー' },
  );
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ownUi(tab), '1/2');
  if (!attended) await ctx.ext.blurWindow(tab);
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '2/2');
  return { tab, scrolled: () => tab.evaluate(() => window.scrollY) };
}

test('E-79: 注目中のタブでステップに入ると1回だけスクロールする', async ({ ext, server, openTab, openPanel }) => {
  const { tab, scrolled } = await enterTallStep({ ext, server, openTab, openPanel }, true);
  await expect.poll(scrolled, { timeout: 15_000 }).toBeGreaterThan(1000);
  // そのあとは、探し直しや再検証が何度あっても、勝手にスクロールを戻さない・やり直さない
  await tab.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await sleep(3500);
  expect(await scrolled()).toBe(0);
});

test('E-79: 注目中でないタブでステップに入ってもスクロールしない', async ({ ext, server, openTab, openPanel }) => {
  const { scrolled } = await enterTallStep({ ext, server, openTab, openPanel }, false);
  await sleep(3500);
  expect(await scrolled()).toBe(0);
});

test('E-80: ページ側を組み込めないページ（通信に失敗したページ）を役割のタブにしてステップに入ると、「このページでは表示できません」と「再確認」が表示される', async ({
  ext,
  openPanel,
}) => {
  // 誰も待ち受けていないポートを作る（接続が拒否され、エラーのページになる）
  const closedPort = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : -1;
      probe.close(() => {
        resolve(port);
      });
    });
  });
  const origin = `http://localhost:${String(closedPort)}`;
  const url = `${origin}/dead`;
  const worker = await ext.worker();
  const [tab] = await Promise.all([
    ext.context.waitForEvent('page'),
    worker.evaluate(async ({ url, windowId }) => {
      await chrome.tabs.create({ url, windowId, active: true });
    }, { url, windowId: ext.mainWindowId }),
  ]);
  await expect.poll(async () => (await worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url ?? ''))).some((u) => u.includes(`:${String(closedPort)}/dead`))).toBe(true);
  await sleep(500);

  const panel = await openPanel();
  const tour = tourOn(origin, { prefix: '/' }, [{ id: 'only', title: '開けないページの手順', target: { tourId: 'x', fallbackText: '案内です' } }], {
    id: 'e2e-dead',
    name: '開けないページのツアー',
    open: url,
  });
  await importTour(panel, tour);
  await tab.bringToFront();
  await panel.start(tour.name);
  await panel.useTab();
  await expect(panel.page.locator('.screen-running')).toBeVisible();
  await expect(panel.page.locator('.tab-controls')).toContainText('このページでは表示できません');
  await expect(panel.page.getByRole('button', { name: '再確認' })).toBeVisible();
  expect(await ownUi(tab).hostCount()).toBe(0);
});

test('E-81: 段階1が失敗して段階2で成功する指定では、段階が下がって成功し、保守記録に「劣化」が残る', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = standardTour({ origin: server.origin, steps: 1 });
  const step: StepSpec = {
    id: 'only',
    title: '申請する',
    target: { tourId: 'no-such-id', role: 'button', name: ['申請する'], fallbackText: '申請ボタンが対象です' },
  };
  await importTour(panel, { ...tour, id: 'e2e-degraded', name: '劣化するツアー', steps: [step] });
  await beginTour(panel, '劣化するツアー', tab);
  await expectMiniGuideStep(ui, '1/1');
  // 段階2（役割と名前）で、申請ボタンがハイライトされる
  await expect.poll(async () => (await ui.overlay())?.frame ?? null, { timeout: 15_000 }).not.toBeNull();
  const frame = await ui.overlay().then((o) => o?.frame);
  const box = await tab.locator('[data-tour-id=submit-button]').boundingBox();
  expect(Math.abs((frame?.x ?? -999) - ((box?.x ?? 0) - 4))).toBeLessThan(12);

  await expect
    .poll(async () => JSON.stringify(await panel.page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' }))))
    .toContain('degraded');
  await panel.stop();
  await panel.openSettings();
  await expect(panel.page.locator('.diagnostics')).toContainText('劣化');
  await expect(panel.page.locator('.diagnostics')).toContainText('ステップ only');
  await expect(panel.page.locator('.diagnostics')).toContainText('採用した段階 2');
});

test('E-82: 設定の画面で、ログレベルの変更、保守記録のツアー別・ステップ別の確認、書き出し、消去ができ、消去後は空になる', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/loc/guard-name'));
  const panel = await openPanel();
  const tour = conflictTour(server.origin, 'e2e-settings', '設定を確かめるツアー');
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expect
    .poll(async () => JSON.stringify(await panel.page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' }))), { timeout: 20_000 })
    .toContain('conflict');
  await panel.stop();
  await panel.openSettings();

  // ログレベルの変更（保存され、開き直しても保たれる）
  const level = panel.page.getByLabel('ログレベル');
  await level.selectOption('debug');
  await expect.poll(async () => JSON.stringify(await ext.storageLocal('settings'))).toContain('"debug"');
  await panel.page.reload();
  await panel.openSettings();
  await expect(panel.page.getByLabel('ログレベル')).toHaveValue('debug');

  // 保守記録: ツアー別・ステップ別
  const diag = panel.page.locator('.diagnostics');
  await expect(diag.getByRole('region', { name: `ツアー ${tour.name} の保守記録` })).toBeVisible();
  await expect(diag).toContainText('ステップ only');
  await expect(diag).toContainText('矛盾');

  // 書き出し
  await panel.press(panel.page.getByRole('button', { name: 'ログと保守記録を書き出す' }));
  await expect(panel.page.getByRole('status').filter({ hasText: 'ログと保守記録をファイルに保存しました' })).toBeVisible();

  // 消去（確認のあと、保守記録が空になる）
  await panel.press(panel.page.getByRole('button', { name: 'ログと保守記録を消去' }));
  await panel.cancel();
  await expect(diag).toContainText('矛盾');
  await panel.press(panel.page.getByRole('button', { name: 'ログと保守記録を消去' }));
  await panel.confirm();
  await expect(panel.page.getByRole('status').filter({ hasText: 'ログと保守記録を消去しました' })).toBeVisible();
  await expect(panel.page.getByText('保守記録はありません')).toBeVisible();
});
