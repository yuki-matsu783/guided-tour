/**
 * 自己紹介ツアー（同梱）の E2E（E-83〜86）。ツアーは拡張機能に同梱のもの（`public/tours/guided-setup-tour-intro`）を使い、
 * 体験の舞台の `https://example.com/` は support/example-com.ts が模擬する。
 */
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { test, expect, ownUi } from './support/fixtures.ts';
import { routeExampleCom } from './support/example-com.ts';
import { expectMiniGuideStep, expectNoOwnUi, expectPanelStep, hasProgress, sleep, tabCount } from './support/flows.ts';
import type { SidePanel } from './support/panel.ts';

const TOUR_NAME = 'Guided Setup Tour の使い方';
const TOUR_ID = 'guided-setup-tour-intro';
const EXAMPLE = 'https://example.com/';

/** ページの手順（2〜7）と案内だけの手順（1・8〜12）の ID 順。`public/tours/<id>/tour.yaml` の順序。 */
const STEP_COUNT = 12;
const PAGE_STEPS = [2, 3, 4, 5, 6, 7];

function examplePages(page: Page): Page[] {
  return page.context().pages().filter((p) => p.url().startsWith(EXAMPLE));
}

test('E-83: 導入した直後に、自己紹介ツアーが「同梱」の出所つきで一覧に出て、削除の操作は出ない', async ({
  openPanel,
}) => {
  const panel = await openPanel();
  const card = panel.card(TOUR_NAME);
  await expect(card).toBeVisible();
  await expect(card.locator('.badge-bundled')).toHaveText('同梱');
  await expect(card).toContainText('操作しながら 10 分ほどで学びます');
  await expect(card.locator('.facts')).toContainText(`ステップ数${String(STEP_COUNT)}`);
  await expect(card.locator('.facts')).toContainText('対象サイトhttps://example.com');
  await expect(card.getByRole('button', { name: '削除' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '最初から', exact: true })).toBeVisible();

  // 同梱のツアーが複数あるときは、すべて一覧に出る（同梱の一覧 tours/index.json と一致する）
  const index = z
    .object({ tours: z.array(z.string()) })
    .parse(await panel.page.evaluate(async (): Promise<unknown> => (await fetch('tours/index.json')).json()));
  expect(index.tours).toContain(TOUR_ID);
  await expect(panel.page.locator('li.tour-card')).toHaveCount(index.tours.length);
  await expect(panel.page.locator('li.tour-card .badge-bundled')).toHaveCount(index.tours.length);
});

/** 自己紹介ツアーを開始し、案内だけの最初の手順から「次へ」で、ページの手順（2 番目）まで進める。 */
async function startIntroToStep2(panel: SidePanel): Promise<void> {
  await panel.start(TOUR_NAME);
  await expect(panel.page.locator('.screen-running')).toBeVisible();
  await expectPanelStep(panel, `1/${String(STEP_COUNT)}`);
  await panel.next();
  await expectPanelStep(panel, `2/${String(STEP_COUNT)}`);
}

test('E-84: 案内だけの最初の手順ではページに何も出ずタブも開かず、ページの手順で「今のタブで開く」を押したときだけ開く', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  await routeExampleCom(ext.context);
  const current = await openTab(server.url('/static'));
  const panel = await openPanel();
  const before = await tabCount(ext);

  // 最初の案内だけの手順: ページ上に何も出ず、タブも開かれない
  await panel.start(TOUR_NAME);
  await expectPanelStep(panel, `1/${String(STEP_COUNT)}`);
  await expect(panel.page.locator('.step-body .notice')).toContainText('ブラウザの外などで行う手順です');
  await sleep(1500);
  await expectNoOwnUi(ownUi(current));
  expect(await tabCount(ext)).toBe(before);
  expect(examplePages(current)).toHaveLength(0);

  // ページの手順に入っても、自動ではタブを開かない（手段を示すだけ）
  await panel.next();
  await expectPanelStep(panel, `2/${String(STEP_COUNT)}`);
  await expect(panel.page.locator('.tab-controls .notice')).toContainText('タブがありません');
  await sleep(1500);
  expect(await tabCount(ext)).toBe(before);
  expect(examplePages(current)).toHaveLength(0);

  // 「今のタブで開く」を押したときだけ、今のタブが example.com を開く。ミニガイドが出る
  await panel.openHere();
  await current.waitForURL(EXAMPLE);
  await expectMiniGuideStep(ownUi(current), `2/${String(STEP_COUNT)}`);
  expect(await tabCount(ext)).toBe(before);
  await expect(panel.hintText()).toContainText('開けました。次へ進めます');
});

test('E-84: 「新しいタブで開く」を押したときだけ、新しいタブで開き、ミニガイドが出る', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  await routeExampleCom(ext.context);
  const current = await openTab(server.url('/static'));
  const panel = await openPanel();
  const before = await tabCount(ext);
  await startIntroToStep2(panel);
  expect(await tabCount(ext)).toBe(before);

  const [created] = await Promise.all([ext.context.waitForEvent('page'), panel.openNew()]);
  await created.waitForURL(EXAMPLE);
  await expectMiniGuideStep(ownUi(created), `2/${String(STEP_COUNT)}`);
  expect(await tabCount(ext)).toBe(before + 1);
  // もとのタブは、そのまま
  expect(current.url()).toBe(server.url('/static'));
});

test('E-84: 既存の example.com のタブを選ぶと、そのタブに対応付けられ、ミニガイドが出る', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  await routeExampleCom(ext.context);
  const existing = await openTab(EXAMPLE);
  const other = await openTab(server.url('/static'));
  const panel = await openPanel();
  const before = await tabCount(ext);
  await startIntroToStep2(panel);

  await expect(panel.page.getByRole('button', { name: /「Example Domain」を「練習用のページ（example.com）」として使う/ })).toBeVisible();
  await expectNoOwnUi(ownUi(existing));
  await panel.useTab(/「Example Domain」を「練習用のページ（example.com）」として使う/);
  await expectMiniGuideStep(ownUi(existing), `2/${String(STEP_COUNT)}`);
  expect(await tabCount(ext)).toBe(before);
  expect(other.url()).toBe(server.url('/static'));
});

/** 開いた example.com のタブ。`stepNo`（1 始まり）のページ上の表示を確かめる補助。 */
async function expectPageStep(panel: SidePanel, page: Page, stepNo: number): Promise<void> {
  const ui = ownUi(page);
  await expectPanelStep(panel, `${String(stepNo)}/${String(STEP_COUNT)}`);
  if (PAGE_STEPS.includes(stepNo)) {
    await expectMiniGuideStep(ui, `${String(stepNo)}/${String(STEP_COUNT)}`);
  } else {
    // 案内だけの手順（サイドパネルの説明）の間は、ページ上に何も出ない
    await expectNoOwnUi(ui, 500);
  }
}

test('E-85: 自己紹介ツアーを最初から最後まで「次へ」で進め、「完了」で完了が表示されて進捗が破棄される', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  test.setTimeout(120_000);
  await routeExampleCom(ext.context);
  const current = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(current);
  await startIntroToStep2(panel);
  await panel.openHere();
  await current.waitForURL(EXAMPLE);

  // 2: ページを開く（目安は、開けたこと）
  await expectPageStep(panel, current, 2);
  await expect(panel.hintText()).toContainText('開けました。次へ進めます');
  await panel.next();

  // 3: ミニガイド（対象は無いのでハイライトは無い）
  await expectPageStep(panel, current, 3);
  expect((await ui.overlay())?.frame ?? null).toBeNull();
  await panel.next();

  // 4: 見出しがハイライトされる
  await expectPageStep(panel, current, 4);
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  const heading = await current.getByRole('heading', { name: 'Example Domain' }).boundingBox();
  expect(heading).not.toBeNull();
  await panel.next();

  // 5・6: リンクがハイライトされ、6 では目安が満たされる
  await expectPageStep(panel, current, 5);
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  await panel.next();
  await expectPageStep(panel, current, 6);
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  await expect(panel.hintText()).toContainText('次へ進めます');
  await panel.next();

  // 7: 対象は無い。ミニガイドだけ
  await expectPageStep(panel, current, 7);
  expect((await ui.overlay())?.frame ?? null).toBeNull();
  await panel.next();

  // 8〜12: 案内だけの手順。サイドパネルだけを見て進める
  for (const stepNo of [8, 9, 10, 11, 12]) {
    await expectPageStep(panel, current, stepNo);
    await expect(panel.page.locator('.step-body .notice')).toContainText('ブラウザの外などで行う手順です');
    if (stepNo < STEP_COUNT) await panel.next();
  }
  await panel.finish();

  await expect(panel.page.getByRole('status').filter({ hasText: '完了しました' })).toContainText(TOUR_NAME);
  await expect(panel.card(TOUR_NAME).getByRole('button', { name: '続きから' })).toHaveCount(0);
  await expectNoOwnUi(ui);
  expect(await hasProgress(ext, TOUR_ID)).toBe(false);
});

test('E-85: 完了の目安を満たさずに「次へ」で進めても、最後まで進める', async ({ ext, server, openTab, openPanel }) => {
  await routeExampleCom(ext.context);
  const current = await openTab(server.url('/static'));
  const panel = await openPanel();
  await startIntroToStep2(panel);

  // 2 番目の目安（ページを開く）を満たさずに進む
  await expect(panel.hintText()).toBeVisible();
  await expect(panel.hintText()).not.toContainText('次へ進めます');
  await panel.next();
  await expectPanelStep(panel, `3/${String(STEP_COUNT)}`);
  // ページは開かれず、ページ上に何も出ない
  await sleep(1000);
  await expectNoOwnUi(ownUi(current), 500);
  expect(examplePages(current)).toHaveLength(0);

  for (let n = 4; n <= STEP_COUNT; n++) {
    await panel.next();
    await expectPanelStep(panel, `${String(n)}/${String(STEP_COUNT)}`);
  }
  await panel.finish();
  await expect(panel.page.getByRole('status').filter({ hasText: '完了しました' })).toBeVisible();
  expect(await hasProgress(ext, TOUR_ID)).toBe(false);
});

test('E-86: リンクの名前が旧表記でも、名前の候補でリンクがハイライトされる', async ({ ext, server, openTab, openPanel }) => {
  await routeExampleCom(ext.context, 'legacy');
  const current = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(current);
  await startIntroToStep2(panel);
  await panel.openHere();
  await current.waitForURL(EXAMPLE);
  await expectMiniGuideStep(ui, `2/${String(STEP_COUNT)}`);

  await panel.gotoStep(5);
  await expectPanelStep(panel, `5/${String(STEP_COUNT)}`);
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  const link = await current.getByRole('link', { name: 'More information...' }).boundingBox();
  const frame = (await ui.overlay())?.frame;
  expect(link).not.toBeNull();
  if (link === null || frame === null || frame === undefined) throw new Error('リンクか枠が無い');
  // 枠はリンクを囲む
  expect(frame.x).toBeLessThanOrEqual(link.x);
  expect(frame.y).toBeLessThanOrEqual(link.y);
  expect(frame.x + frame.width).toBeGreaterThanOrEqual(link.x + link.width);
  expect(frame.y + frame.height).toBeGreaterThanOrEqual(link.y + link.height);
  // 次の手順（6）でも同じ。目安（リンクの出現）が満たされる
  await panel.next();
  await expectPanelStep(panel, `6/${String(STEP_COUNT)}`);
  await expect(panel.hintText()).toContainText('次へ進めます');
});

test('E-86: ページが開けなくても、文章だけの案内と「次へ」で最後まで進められ、体験が止まらない', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  test.setTimeout(120_000);
  await routeExampleCom(ext.context, 'abort');
  const current = await openTab(server.url('/static'));
  const panel = await openPanel();
  await startIntroToStep2(panel);

  // 「今のタブで開く」の結果は失敗ページになる。ミニガイドは出ない
  await panel.openHere();
  await expect.poll(() => current.url()).toContain('chrome-error');
  await sleep(1500);
  expect(await ownUi(current).hostCount()).toBe(0);
  await expectPanelStep(panel, `2/${String(STEP_COUNT)}`);

  // 続きの手順は、サイドパネルの文章と「次へ」で読める
  await panel.next();
  await expectPanelStep(panel, `3/${String(STEP_COUNT)}`);
  await expect(panel.page.locator('.step-body h2')).toHaveText('ミニガイドを使う');
  await expect(panel.page.locator('.step-body')).not.toBeEmpty();
  // ステップの一覧から、案内だけの手順へも進める
  await panel.gotoStep(8);
  await expectPanelStep(panel, `8/${String(STEP_COUNT)}`);
  await expect(panel.page.locator('.step-body .notice')).toContainText('ブラウザの外などで行う手順です');
  for (let n = 9; n <= STEP_COUNT; n++) {
    await panel.next();
    await expectPanelStep(panel, `${String(n)}/${String(STEP_COUNT)}`);
  }
  await panel.finish();
  await expect(panel.page.getByRole('status').filter({ hasText: '完了しました' })).toBeVisible();
  expect(await ownUi(current).hostCount()).toBe(0);
});
