/**
 * ミニガイド（AC-28〜33）の E2E。最小化・ホバー・幅の保持・ページのスクリプトからの操作・吹き出しとの重なり・表示を戻す操作。
 * 使う補助は support/ の先頭の説明を参照する。
 */
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { test, expect, ownUi, importTour, beginTour } from './support/fixtures.ts';
import { expectMiniGuideStep, expectPanelStep, sleep } from './support/flows.ts';
import { openPanel as openPanelOf } from './support/panel.ts';
import { tourOn } from './support/tour.ts';
import type { StepSpec, TourSpec } from './support/tour.ts';

const UI_WIDTH_MIN = 240;
const UI_WIDTH_MAX = 560;
const BAR_WIDTH = 28;

/** P-A（`/static`）で、ボタンを対象にするステップを `count` 個持つツアー。最初のステップは入力欄が埋まると目安を満たす。 */
function staticTour(origin: string, count = 2, options: { id?: string; name?: string } = {}): TourSpec {
  const steps: StepSpec[] = [];
  for (let i = 1; i <= count; i++) {
    steps.push({
      id: `s${String(i)}`,
      title: `${String(i)}番目の確認`,
      target: { tourId: 'static-button' },
      ...(i === 1
        ? {
            done: {
              type: 'state',
              state: 'filled',
              target: { tourId: 'static-input' },
              hint: '名前を入力してください',
              doneHint: '入力できました',
            },
          }
        : {}),
    });
  }
  return tourOn(origin, { exact: '/static' }, steps, options);
}

test('E-28: ミニガイドを最小化すると右端にバー（ステップ番号と目安の状態）だけが残り、バーのクリックで展開する', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = staticTour(server.origin);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/2');
  expect((await ui.miniGuide())?.state).toBe('expanded');

  // 最小化: 幅 28px のバーだけが残り、ステップ番号が出る。目安はまだ満たしていない
  await ui.clickButton('最小化');
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('bar');
  const bar = await ui.miniGuide();
  expect(bar?.mode).toBe('minimized');
  expect(bar?.width).toBe(BAR_WIDTH);
  expect(bar?.step).toBe('1/2');
  expect(bar?.buttons).toEqual([]);
  // 枠線の分を含めても、細いバーのままである
  expect(bar?.rect.width ?? 0).toBeLessThanOrEqual(BAR_WIDTH + 2);
  // 画面の右端にある
  const viewport = tab.viewportSize();
  expect((bar?.rect.x ?? 0) + (bar?.rect.width ?? 0)).toBeGreaterThanOrEqual((viewport?.width ?? 0) - 1);
  expect((await ui.node('.panel .bar .mark'))?.attrs['data-kind']).toBe('unmet');

  // 目安を満たすと、バーに満たした印が出る
  await tab.getByLabel('名前').fill('山田');
  await expect.poll(async () => (await ui.node('.panel .bar .mark'))?.text).toBe('✓');
  expect((await ui.miniGuide())?.state).toBe('bar');

  // バーのクリックで展開する（設定も展開になる）
  await ui.click('.panel .bar');
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('expanded');
  const opened = await ui.miniGuide();
  expect(opened?.mode).toBe('expanded');
  expect(opened?.step).toBe('1/2');
  expect(opened?.buttons).toContain('次へ');
});

test('E-29: ホバーにすると、マウスを乗せている間だけ展開する', async ({ server, openTab, openPanel }) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = staticTour(server.origin);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/2');

  await ui.clickButton('ホバー');
  await ui.moveAway();
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('bar');
  expect((await ui.miniGuide())?.mode).toBe('hover');

  // 乗せている間は展開している
  await ui.hover('.panel .bar');
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('expanded');
  expect((await ui.miniGuide())?.mode).toBe('hover');
  await sleep(600);
  expect((await ui.miniGuide())?.state).toBe('expanded');

  // 外すとバーに戻る
  await ui.moveAway();
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('bar');
  expect((await ui.miniGuide())?.mode).toBe('hover');
});

test('E-29: ホバーにしたミニガイドは、キーボードでフォーカスしている間だけ展開する', async ({ server, openTab, openPanel }) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = staticTour(server.origin);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/2');
  await ui.clickButton('ホバー');
  await ui.moveAway();
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('bar');

  // Tab キーでバーへフォーカスすると展開する（展開するとフォーカスは幅のつまみへ移る）
  await tab.locator('body').click({ position: { x: 5, y: 5 } });
  await ui.tabTo(/^(ガイドを開く|ミニガイドの幅)/);
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('expanded');
  await sleep(600);
  expect((await ui.miniGuide())?.state).toBe('expanded');

  // フォーカスが外れるとバーに戻る
  await tab.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await expect.poll(async () => (await ui.focused()) === null).toBe(true);
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('bar');
  expect((await ui.miniGuide())?.mode).toBe('hover');
});

/** ハンドルをつかんで `dx` だけ横へ動かして離す（実際のマウス）。 */
async function dragHandle(page: Page, dx: number): Promise<void> {
  const ui = ownUi(page);
  const handle = await ui.node('.panel .handle');
  if (handle === null) throw new Error('幅のつまみが無い');
  const x = handle.rect.x + handle.rect.width / 2;
  const y = handle.rect.y + handle.rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 3 });
  await page.mouse.move(x + dx, y, { steps: 3 });
  await page.mouse.up();
  await page.mouse.move(2, 2);
}

test('E-30: 幅をドラッグとキーボードで変えると、最小値・最大値の範囲に収まる', async ({ server, openTab, openPanel }) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = staticTour(server.origin);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/2');
  const initial = (await ui.miniGuide())?.width ?? 0;
  expect(initial).toBeGreaterThanOrEqual(UI_WIDTH_MIN);
  expect(initial).toBeLessThanOrEqual(UI_WIDTH_MAX);

  // 左へ動かすと広がる（範囲の中）
  const target = Math.min(UI_WIDTH_MAX - 40, initial + 80);
  await dragHandle(tab, -(target - initial));
  await expect.poll(async () => (await ui.miniGuide())?.width).toBe(target);

  // 最大値より大きく広げようとしても、最大値で止まる
  await dragHandle(tab, -2000);
  await expect.poll(async () => (await ui.miniGuide())?.width).toBe(UI_WIDTH_MAX);
  // 最小値より小さく狭めようとしても、最小値で止まる
  await dragHandle(tab, 2000);
  await expect.poll(async () => (await ui.miniGuide())?.width).toBe(UI_WIDTH_MIN);

  // キーボード（左キーで広がる、右キーで狭まる）でも範囲に収まる
  await ui.focus('.panel .handle');
  await tab.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await ui.miniGuide())?.width).toBe(UI_WIDTH_MIN + 16);
  await tab.keyboard.press('ArrowRight');
  await tab.keyboard.press('ArrowRight');
  await expect.poll(async () => (await ui.miniGuide())?.width).toBe(UI_WIDTH_MIN);
  for (let i = 0; i < 30; i++) await tab.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await ui.miniGuide())?.width).toBe(UI_WIDTH_MAX);
});

test('E-30: 変えた幅と表示状態は、別のツアーを開始しても保たれる', async ({ server, openTab, openPanel }) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const first = staticTour(server.origin, 1, { id: 'e2e-first', name: '最初のツアー' });
  const second = staticTour(server.origin, 1, { id: 'e2e-second', name: '次のツアー' });
  await importTour(panel, first);
  await importTour(panel, second);
  await beginTour(panel, first.name, tab);
  await expectMiniGuideStep(ui, '1/1');
  await dragHandle(tab, -100);
  await expect.poll(async () => (await ui.miniGuide())?.width).toBeGreaterThan(UI_WIDTH_MIN + 60);
  const width = (await ui.miniGuide())?.width ?? 0;
  await ui.clickButton('ホバー');
  await expect.poll(async () => (await ui.miniGuide())?.mode).toBe('hover');
  // 設定の保存を待つ
  await sleep(500);

  // ツアーを終了して、同じタブで別のツアーを始める
  await panel.stop();
  await expect(panel.card(second.name)).toBeVisible();
  await beginTour(panel, second.name, tab);
  await expectMiniGuideStep(ui, '1/1');
  const next = await ui.miniGuide();
  expect(next?.mode).toBe('hover');
  // 幅は、展開したときの幅（バーのときは 28）
  await ui.hover('.panel .bar');
  await expect.poll(async () => (await ui.miniGuide())?.width).toBe(width);
});

test('E-30: 変えた幅と表示状態は、ブラウザを再起動しても保たれる', async ({ ext, server, openTab, openPanel }) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = staticTour(server.origin);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/2');
  await dragHandle(tab, -90);
  await expect.poll(async () => (await ui.miniGuide())?.width).toBeGreaterThan(UI_WIDTH_MIN + 50);
  const width = (await ui.miniGuide())?.width ?? 0;
  await ui.clickButton('ホバー');
  await expect.poll(async () => (await ui.miniGuide())?.mode).toBe('hover');
  await sleep(500);

  const restarted = await ext.restart();
  const tab2 = await restarted.openTab(server.url('/static'));
  const panel2 = await openPanelOf(restarted);
  await panel2.start(tour.name);
  await panel2.useTab();
  await expect(panel2.page.locator('.screen-running')).toBeVisible();
  const ui2 = ownUi(tab2);
  await expectMiniGuideStep(ui2, '1/2');
  expect((await ui2.miniGuide())?.mode).toBe('hover');
  await ui2.hover('.panel .bar');
  await expect.poll(async () => (await ui2.miniGuide())?.width).toBe(width);
});

const NodeListSchema = z.object({
  nodes: z.array(
    z.object({
      nodeId: z.number(),
      nodeName: z.string(),
      nodeValue: z.string().optional(),
      parentId: z.number().optional(),
    }),
  ),
});

/**
 * ページのスクリプトが行うのと同じ、信頼されない（`isTrusted` が偽の）クリックを、ミニガイドのボタンへ発生させる。
 * ミニガイドは閉じた Shadow DOM の中にあり、ページのスクリプトは要素を取れない。
 * そこで CDP でボタンの参照を取り、ページの JavaScript の世界で `dispatchEvent` と `click()` を呼ぶ（検査用の経路）。
 */
async function scriptedClicks(page: Page, label: string): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    const flat = NodeListSchema.parse(await cdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true }));
    const byId = new Map(flat.nodes.map((n) => [n.nodeId, n]));
    const labelNode = flat.nodes.find(
      (n) => n.nodeName === '#text' && n.nodeValue?.trim() === label && byId.get(n.parentId ?? -1)?.nodeName === 'BUTTON',
    );
    const button = byId.get(labelNode?.parentId ?? -1);
    if (button === undefined) return false;
    const resolved = z
      .object({ object: z.object({ objectId: z.string() }) })
      .parse(await cdp.send('DOM.resolveNode', { nodeId: button.nodeId }));
    await cdp.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: `function () {
        this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
        this.click();
      }`,
    });
    return true;
  } finally {
    await cdp.detach();
  }
}

test('E-31: ページのスクリプトからミニガイドの「次へ」へ送ったクリックではステップが動かず、実際のクリックでは動く', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = staticTour(server.origin, 3);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/3');

  // ページ側からは、ホスト要素の Shadow DOM の中を取れない（closed）
  const reachable = await tab.evaluate(() => {
    const host = document.querySelector('[data-guided-tour-host]');
    return host === null ? 'no-host' : host.shadowRoot === null ? 'closed' : 'open';
  });
  expect(reachable).toBe('closed');

  expect(await scriptedClicks(tab, '次へ')).toBe(true);
  await sleep(1500);
  await expectPanelStep(panel, '1/3');
  expect((await ui.miniGuide())?.step).toBe('1/3');

  // 実際のクリックでは移動する
  await ui.clickButton('次へ');
  await expectPanelStep(panel, '2/3');
  await expectMiniGuideStep(ui, '2/3');
});

/** P-O（`/right-edge`）の右端のボタンを対象にするツアー。 */
function edgeTour(origin: string): TourSpec {
  return tourOn(
    origin,
    { exact: '/right-edge' },
    [{ id: 'edge', title: '右端のボタン', tip: '右端にあります', target: { tourId: 'edge-button' } }],
    { id: 'e2e-edge', name: '右端のツアー' },
  );
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 900, height: 600 },
  { width: 700, height: 800 },
]) {
  test(`E-32: 対象が画面の右端にあっても、吹き出しはミニガイドと重ならない（${String(viewport.width)}x${String(viewport.height)}）`, async ({
    server,
    openTab,
    openPanel,
  }) => {
    const tab = await openTab(server.url('/right-edge'));
    await tab.setViewportSize(viewport);
    const panel = await openPanel();
    const ui = ownUi(tab);
    const tour = edgeTour(server.origin);
    await importTour(panel, tour);
    await beginTour(panel, tour.name, tab);
    await expect.poll(async () => (await ui.overlay())?.bubble ?? null).not.toBeNull();
    await expectMiniGuideStep(ui, '1/1');

    // 展開しているとき、最小化したときの両方で、重ならない
    for (const minimized of [false, true]) {
      if (minimized) await ui.clickButton('最小化');
      // 幅の変化を受けた吹き出しの置き直しを待つ
      await sleep(600);
      const bubble = (await ui.overlay())?.bubble?.rect;
      const mini = await ui.miniGuide();
      if (bubble === undefined || mini === null) throw new Error('吹き出しかミニガイドが出ていない');
      expect(bubble.width).toBeGreaterThan(0);
      expect(mini.rect.width).toBeGreaterThan(0);
      expect(mini.state).toBe(minimized ? 'bar' : 'expanded');
      expect(intersects(bubble, mini.rect)).toBe(false);
      // 吹き出しは画面の中にある
      expect(bubble.x + bubble.width).toBeLessThanOrEqual(viewport.width);
    }
  });
}

test('E-33: ミニガイドを最小化したまま吹き出しの × を押し、「表示を戻す」を押すと、ハイライトと吹き出しだけが戻る', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = staticTour(server.origin);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/2');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();

  await ui.clickButton('最小化');
  await expect.poll(async () => (await ui.miniGuide())?.state).toBe('bar');

  // × で消す。ミニガイドは最小化のまま
  await ui.click('.bubble .close');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).toBeNull();
  expect((await ui.overlay())?.bubble ?? null).toBeNull();
  expect((await ui.miniGuide())?.state).toBe('bar');
  expect((await ui.miniGuide())?.mode).toBe('minimized');

  // 「表示を戻す」（サイドパネル）で、ハイライトと吹き出しだけが戻る
  await panel.press(panel.page.getByRole('button', { name: '表示を戻す' }));
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  expect((await ui.overlay())?.bubble).not.toBeNull();
  const mini = await ui.miniGuide();
  expect(mini?.state).toBe('bar');
  expect(mini?.mode).toBe('minimized');
  expect(mini?.width).toBe(BAR_WIDTH);
});
