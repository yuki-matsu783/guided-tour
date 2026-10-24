/**
 * 基本の動作のうち、タブ・ウィンドウ・表示の切り替え（AC-13〜20）の E2E。
 * 複数ウィンドウは `openWindow`、前面への切り替えは `ext.focusPage` を使う。
 */
import { test, expect, ownUi, importTour, beginTour } from './support/fixtures.ts';
import { expectMiniGuideStep, expectNoOwnUi, expectPanelStep, sleep, tabCount } from './support/flows.ts';
import { standardTour, tourOn } from './support/tour.ts';
import type { StepSpec } from './support/tour.ts';

test('E-13: 役割のタブが無いとき、ページは自動で開かず、既存タブの選択・今のタブで開く・新しいタブで開くを選べる', async ({
  ext,
  server,
  openWindow,
  openPanel,
}) => {
  // 条件に合うタブ（別ウィンドウ）と、「今のタブ」（前面のウィンドウの選択中のタブ。最後に作ったウィンドウ）を用意する
  const matching = await openWindow(server.url('/internal/'));
  const current = await openWindow(server.url('/static', '127.0.0.1'));
  const panel = await openPanel();
  const tour = standardTour({ origin: server.origin, steps: 1 });
  await importTour(panel, tour);

  const startAndCheck = async (): Promise<number> => {
    const before = await tabCount(ext);
    await panel.start(tour.name);
    await expect(panel.page.locator('.screen-running')).toBeVisible();
    // 条件に合うタブが別ウィンドウにあるので、既存タブの一覧に出る。ページは自動では開かれない
    await expect(panel.page.getByRole('button', { name: /「社内ツール」を「申請ページ」として使う/ })).toBeVisible();
    await expect(panel.page.getByRole('button', { name: '今のタブで開く' })).toBeVisible();
    await expect(panel.page.getByRole('button', { name: '新しいタブで開く' })).toBeVisible();
    await sleep(1000);
    expect(await tabCount(ext)).toBe(before);
    expect(await ownUi(matching).hostCount()).toBe(0);
    expect(await ownUi(current).hostCount()).toBe(0);
    return before;
  };

  // (a) 既存タブを選ぶと、そのタブに対応付けられる
  await startAndCheck();
  await panel.useTab(/「社内ツール」を「申請ページ」として使う/);
  await expectMiniGuideStep(ownUi(matching), '1/1');
  await panel.stop();

  // (b) 「今のタブで開く」: 前面のタブが開く URL へ移る（タブは増えない）
  const before = await startAndCheck();
  await panel.openHere();
  await current.waitForURL(`${server.origin}/internal/`);
  await expectMiniGuideStep(ownUi(current), '1/1');
  expect(await tabCount(ext)).toBe(before);
  await panel.stop();

  // (c) 「新しいタブで開く」: 新しいタブが 1 つ増える
  await current.goto(server.url('/static', '127.0.0.1'));
  const before2 = await startAndCheck();
  const [created] = await Promise.all([ext.context.waitForEvent('page'), panel.openNew()]);
  await created.waitForURL(`${server.origin}/internal/`);
  await expectMiniGuideStep(ownUi(created), '1/1');
  expect(await tabCount(ext)).toBe(before2 + 1);
});

test('E-14: 役割のタブが URL 条件に合わないページにあると、表示が消え、正しいページを開く手段が出る。タブは増えない', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = standardTour({ origin: server.origin, steps: 2 });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/2');

  // 役割のタブを、条件に合わないページ（同じオリジンの別のパス）へ移す
  await tab.goto(server.url('/project-danger'));
  const before = await tabCount(ext);
  await expect(panel.page.locator('.tab-controls .notice')).toContainText('別のページを表示しています');
  await expect(panel.page.getByRole('button', { name: '今のタブで開く' })).toBeVisible();
  await expect(panel.page.getByRole('button', { name: '新しいタブで開く' })).toBeVisible();
  await expectNoOwnUi(ui);

  // ステップに入り直しても同じ（タブは増えず、表示も出ない）
  await panel.next();
  await expectPanelStep(panel, '2/2');
  await expect(panel.page.locator('.tab-controls .notice')).toContainText('別のページを表示しています');
  await expectNoOwnUi(ui);
  expect(await tabCount(ext)).toBe(before);
});

test('E-15: 別のウィンドウで作業中に「次へ」を押しても、タブは切り替わらずスクロールもしない。「○○のタブへ移動」で前面に出る', async ({
  ext,
  server,
  openTab,
  openWindow,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static-tall'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const steps: StepSpec[] = [
    { id: 'head', title: '見出しを確認する', target: { role: 'heading', name: ['縦に長いページ'], require: { role: 'heading' } } },
    { id: 'far', title: '下のボタンを確認する', target: { tourId: 'far-button' } },
  ];
  const tour = tourOn(server.origin, { exact: '/static-tall' }, steps);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/2');
  const before = await ext.tabInfo(tab);
  expect(before.windowFocused).toBe(true);
  expect(before.active).toBe(true);

  // 別のウィンドウで作業する（ヘッドレスでは、案内中のウィンドウを最小化して前面でなくする）
  const other = await openWindow(server.url('/static'));
  expect((await ext.tabInfo(other)).windowId).not.toBe(before.windowId);
  await ext.blurWindow(tab);
  await expect.poll(async () => (await ext.tabInfo(tab)).windowFocused).toBe(false);

  await panel.next();
  await expectPanelStep(panel, '2/2');
  await sleep(1500);
  // タブは切り替わらず（別ウィンドウのまま）、自動スクロールも起きない
  const after = await ext.tabInfo(tab);
  expect(after.windowFocused).toBe(false);
  expect((await ext.tabInfo(other)).windowFocused).toBe(true);
  expect(await tab.evaluate(() => window.scrollY)).toBe(0);
  // 「○○のタブへ移動」が表示され、押すとそのタブとウィンドウが前面に出る
  await expect(panel.page.getByRole('button', { name: '「練習ページ」のタブへ移動' })).toBeVisible();
  await panel.focusRole();
  await expect.poll(async () => (await ext.tabInfo(tab)).windowFocused).toBe(true);
  expect((await ext.tabInfo(tab)).active).toBe(true);
  await expect(panel.page.getByRole('button', { name: '「練習ページ」のタブへ移動' })).toHaveCount(0);
});

test('E-16: 役割のタブを選択中でなくすると目安が「確認を停止中」になり、元のタブへ戻すと判定が再開する', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/tokens/new'));
  const panel = await openPanel();
  const steps: StepSpec[] = [
    {
      id: 'name',
      title: 'トークン名を入力する',
      done: { type: 'state', state: 'filled', target: { tourId: 'token-name' }, hint: '名前を入力してください', doneHint: '入力できました' },
    },
  ];
  const tour = tourOn(server.origin, { prefix: '/tokens' }, steps);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expect(panel.hintText()).toContainText('名前を入力してください');

  // 同じウィンドウの別のタブを選ぶ
  await openTab(server.url('/static'));
  await expect(panel.hintText()).toContainText('確認を停止中');

  // 元のタブへ戻すと再開する。停止中に入力した内容も、戻ったあとに判定される
  await tab.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#token-name');
    if (input) input.value = 'typed';
  });
  await ext.focusPage(tab);
  await expect(panel.hintText()).toContainText('次へ進めます');
  await expect(panel.hintText()).not.toContainText('確認を停止中');
});

test('E-17: 案内対象のタブを閉じて、既存タブの選択でも「新しいタブで開く」でも、同じステップから続けられる', async ({
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

  // タブを閉じる
  await tab.close();
  await expect(panel.page.locator('.tab-controls .notice')).toContainText('タブがありません');
  await expectPanelStep(panel, '2/4');

  // (a) 条件に合うタブを開き直して、既存タブとして選ぶ
  const reopened = await openTab(server.url('/internal/'));
  await panel.useTab();
  await expectMiniGuideStep(ownUi(reopened), '2/4');
  await expectPanelStep(panel, '2/4');

  // (b) もう一度閉じて、「新しいタブで開く」
  await reopened.close();
  await expect(panel.page.locator('.tab-controls .notice')).toContainText('タブがありません');
  const [created] = await Promise.all([ext.context.waitForEvent('page'), panel.openNew()]);
  await created.waitForURL(`${server.origin}/internal/`);
  await expectMiniGuideStep(ownUi(created), '2/4');
  await expectPanelStep(panel, '2/4');
});

test('E-18: 吹き出しの × で表示を消すと、ミニガイドは残り「表示を戻す」が出る。同条件の別ページへ移っても戻らない', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/project'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const steps: StepSpec[] = [
    { id: 'send', title: '送信を確認する', target: { tourId: 'static-button' } },
    { id: 'end', title: '終わり', target: { tourId: 'static-button' } },
  ];
  const tour = tourOn(server.origin, { prefix: '/project' }, steps);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();

  await ui.click('.bubble .close');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).toBeNull();
  expect((await ui.overlay())?.bubble ?? null).toBeNull();
  const mini = await ui.miniGuide();
  expect(mini?.buttons).toContain('表示を戻す');

  // 同じ役割のタブで、条件に合う別のページへ移る。表示は戻らない
  await tab.goto(server.url('/project/settings'));
  await expectMiniGuideStep(ui, '1/2');
  await sleep(2500);
  expect((await ui.overlay())?.frame ?? null).toBeNull();
  expect((await ui.miniGuide())?.buttons).toContain('表示を戻す');
  await expect(panel.page.getByRole('button', { name: '表示を戻す' })).toBeVisible();

  // 「表示を戻す」で戻る
  await ui.clickButton('表示を戻す');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
});

test('E-19: 「ミニガイドを表示しない」にして × を押すと、ミニガイドは出ず、ページ上に表示を戻すボタンが出る', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  await panel.openSettings();
  await panel.setMiniGuideHidden(true);
  await panel.backToList();
  const tour = tourOn(server.origin, { exact: '/static' }, [
    { id: 'send', title: '送信を確認する', target: { tourId: 'static-button' } },
  ]);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);

  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  expect(await ui.miniGuide()).toBeNull();
  await ui.click('.bubble .close');
  await expect.poll(async () => (await ui.overlay())?.restoreVisible).toBe(true);
  expect(await ui.miniGuide()).toBeNull();
  expect((await ui.overlay())?.frame ?? null).toBeNull();

  // 押すと戻る
  await ui.click('.restore');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  expect((await ui.overlay())?.restoreVisible).toBe(false);
});

for (const miniGuide of [true, false]) {
  test(`E-20: 表示を消した状態で案内だけの手順に入ると、ページ上に何も出ず「次へ」で進める（ミニガイド${miniGuide ? 'あり' : 'なし'}）`, async ({
    server,
    openTab,
    openPanel,
  }) => {
    const tab = await openTab(server.url('/static'));
    const panel = await openPanel();
    const ui = ownUi(tab);
    if (!miniGuide) {
      await panel.openSettings();
      await panel.setMiniGuideHidden(true);
      await panel.backToList();
    }
    const steps: StepSpec[] = [
      { id: 'p1', title: '送信を確認する', target: { tourId: 'static-button' } },
      { id: 'g', title: '画面の外の手順', kind: 'guide' },
      { id: 'p3', title: '最後の手順', target: { tourId: 'static-button' } },
    ];
    const tour = tourOn(server.origin, { exact: '/static' }, steps);
    await importTour(panel, tour);
    await beginTour(panel, tour.name, tab);
    await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();

    // 表示を消す
    await panel.press(panel.page.getByRole('button', { name: '表示を消す' }));
    await expect.poll(async () => (await ui.overlay())?.frame ?? null).toBeNull();

    // 案内だけの手順: ミニガイドも表示を戻すボタンも含め、何も出ない
    await panel.next();
    await expectPanelStep(panel, '2/3');
    await expectNoOwnUi(ui);
    // ステップと無関係のページを開いていても、警告は出ず、何も表示されない
    await tab.goto(server.url('/project-danger'));
    await expectNoOwnUi(ui);
    await expect(panel.page.locator('.tab-controls')).toHaveCount(0);
    await expect(panel.page.getByText('別のページを表示しています')).toHaveCount(0);

    // 「次へ」で進める
    await panel.next();
    await expectPanelStep(panel, '3/3');
  });
}
