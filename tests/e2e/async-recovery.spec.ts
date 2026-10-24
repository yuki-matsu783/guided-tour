/**
 * 非同期処理・ツアーの改訂・復帰（AC-58〜68）の E2E。
 * 古い指示や結果を遅れて届ける検査は、製品に試験用の口を作らず、次の方法で本物の送り手と同じ経路から送る。
 * - ページ側 → バックグラウンド: CDP で拡張機能のコンテンツスクリプトの実行環境へ入り、`chrome.runtime.sendMessage` を呼ぶ
 * - バックグラウンド → ページ側: Service Worker の `chrome.tabs.sendMessage` を呼ぶ（送った指示は、呼び出しを包んで控える）
 * - サイドパネル → バックグラウンド: サイドパネルのページから `chrome.runtime.sendMessage` を呼ぶ
 * 実行中の上書き・削除は、取り込み画面のある一覧を別のサイドパネルで開き、確認の画面を出したまま実行を始めて、あとで承認する。
 */
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { test, expect, ownUi, importTour, beginTour } from './support/fixtures.ts';
import { expectMiniGuideStep, expectNoOwnUi, expectPanelStep, hasProgress, sleep, tabCount } from './support/flows.ts';
import type { Extension } from './support/launch.ts';
import { openPanel as openPanelOf } from './support/panel.ts';
import type { SidePanel } from './support/panel.ts';
import { permissionRequests, spyPermissionRequests } from './support/permission-spy.ts';
import { standardTour, tourOn, yamlFile } from './support/tour.ts';
import type { StepSpec, TourSpec } from './support/tour.ts';

/** 移動の操作は、新しい表示が届いてから 500 ミリ秒の間は受け付けられない（製品の仕様）。その分を待つ。 */
const MOVE_WAIT_MS = 600;

const StateSchema = z.object({
  status: z.string(),
  tourId: z.string(),
  sessionId: z.string(),
  gen: z.number(),
  pageSeq: z.number(),
  rev: z.number(),
  stepIndex: z.number(),
  stepId: z.string(),
  hint: z.object({ met: z.boolean() }),
});

/** 実行中の状態（`storage.session` の `tour`）。 */
async function tourState(ext: Extension): Promise<z.output<typeof StateSchema>> {
  return StateSchema.parse(await ext.storageSession('tour'));
}

/**
 * タブの中の拡張機能のコンテンツスクリプトの実行環境から、バックグラウンドへメッセージを送り、応答を返す。
 * 送り手がタブになるので、本物のページ側からの報告と同じ検査を通る。
 */
async function sendFromContent(ext: Extension, tab: Page, message: unknown): Promise<unknown> {
  const cdp = await ext.context.newCDPSession(tab);
  try {
    const worlds: number[] = [];
    cdp.on('Runtime.executionContextCreated', (event) => {
      if (event.context.origin === `chrome-extension://${ext.id}`) worlds.push(event.context.id);
    });
    await cdp.send('Runtime.enable');
    await sleep(200);
    for (const contextId of worlds.toReversed()) {
      const expression = `chrome.runtime.sendMessage(${JSON.stringify(message)})`;
      const evaluated = await cdp
        .send('Runtime.evaluate', { contextId, expression, awaitPromise: true, returnByValue: true })
        .catch(() => null);
      if (evaluated !== null && evaluated.exceptionDetails === undefined) return evaluated.result.value;
    }
    throw new Error('コンテンツスクリプトの実行環境が見つからなかった');
  } finally {
    await cdp.detach();
  }
}

/** サイドパネルのページから、バックグラウンドへメッセージを送り、応答を返す。 */
async function sendFromPanel(panel: SidePanel, message: unknown): Promise<unknown> {
  return panel.page.evaluate((m) => chrome.runtime.sendMessage(m), message);
}

const DiscardedSchema = z.object({ status: z.literal('discarded'), reason: z.string() });

function discardReason(response: unknown): string | null {
  const parsed = DiscardedSchema.safeParse(response);
  return parsed.success ? parsed.data.reason : null;
}

const lateTarget = { tourId: 'late-button', fallbackText: '遅れて出るボタンが対象です' };

function delayedTour(origin: string): TourSpec {
  const steps: StepSpec[] = [
    { id: 's1', title: '手順 1' },
    { id: 's2', title: '手順 2' },
    { id: 's3', title: '手順 3', target: lateTarget },
    { id: 's4', title: '手順 4', target: lateTarget },
    { id: 's5', title: '手順 5' },
  ];
  return tourOn(origin, { exact: '/delayed' }, steps, { id: 'e2e-delayed', name: '遅延追加のツアー' });
}

test('E-58: ステップ3で探索中に4へ移りすぐ3へ戻ったあと、前の回の報告が遅れて届いても採用されない', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/delayed'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = delayedTour(server.origin);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await sleep(MOVE_WAIT_MS);
  await panel.gotoStep(3);
  await expectPanelStep(panel, '3/5');
  await expectMiniGuideStep(ui, '3/5');
  const first = await tourState(ext);
  await sleep(MOVE_WAIT_MS);
  await panel.gotoStep(4);
  await sleep(MOVE_WAIT_MS);
  await panel.gotoStep(3);
  await expectPanelStep(panel, '3/5');
  await expectMiniGuideStep(ui, '3/5');
  const second = await tourState(ext);
  expect(second.stepId).toBe('s3');
  expect(second.gen).toBeGreaterThan(first.gen);

  // 最初の回（同じステップ番号）の探索結果・目安の結果が、遅れて届く
  const stale = { sessionId: first.sessionId, gen: first.gen, pageSeq: first.pageSeq };
  const result = { found: true, tier: 1, topTier: 1, reasons: ['degraded'], counts: [] };
  expect(discardReason(await sendFromContent(ext, tab, { type: 'LOCATE_RESULT', ...stale, result }))).toBe('staleReport');
  expect(
    discardReason(await sendFromContent(ext, tab, { type: 'HINT_STATE', ...stale, met: true, unsupported: false })),
  ).toBe('staleReport');
  expect((await tourState(ext)).hint.met).toBe(false);
  // 今の回の報告は、同じ経路で受け付けられる（送り方が正しいことの確認）
  const current = { sessionId: second.sessionId, gen: second.gen, pageSeq: second.pageSeq };
  expect(discardReason(await sendFromContent(ext, tab, { type: 'HINT_STATE', ...current, met: false, unsupported: false }))).toBeNull();

  // そのあと、対象が現れると、今の回の探索でハイライトされる
  await tab.evaluate(() => {
    const add: unknown = Reflect.get(window, 'addLateButton');
    if (typeof add === 'function') Reflect.apply(add, window, []);
  });
  await expect.poll(async () => (await ui.overlay())?.frame ?? null, { timeout: 15_000 }).not.toBeNull();
});

test('E-59: 同じタブで別のページへ移ったあとに、前のページの報告が届いても採用されず、表示は新しいページと整合する', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = tourOn(
    server.origin,
    { prefix: '/' },
    [{ id: 'only', title: '静的ページの案内', target: { tourId: 'static-button', fallbackText: '送信ボタンが対象です' } }],
    { id: 'e2e-navigate', name: 'ページ移動のツアー', open: server.url('/static') },
  );
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/1');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null, { timeout: 15_000 }).not.toBeNull();
  const hosts = await ui.hostCount();
  const before = await tourState(ext);

  await tab.goto(server.url('/project'));
  await expect.poll(async () => (await tourState(ext)).pageSeq).toBeGreaterThan(before.pageSeq);
  await expectMiniGuideStep(ui, '1/1');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null, { timeout: 15_000 }).not.toBeNull();
  expect((await ui.miniGuide())?.title).toBe('静的ページの案内');
  expect(await ui.hostCount()).toBe(hosts);

  // 前のページの回（pageSeq が古い）の報告が、新しいページから届く
  const stale = { sessionId: before.sessionId, gen: before.gen, pageSeq: before.pageSeq };
  expect(
    discardReason(await sendFromContent(ext, tab, { type: 'HINT_STATE', ...stale, met: true, unsupported: false })),
  ).toBe('staleReport');
  expect(
    discardReason(
      await sendFromContent(ext, tab, {
        type: 'LOCATE_RESULT',
        ...stale,
        result: { found: true, tier: 1, topTier: 1, reasons: ['degraded'], counts: [] },
      }),
    ),
  ).toBe('staleReport');
  expect((await tourState(ext)).hint.met).toBe(false);
  expect(await ui.hostCount()).toBe(hosts);
});

interface Sent {
  tabId: number;
  message: unknown;
}

const SentSchema = z.array(z.object({ tabId: z.number(), message: z.unknown() }));

/** Service Worker の `chrome.tabs.sendMessage` を包み、ページ側へ送った指示を控える。 */
async function captureOutgoing(ext: Extension): Promise<() => Promise<Sent[]>> {
  const worker = await ext.worker();
  await worker.evaluate(() => {
    const key = '__e2eOutgoing';
    if (Reflect.get(globalThis, key) !== undefined) return;
    const list: { tabId: number; message: unknown }[] = [];
    Reflect.set(globalThis, key, list);
    const original: unknown = Reflect.get(chrome.tabs, 'sendMessage');
    Reflect.set(chrome.tabs, 'sendMessage', (tabId: number, message: unknown, options: unknown): unknown => {
      list.push({ tabId, message });
      const stored: unknown = Reflect.get(chrome.tabs, '__e2eOriginal');
      const target: unknown = stored ?? original;
      const sent: unknown = typeof target === 'function' ? Reflect.apply(target, chrome.tabs, [tabId, message, options]) : undefined;
      return sent;
    });
    Reflect.set(chrome.tabs, '__e2eOriginal', original);
  });
  return async () => {
    const live = await ext.worker();
    const raw: unknown = await live.evaluate(() => {
      const list: unknown = Reflect.get(globalThis, '__e2eOutgoing');
      const copy: unknown[] = Array.isArray(list) ? list.slice() : [];
      return copy;
    });
    return SentSchema.parse(raw);
  };
}

/** Service Worker から、タブのページ側へ指示を送る。 */
async function sendToTab(ext: Extension, tabId: number, message: unknown): Promise<void> {
  const worker = await ext.worker();
  await worker.evaluate(
    async ({ tabId, message }) => {
      const original: unknown = Reflect.get(chrome.tabs, '__e2eOriginal') ?? Reflect.get(chrome.tabs, 'sendMessage');
      await Reflect.apply(original instanceof Function ? original : () => undefined, chrome.tabs, [tabId, message, { frameId: 0 }]);
    },
    { tabId, message },
  );
}

const RenderLikeSchema = z.object({ type: z.literal('RENDER'), rev: z.number(), index: z.number() }).loose();

test('E-60: 素早くステップを移動すると表示が最新のステップと一致し、古い描画指示・消去指示を後から届けても壊れない', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = standardTour({ origin: server.origin });
  await importTour(panel, tour);
  const sent = await captureOutgoing(ext);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/4');

  // 続けて「次へ」を押し、最新のステップ（4番目）で、サイドパネル・ページ上・実行状態が一致する
  await sleep(MOVE_WAIT_MS);
  await panel.gotoStep(2);
  await sleep(MOVE_WAIT_MS);
  await panel.gotoStep(3);
  await sleep(MOVE_WAIT_MS);
  await panel.gotoStep(4);
  await expectPanelStep(panel, '4/4');
  await expectMiniGuideStep(ui, '4/4');
  expect((await ui.miniGuide())?.title).toBe('申請する');
  await expect.poll(async () => (await tourState(ext)).stepIndex).toBe(3);

  // 間を置かずに3回移動を送る。受け付けられた最後の移動の先で、3つが一致する（受け付けの絞りは製品の仕様）
  await sleep(MOVE_WAIT_MS);
  await panel.gotoStep(2);
  await panel.gotoStep(3);
  await panel.gotoStep(1);
  await sleep(1500);
  const settled = await tourState(ext);
  const label = `${String(settled.stepIndex + 1)}/4`;
  await expectPanelStep(panel, label);
  await expectMiniGuideStep(ui, label);
  const expectedTitle = (await ui.miniGuide())?.title;
  expect(expectedTitle).toBeDefined();

  // 今と別のステップ（過去の表示）の描画指示と、版 0 の消去指示を、あとから届ける
  const renders = (await sent())
    .map((s) => ({ tabId: s.tabId, parsed: RenderLikeSchema.safeParse(s.message), message: s.message }))
    .filter((s) => s.parsed.success);
  const oldest = renders.find((r) => r.parsed.success && r.parsed.data.index !== settled.stepIndex);
  if (oldest === undefined) throw new Error('今と別のステップの描画指示を控えられなかった');
  await sendToTab(ext, oldest.tabId, oldest.message);
  await sendToTab(ext, oldest.tabId, { type: 'CLEAR', rev: 0 });
  await sleep(700);
  await expectMiniGuideStep(ui, label);
  expect((await ui.miniGuide())?.title).toBe(expectedTitle);
  await expectPanelStep(panel, label);

  // 比較: 新しい版の消去指示は、同じ経路で受け付けられ、表示が消える
  const state = await tourState(ext);
  await sendToTab(ext, oldest.tabId, { type: 'CLEAR', rev: state.rev + 1000 });
  await expect.poll(async () => await ui.miniGuide()).toBeNull();
});

test('E-61: 前のツアーのサイドパネルから送った「終了」「今のタブで開く」が、次のツアーの開始後に届いても作用しない', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tabA = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const tourA = standardTour({ origin: server.origin, id: 'e2e-a', name: 'ツアー A' });
  const tourB = standardTour({ origin: server.origin, id: 'e2e-b', name: 'ツアー B' });
  await importTour(panel, tourA);
  await importTour(panel, tourB);
  await beginTour(panel, tourA.name, tabA);
  const stateA = await tourState(ext);
  await panel.stop();
  await expect(panel.page.getByRole('status').filter({ hasText: 'ツアーを終了しました' })).toBeVisible();

  const tabB = await openTab(server.url('/internal/?b=1'));
  await beginTour(panel, tourB.name, tabB);
  await expectPanelStep(panel, '1/4');
  const stateB = await tourState(ext);
  expect(stateB.sessionId).not.toBe(stateA.sessionId);
  const tabs = await tabCount(ext);

  // 古い画面に残っていた操作（ツアー A の実行回の識別子）が、いま届く
  const stop = await sendFromPanel(panel, { type: 'STOP', sessionId: stateA.sessionId, opId: 'stale-stop-op' });
  expect(discardReason(stop)).toBe('staleSession');
  const open = await sendFromPanel(panel, {
    type: 'OPEN_IN',
    mode: 'current',
    sessionId: stateA.sessionId,
    gen: stateA.gen,
    opId: 'stale-open-op',
  });
  expect(discardReason(open)).toBe('staleSession');

  // ツアー B は続いていて、タブも変わらない
  await sleep(500);
  const after = await tourState(ext);
  expect(after.status).toBe('running');
  expect(after.sessionId).toBe(stateB.sessionId);
  await expectPanelStep(panel, '1/4');
  await expectMiniGuideStep(ownUi(tabB), '1/4');
  expect(await tabCount(ext)).toBe(tabs);
  expect(tabB.url()).toBe(server.url('/internal/?b=1'));
});

interface Overwriting {
  panel: SidePanel;
  other: SidePanel;
  tab: Page;
  tour: TourSpec;
}

/**
 * 実行中のツアーを、同じ ID の新版で上書きする。
 * 実行中のサイドパネルには取り込み画面が無いので、別のサイドパネルで先に確認の画面を出しておき、実行を始めてから承認する。
 */
async function overwriteWhileRunning(
  ctx: {
    ext: Extension;
    server: { origin: string; altOrigin: string; url: (path: string) => string };
    openTab: (url: string) => Promise<Page>;
    openPanel: () => Promise<SidePanel>;
  },
  makeNewVersion: (old: TourSpec) => TourSpec,
  stepsToAdvance = 2,
): Promise<Overwriting> {
  const tab = await ctx.openTab(ctx.server.url('/internal/'));
  const panel = await ctx.openPanel();
  const tour = standardTour({ origin: ctx.server.origin, id: 'e2e-rev', name: '改訂するツアー' });
  await importTour(panel, tour);
  const other = await ctx.openPanel();
  await other.page.getByRole('button', { name: '再読み込み' }).click();
  await other.importFiles([yamlFile(makeNewVersion(tour))]);
  await expect(other.page.getByRole('alertdialog')).toContainText(`ID「${tour.id}」`);

  await beginTour(panel, tour.name, tab);
  for (let i = 0; i < stepsToAdvance; i++) {
    await sleep(MOVE_WAIT_MS);
    await panel.next();
    await expectPanelStep(panel, `${String(i + 2)}/4`);
  }
  await expectMiniGuideStep(ownUi(tab), `${String(stepsToAdvance + 1)}/4`);

  await other.confirm();
  return { panel, other, tab, tour };
}

function renamed(old: TourSpec): TourSpec {
  return { ...old, name: '改訂したツアー', steps: old.steps.map((s) => ({ ...s, title: `新版 ${s.title}` })) };
}

test('E-62: 実行中に同じ ID で別の内容のツアーを上書きすると、実行中のツアーは一時中断され、3つの選択肢が出る', async ({ ext, server, openTab, openPanel }) => {
  const { panel, tab } = await overwriteWhileRunning({ ext, server, openTab, openPanel }, renamed);
  await expect(panel.page.locator('.screen-paused')).toBeVisible();
  await expect(panel.page.locator('.screen-paused .notice')).toContainText('上書きされたため、一時中断しました');
  await expect(panel.page.getByRole('button', { name: '新版で続きから' })).toBeVisible();
  await expect(panel.page.getByRole('button', { name: '新版で最初から' })).toBeVisible();
  await expect(panel.page.getByRole('button', { name: '終了', exact: true })).toBeVisible();
  // 勝手に新版へ切り替わらず、ページ上の表示は消える
  await expectNoOwnUi(ownUi(tab));
  expect((await tourState(ext)).status).toBe('paused');
});

test('E-62: origins が増える新版では、再開の前にサイトの許可の確認が出る（許可のダイアログ自体は手動で補う）', async ({ ext, server, openTab, openPanel }) => {
  await spyPermissionRequests(ext.context);
  const { panel } = await overwriteWhileRunning({ ext, server, openTab, openPanel }, (old) => ({
    ...renamed(old),
    origins: [...old.origins, server.altOrigin],
  }));
  await expect(panel.page.locator('.screen-paused')).toBeVisible();
  expect(JSON.stringify(await permissionRequests(panel.page))).not.toContain('127.0.0.1');
  await panel.press(panel.page.getByRole('button', { name: '新版で続きから' }));
  // 増えたサイトへの許可が求められる。ダイアログは操作できないので、求めた中身だけを確かめる
  await expect
    .poll(async () => JSON.stringify(await permissionRequests(panel.page)))
    .toContain('http://127.0.0.1/*');
  // テスト用の manifest で許可済みのサイトなので、確認はそのまま通り、新版で再開する
  await expect(panel.page.locator('.screen-running')).toBeVisible();
});

test('E-63: 「新版で続きから」を選ぶと、同じ stepId のステップから新版で再開する', async ({ ext, server, openTab, openPanel }) => {
  const { panel, tab } = await overwriteWhileRunning({ ext, server, openTab, openPanel }, renamed);
  await panel.press(panel.page.getByRole('button', { name: '新版で続きから' }));
  await expect(panel.page.locator('.screen-running')).toBeVisible();
  await expectPanelStep(panel, '3/4');
  await expectMiniGuideStep(ownUi(tab), '3/4');
  expect((await ownUi(tab).miniGuide())?.title).toBe('新版 規約に同意する');
  expect((await tourState(ext)).stepId).toBe('s3');
});

test('E-63: 「新版で続きから」を選んでも、新版に同じ stepId が無ければ、最初のステップから始まる', async ({ ext, server, openTab, openPanel }) => {
  const { panel, tab } = await overwriteWhileRunning({ ext, server, openTab, openPanel }, (old) => ({
    ...renamed(old),
    steps: old.steps.map((s) => (s.id === 's3' ? { ...s, id: 's3-renamed' } : s)),
  }));
  await panel.press(panel.page.getByRole('button', { name: '新版で続きから' }));
  await expect(panel.page.locator('.screen-running')).toBeVisible();
  await expectPanelStep(panel, '1/4');
  await expectMiniGuideStep(ownUi(tab), '1/4');
  expect((await tourState(ext)).stepId).toBe('s1');
});

test('E-63: 「新版で最初から」を選ぶと、新版を最初のステップから始める', async ({ ext, server, openTab, openPanel }) => {
  const { panel, tab } = await overwriteWhileRunning({ ext, server, openTab, openPanel }, renamed);
  await panel.press(panel.page.getByRole('button', { name: '新版で最初から' }));
  await expect(panel.page.locator('.screen-running')).toBeVisible();
  await expectPanelStep(panel, '1/4');
  await expectMiniGuideStep(ownUi(tab), '1/4');
  expect((await ownUi(tab).miniGuide())?.title).toBe('新版 申請者名を入力する');
});

test('E-63: 「終了」を選ぶと、ツアーが終了して進捗が破棄される', async ({ ext, server, openTab, openPanel }) => {
  const { panel, tab, tour } = await overwriteWhileRunning({ ext, server, openTab, openPanel }, renamed);
  await panel.stop();
  await expect(panel.page.getByRole('status').filter({ hasText: 'ツアーを終了しました' })).toBeVisible();
  await expectNoOwnUi(ownUi(tab));
  expect(await hasProgress(ext, tour.id)).toBe(false);
  await expect(panel.card('改訂したツアー').getByRole('button', { name: '続きから' })).toHaveCount(0);
});

test('E-64: 実行中のツアー（取り込み済み）を削除すると、ツアーが終了し、ページ上の表示・ミニガイド・進捗が消える', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const tour = standardTour({ origin: server.origin });
  await importTour(panel, tour);
  // 実行中のサイドパネルには一覧が無いので、別のサイドパネルで削除の確認を出しておく
  const other = await openPanel();
  await other.page.getByRole('button', { name: '再読み込み' }).click();
  await other.press(other.card(tour.name).getByRole('button', { name: '削除' }));
  await expect(other.page.getByRole('alertdialog')).toBeVisible();

  await beginTour(panel, tour.name, tab);
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '2/4');
  await expect.poll(() => hasProgress(ext, tour.id)).toBe(true);

  await other.confirm();
  await expect(panel.page.locator('.screen-running')).toHaveCount(0);
  await expect(panel.page.getByRole('status').filter({ hasText: '実行中のツアーが削除されたため、終了しました' })).toBeVisible();
  await expectNoOwnUi(ownUi(tab));
  expect(await hasProgress(ext, tour.id)).toBe(false);
  expect((await tourState(ext)).status).toBe('ended');
});

test('E-65: 実行中に Service Worker を止めてから操作しても、ツアーは続き、表示の二重化もステップの二重移動も起きない', async ({
  ext,
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
  const hosts = await ui.hostCount();
  expect(hosts).toBeGreaterThan(0);

  // ステップごとに、止めてから「次へ」を押す。サイドパネルとミニガイドのどちらの「次へ」でも確かめる
  for (const [index, via] of (['panel', 'miniguide', 'panel'] as const).entries()) {
    await sleep(MOVE_WAIT_MS);
    await ext.stopWorker();
    if (via === 'panel') await panel.next();
    else await ui.clickButton('次へ');
    const label = `${String(index + 2)}/4`;
    await expectPanelStep(panel, label);
    await expectMiniGuideStep(ui, label);
    // 二重に進んでいないことを、少し待って確かめる
    await sleep(700);
    await expectPanelStep(panel, label);
    expect((await ui.miniGuide())?.step).toBe(label);
    expect(await ui.hostCount()).toBe(hosts);
    expect((await tourState(ext)).stepIndex).toBe(index + 1);
  }

  // 止めたあと、完了の目安の判定も続いている
  await sleep(MOVE_WAIT_MS);
  await panel.gotoStep(1);
  await expectMiniGuideStep(ui, '1/4');
  await ext.stopWorker();
  await tab.getByLabel('申請者名').fill('山田 太郎');
  await expect(panel.hintText()).toContainText('次へ進めます');
  expect(await ui.hostCount()).toBe(hosts);
});

/** 表示中のステップ番号（サイドパネルの表示）を読む。無ければ null。 */
async function shownStep(panel: SidePanel): Promise<number | null> {
  const text = await panel.stepBadge().textContent({ timeout: 1000 }).catch(() => null);
  const match = /^(\d+)\//.exec(text ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
}

test('E-66: 移動の保存の途中で Service Worker を止めて復帰させても、利用者に見せたステップから巻き戻らず、表示と保存が食い違わない', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  test.setTimeout(180_000);
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = standardTour({ origin: server.origin });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/4');

  let current = 1;
  for (let round = 0; round < 16; round++) {
    // 止めるタイミングを毎回ずらす（0〜60 ミリ秒）
    const target = current === 4 ? 2 : current + 1;
    await sleep(MOVE_WAIT_MS);
    await panel.gotoStep(target);
    await sleep((round * 7) % 61);
    const shown = await shownStep(panel);
    await ext.stopWorker();
    await ext.worker();

    // 復帰後の状態: 見せたステップから巻き戻らず、保存と表示がそろう
    const state = await tourState(ext);
    expect(state.status).toBe('running');
    expect([current, target]).toContain(state.stepIndex + 1);
    if (shown === target) expect(state.stepIndex + 1).toBe(target);
    await expect.poll(async () => (await ui.miniGuide())?.step).toBe(`${String(state.stepIndex + 1)}/4`);
    await panel.page.reload();
    await expectPanelStep(panel, `${String(state.stepIndex + 1)}/4`);
    if (shown === target) {
      const progress = z.record(z.string(), z.object({ stepIndex: z.number() })).parse(await ext.storageLocal('progress'));
      expect(progress[tour.id]?.stepIndex).toBe(target - 1);
    }
    current = state.stepIndex + 1;
  }
});

test('E-66: 完了・終了の保存の途中で Service Worker を止めて復帰させても、終了・完了したツアーの進捗が復活しない', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  test.setTimeout(240_000);
  const panel = await openPanel();
  const tour = standardTour({ origin: server.origin, steps: 2 });
  await importTour(panel, tour);

  let ended = 0;
  for (let round = 0; round < 12; round++) {
    const how = round % 2 === 0 ? 'stop' : 'complete';
    const tab = await openTab(server.url('/internal/'));
    await beginTour(panel, tour.name, tab);
    await sleep(MOVE_WAIT_MS);
    await panel.next();
    await expectPanelStep(panel, '2/2');
    await expect.poll(() => hasProgress(ext, tour.id)).toBe(true);

    if (how === 'stop') await panel.stop();
    else await panel.press(panel.page.getByRole('button', { name: '完了', exact: true }));
    await sleep((round * 11) % 61);
    await ext.stopWorker();
    await ext.worker();

    // 復帰後: 終了・完了が受け付けられていれば、進捗は復活しない（削除が打ち切られていても、起動時にやり直される）。
    // 受け付けられる前に止まっていれば、操作は無かったことになり、実行中のまま進捗が残る（一貫している）
    await sleep(800);
    const status = (await tourState(ext)).status;
    if (status === 'running') {
      expect(await hasProgress(ext, tour.id)).toBe(true);
      await panel.page.reload();
      await panel.stop();
      await expect.poll(() => hasProgress(ext, tour.id)).toBe(false);
    } else {
      ended += 1;
      expect(status).toBe('ended');
      await expect
        .poll(() => hasProgress(ext, tour.id), { timeout: 15_000, message: `round ${String(round)} (${how}) 進捗が残った` })
        .toBe(false);
      await expectNoOwnUi(ownUi(tab), 300);
    }
    await panel.page.reload();
    await expect(panel.card(tour.name).getByRole('button', { name: '最初から', exact: true })).toBeVisible();
    await expect(panel.card(tour.name).getByRole('button', { name: '続きから' })).toHaveCount(0);
    await tab.close();
  }
  // 終了・完了が受け付けられた回が、少なくとも半分ある（検査が空振りでないこと）
  expect(ended).toBeGreaterThanOrEqual(6);
});

/** `storage.session` を、次の書き込みが容量を超えるところまで埋める。残りの空き（バイト）を返す。 */
async function fillSessionStorage(ext: Extension): Promise<number> {
  const worker = await ext.worker();
  return worker.evaluate(async (): Promise<number> => {
    const quota = chrome.storage.session.QUOTA_BYTES;
    const used = await chrome.storage.session.getBytesInUse(null);
    // 数え方（鍵・引用符の分）が分からないので、入る最大の大きさを、余りを増やしながら探す
    for (let slack = 0; slack < 200; slack++) {
      try {
        await chrome.storage.session.set({ e2eJunk: 'x'.repeat(quota - used - slack) });
        return quota - (await chrome.storage.session.getBytesInUse(null));
      } catch {
        // 大きすぎた。少し小さくして試す
      }
    }
    throw new Error('storage.session を埋められなかった');
  });
}

test('E-67: 実行状態の保存に失敗した状態でステップを移っても操作は続けられ、「保存されていません」が表示される（進捗の保存の失敗は手動で補う）', async ({
  ext,
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
  await expect(panel.page.getByText('保存されていません')).toHaveCount(0);

  // 実行状態の領域（storage.session）が満杯になり、次の書き込みが失敗する
  expect(await fillSessionStorage(ext)).toBeLessThan(30);
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '2/4');
  await expectMiniGuideStep(ui, '2/4');
  await expect(panel.page.getByText('保存されていません。再起動すると前の位置に戻る可能性があります')).toBeVisible();
  // 操作は続けられる
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '3/4');
  await expectMiniGuideStep(ui, '3/4');

  // 領域に空きができると、次の確定で保存でき、表示が消える
  const worker = await ext.worker();
  await worker.evaluate(() => chrome.storage.session.remove('e2eJunk'));
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '4/4');
  await expect(panel.page.getByText('保存されていません')).toHaveCount(0);
});

test('E-68: 完了・終了は表示され、進捗が残らず、再起動しても「続きから」は出ない（進捗の削除の失敗は手動で補う）', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const panel = await openPanel();
  const tour = standardTour({ origin: server.origin, steps: 1 });
  await importTour(panel, tour);
  for (const how of ['complete', 'stop'] as const) {
    const tab = await openTab(server.url('/internal/'));
    await beginTour(panel, tour.name, tab);
    await expect.poll(() => hasProgress(ext, tour.id)).toBe(true);
    if (how === 'complete') {
      await panel.press(panel.page.getByRole('button', { name: '完了', exact: true }));
      await expect(panel.page.getByRole('status').filter({ hasText: '完了しました' })).toBeVisible();
    } else {
      await panel.stop();
      await expect(panel.page.getByRole('status').filter({ hasText: 'ツアーを終了しました' })).toBeVisible();
    }
    await expect.poll(() => hasProgress(ext, tour.id)).toBe(false);
    await tab.close();
  }

  const restarted = await ext.restart();
  const panel2 = await openPanelOf(restarted);
  await expect(panel2.card(tour.name)).toBeVisible();
  await expect(panel2.card(tour.name).getByRole('button', { name: '続きから' })).toHaveCount(0);
  expect(await hasProgress(restarted, tour.id)).toBe(false);
});
