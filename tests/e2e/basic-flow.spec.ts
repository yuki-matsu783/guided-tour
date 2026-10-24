/**
 * 基本の動作（AC-01〜12）の E2E。ツアーの開始から完了、完了の目安、ステップの移動、URL 条件と完了ページ。
 * 使う補助は support/ の先頭の説明を参照する。
 */
import { test, expect, ownUi, importTour, beginTour } from './support/fixtures.ts';
import { rapidClick } from './support/own-ui.ts';
import { expectMiniGuideStep, expectNoOwnUi, expectPanelStep, hasProgress, sleep } from './support/flows.ts';
import { permissionRequests, spyPermissionRequests } from './support/permission-spy.ts';
import { readProductionManifest } from './support/build.ts';
import { standardTour, tourOn, urlCond } from './support/tour.ts';
import type { StepSpec } from './support/tour.ts';

test('E-01: 標準のツアーを最初から最後まで実施すると、全ステップが順に示され、完了で進捗が破棄される', async ({
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

  // 各ステップの目安を満たして「次へ」で進む
  await expectPanelStep(panel, '1/4');
  await expectMiniGuideStep(ui, '1/4');
  await tab.getByLabel('申請者名').fill('山田 太郎');
  await expect(panel.hintText()).toContainText('次へ進めます');
  await panel.next();

  await expectPanelStep(panel, '2/4');
  await expectMiniGuideStep(ui, '2/4');
  await tab.getByLabel('メールアドレス').fill('taro@example.test');
  await expect(panel.hintText()).toContainText('次へ進めます');
  await panel.next();

  await expectPanelStep(panel, '3/4');
  await expectMiniGuideStep(ui, '3/4');
  await tab.getByLabel('利用規約に同意する').check();
  await expect(panel.hintText()).toContainText('次へ進めます');
  await panel.next();

  // 最後のステップでは「次へ」が「完了」になる
  await expectPanelStep(panel, '4/4');
  await expectMiniGuideStep(ui, '4/4');
  await expect(panel.page.getByRole('button', { name: '次へ', exact: true })).toHaveCount(0);
  await panel.finish();

  // 完了が表示され、進捗が破棄される。一覧は「最初から」だけになる
  await expect(panel.page.getByRole('status').filter({ hasText: '完了しました' })).toBeVisible();
  await expect(panel.card(tour.name).getByRole('button', { name: '最初から', exact: true })).toBeVisible();
  await expect(panel.card(tour.name).getByRole('button', { name: '続きから' })).toHaveCount(0);
  await expectNoOwnUi(ui);
  expect(await hasProgress(ext, tour.id)).toBe(false);
});

test('E-02: 拡張機能を読み込んだだけでは、ページに何も足さず、サイトの権限も増やさない', async ({
  ext,
  server,
  openTab,
}) => {
  const tab = await openTab(server.url('/static'));
  await tab.waitForTimeout(1500);

  // 拡張機能の要素が DOM に無く、ページの構造も変わらない
  expect(await ownUi(tab).hostCount()).toBe(0);
  const shape = await tab.evaluate(() => ({
    htmlChildren: [...document.documentElement.children].map((e) => e.tagName),
    bodyChildren: [...document.body.children].map((e) => e.tagName),
    hasOwnAttribute: document.querySelector('[data-guided-tour-host]') !== null,
  }));
  expect(shape.htmlChildren).toEqual(['HEAD', 'BODY']);
  expect(shape.bodyChildren).toEqual(['MAIN']);
  expect(shape.hasOwnAttribute).toBe(false);
  // ページの動作は変わらない（入力できる）
  await tab.getByLabel('名前').fill('確認');
  await expect(tab.getByLabel('名前')).toHaveValue('確認');

  // 権限は、テスト用の manifest が足した分だけ（本番の manifest には足していない）
  const granted = await ext.permissions();
  expect([...granted.origins].sort()).toEqual(['http://127.0.0.1/*', 'http://localhost/*', 'https://example.com/*']);
  const production = await readProductionManifest();
  expect(production.host_permissions).toBeUndefined();
  expect(production.content_scripts).toBeUndefined();
  expect(production.permissions).not.toContain('activeTab');
});

test('E-03: ツアーを完了・終了したあとは、どのタブにも表示が無く、ページ側の監視もメッセージも止まっている', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = standardTour({ origin: server.origin, steps: 1 });
  await importTour(panel, tour);
  const recorder = await ext.recordMessages();

  for (const how of ['complete', 'stop'] as const) {
    await beginTour(panel, tour.name, tab);
    await expect.poll(async () => (await ui.miniGuide())?.step).toBe('1/1');
    // 実行中は、ページ側からメッセージが届く（記録が働いている）
    await expect.poll(async () => (await recorder.take()).length).toBeGreaterThan(0);
    if (how === 'complete') await panel.finish();
    else await panel.stop();
    await expectNoOwnUi(ui);

    // 終わったあと、ページが変化しても表示は出ず、ページ側からのメッセージも来ない（監視が止まっている）
    await recorder.take();
    await tab.evaluate(() => {
      const added = document.createElement('button');
      added.setAttribute('data-tour-id', 'applicant-name');
      added.textContent = '追加';
      document.body.appendChild(added);
      document.querySelector('h1')?.setAttribute('data-changed', 'yes');
    });
    await sleep(2500);
    expect(await ui.hostCount()).toBe(0);
    expect(await recorder.take()).toEqual([]);

    // 対象サイトと他のサイトの、複数の新しいタブ
    const others = [
      await openTab(server.url('/internal/')),
      await openTab(server.url('/static', '127.0.0.1')),
      await openTab(server.url('/static')),
    ];
    await sleep(1500);
    for (const other of others) expect(await ownUi(other).hostCount()).toBe(0);
    expect((await recorder.take()).filter((m) => m.type !== 'LOG')).toEqual([]);
    for (const other of others) await other.close();
    await tab.bringToFront();
  }
});

test('E-04: 許可のないサイトのツアーは開始されず、許可は origins のサイトだけが求められる（手動で補う）', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  // 許可ダイアログそのものは E2E で操作できない（手動）。ここでは、求める許可の中身と、開始されないことを確かめる
  await spyPermissionRequests(ext.context);
  const tab = await openTab(server.url('/static', '127.0.0.1'));
  const panel = await openPanel();
  const tour = tourOn(server.altOrigin, { exact: '/static' }, [{ id: 'only', title: '唯一の手順' }], {
    id: 'e2e-unpermitted',
    name: '許可のないサイトのツアー',
  });
  await importTour(panel, tour);

  // 利用者がサイトへのアクセスを外した状態を作る
  await ext.revokeSite('http://127.0.0.1/*');
  await panel.page.getByRole('button', { name: '再読み込み' }).click();
  await expect(panel.card(tour.name)).toContainText('サイトの許可なし');

  await tab.bringToFront();
  await panel.start(tour.name);
  await expect.poll(() => permissionRequests(panel.page)).toEqual([{ origins: ['http://127.0.0.1/*'] }]);

  // 許可されないままなので、開始されない
  await sleep(1500);
  await expect(panel.page.locator('.screen-running')).toHaveCount(0);
  await expect(panel.card(tour.name)).toBeVisible();
  expect(await ownUi(tab).hostCount()).toBe(0);
  expect(await ext.storageSession('tour')).toBeUndefined();

  // 許可が戻れば、同じ操作で開始できる（許可済みなら確認は出ない）
  await ext.grantSite('http://127.0.0.1/*');
  await panel.page.getByRole('button', { name: '再読み込み' }).click();
  await expect(panel.card(tour.name)).toContainText('サイトの許可あり');
  await panel.start(tour.name);
  await panel.useTab();
  await expect(panel.page.locator('.screen-running')).toBeVisible();
});

test('E-05: 対象要素が最初からある静的なページでは、すぐにハイライトされ、近くに吹き出しが出る', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = tourOn(server.origin, { exact: '/static' }, [
    { id: 'send', title: '送信ボタンを確認する', tip: 'ここを押します', target: { tourId: 'static-button' } },
  ]);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);

  // 8 秒より十分短い時間（1 秒以内）で特定される
  await expect.poll(async () => (await ui.overlay())?.frame ?? null, { timeout: 1000 }).not.toBeNull();
  const overlay = await ui.overlay();
  const box = await tab.getByRole('button', { name: '送信' }).boundingBox();
  expect(box).not.toBeNull();
  if (overlay?.frame == null || box === null || overlay.bubble === null) throw new Error('表示が無い');
  // 枠は対象を囲み、吹き出しは対象のすぐ近く（下）にある
  expect(overlay.frame.x).toBeLessThanOrEqual(box.x);
  expect(overlay.frame.y).toBeLessThanOrEqual(box.y);
  expect(overlay.frame.x + overlay.frame.width).toBeGreaterThanOrEqual(box.x + box.width);
  expect(overlay.frame.y + overlay.frame.height).toBeGreaterThanOrEqual(box.y + box.height);
  expect(overlay.bubble.text).toContain('送信ボタンを確認する');
  expect(overlay.bubble.rect.y).toBeGreaterThanOrEqual(overlay.frame.y + overlay.frame.height);
  expect(overlay.bubble.rect.y - (overlay.frame.y + overlay.frame.height)).toBeLessThan(40);
});

test('E-06: 要素が無い状態でステップに入ると 8 秒以内に文章だけの案内になり、10 秒後に追加されるとハイライトに変わる', async ({
  server,
  openTab,
  openPanel,
}) => {
  test.setTimeout(90_000);
  const tab = await openTab(server.url('/delayed?far=1'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = tourOn(server.origin, { exact: '/delayed' }, [
    {
      id: 'late',
      title: '遅れて出るボタン',
      target: { tourId: 'late-button', fallbackText: 'ボタンが見つかるまで、文章の案内に沿ってください' },
    },
    { id: 'next', title: '次の手順' },
  ]);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  let enteredAt = Date.now();

  // 8 秒以内に、文章だけの案内（ハイライトは無い）へ切り替わる
  await expect
    .poll(async () => (await ui.miniGuide())?.fallback ?? '', { timeout: 8500, intervals: [250] })
    .toContain('ボタンが見つかるまで');
  expect(Date.now() - enteredAt).toBeLessThan(9000);
  expect((await ui.overlay())?.frame ?? null).toBeNull();

  // 「次へ」で進める。戻ると、ステップに入り直した時刻から数え直す
  await panel.next();
  await expectPanelStep(panel, '2/2');
  await panel.prev();
  await expectPanelStep(panel, '1/2');
  enteredAt = Date.now();
  await expect
    .poll(async () => (await ui.miniGuide())?.fallback ?? '', { timeout: 8500, intervals: [250] })
    .toContain('ボタンが見つかるまで');

  // 入って 10 秒後に要素が追加されると、ハイライトに変わる。画面の外だが、スクロールしない
  await sleep(Math.max(0, 10_000 - (Date.now() - enteredAt)));
  await tab.evaluate(() => {
    const add: unknown = Reflect.get(window, 'addLateButton');
    if (typeof add === 'function') Reflect.apply(add, window, []);
  });
  await expect.poll(async () => (await ui.overlay())?.frame ?? null, { timeout: 8000 }).not.toBeNull();
  expect(await tab.evaluate(() => window.scrollY)).toBe(0);

  // 設定の保守記録に「未検出」が残る（設定は一覧の画面にあるので、ツアーを終了してから開く）
  await panel.stop();
  await panel.openSettings();
  await expect(panel.page.locator('.diagnostics')).toContainText('未検出');
  await expect(panel.page.locator('.diagnostics')).toContainText('ステップ late');
});

test('E-07: 入力済みの目安は、1 文字入力すると「次へ進めます」になり、消すと戻る。自動では進まない', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/tokens/new'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = tourOn(server.origin, { prefix: '/tokens' }, tokenSteps());
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);

  await expect(panel.hintText()).toContainText('名前を入力してください');
  await tab.locator('#token-name').fill('a');
  await expect(panel.hintText()).toContainText('次へ進めます');
  await expect.poll(async () => (await ui.miniGuide())?.hint).toBe('次へ進めます');
  // 満たしても自動では進まない
  await sleep(2000);
  await expectPanelStep(panel, '1/2');

  await tab.locator('#token-name').fill('');
  await expect(panel.hintText()).toContainText('名前を入力してください');
  await expect.poll(async () => (await ui.miniGuide())?.hint).toBe('名前を入力してください');
  await expectPanelStep(panel, '1/2');
});

test('E-08: イベントを発生させずにスクリプトで値を変えても、完了の目安の案内が短い間隔で変わる', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/tokens/new'));
  const panel = await openPanel();
  const tour = tourOn(server.origin, { prefix: '/tokens' }, tokenSteps());
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expect(panel.hintText()).toContainText('名前を入力してください');

  // value を直接代入する（input・change イベントは出ない）
  await tab.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#token-name');
    if (input) input.value = 'script-value';
  });
  await expect(panel.hintText()).toContainText('次へ進めます', { timeout: 3000 });
  await tab.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#token-name');
    if (input) input.value = '';
  });
  await expect(panel.hintText()).toContainText('名前を入力してください', { timeout: 3000 });
});

test('E-09: 完了の目安を満たさなくても「次へ」で次のステップへ進む（サイドパネルとミニガイドの両方）', async ({
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
  await expect(panel.hintText()).toContainText('名前を入力してください');

  // サイドパネルの「次へ」
  await panel.next();
  await expectPanelStep(panel, '2/4');
  await expectMiniGuideStep(ui, '2/4');
  await expect(panel.hintText()).toContainText('メールアドレスを入力してください');

  // ミニガイドの「次へ」（実際のクリック）
  await ui.clickButton('次へ');
  await expectPanelStep(panel, '3/4');
  await expectMiniGuideStep(ui, '3/4');
});

test('E-10: ステップ一覧から 5 番目を選ぶと 5 番目に移り、目安を満たしていても自動では先へ進まない', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const steps: StepSpec[] = Array.from({ length: 6 }, (_, i) => ({
    id: `a${String(i + 1)}`,
    title: `手順 ${String(i + 1)}`,
    // 5 番目は、目安（ボタンの出現）がすでに満たされている
    ...(i === 4
      ? {
          target: { tourId: 'submit-button' },
          done: { type: 'element', target: { tourId: 'submit-button' }, doneHint: '見つかりました' },
        }
      : {}),
  }));
  const tour = tourOn(server.origin, { prefix: '/internal' }, steps);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectPanelStep(panel, '1/6');

  await panel.gotoStep(5);
  await expectPanelStep(panel, '5/6');
  await expectMiniGuideStep(ui, '5/6');
  await expect(panel.hintText()).toContainText('次へ進めます');
  await sleep(3000);
  await expectPanelStep(panel, '5/6');
  await expectMiniGuideStep(ui, '5/6');
});

test('E-11: 「次へ」を素早く連打しても、サイドパネルとミニガイドを同時に押しても、1 ステップだけ進む', async ({
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

  // サイドパネルの「次へ」を素早く連打する（実際のマウスで、押して離すを 5 回続ける）
  const next = panel.page.getByRole('button', { name: '次へ', exact: true });
  const box = await next.boundingBox();
  if (box === null) throw new Error('次へが見つからない');
  await rapidClick(panel.page, box.x + box.width / 2, box.y + box.height / 2, 5);
  await expectPanelStep(panel, '2/4');
  await sleep(1000);
  await expectPanelStep(panel, '2/4');
  await expectMiniGuideStep(ui, '2/4');

  // ミニガイドの「次へ」を素早く連打する
  const miniNext = (await ui.nodes('.panel .actions button')).find((b) => b.text.trim() === '次へ');
  if (miniNext === undefined) throw new Error('ミニガイドの次へが見つからない');
  const x = miniNext.rect.x + miniNext.rect.width / 2;
  const y = miniNext.rect.y + miniNext.rect.height / 2;
  await rapidClick(tab, x, y, 5);
  await expectPanelStep(panel, '3/4');
  await sleep(1000);
  await expectPanelStep(panel, '3/4');

  // サイドパネルとミニガイドの「次へ」をほぼ同時に押す
  const nextNow = await next.boundingBox();
  if (nextNow === null) throw new Error('次へが見つからない');
  const mini = (await ui.nodes('.panel .actions button')).find((b) => b.text.trim() === '次へ');
  if (mini === undefined) throw new Error('ミニガイドの次へが見つからない');
  await Promise.all([
    panel.page.mouse.click(nextNow.x + nextNow.width / 2, nextNow.y + nextNow.height / 2),
    tab.mouse.click(mini.rect.x + mini.rect.width / 2, mini.rect.y + mini.rect.height / 2),
  ]);
  await expectPanelStep(panel, '4/4');
  await sleep(1000);
  await expectPanelStep(panel, '4/4');
  await expectMiniGuideStep(ui, '4/4');
});

test('E-12: URL 条件と完了ページが別のステップは、完了ページへ移っても不一致の案内を出さず、ハイライトもしない', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/tokens/new'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const steps: StepSpec[] = [
    {
      id: 'create',
      title: 'トークンを作成する',
      url: urlCond(server.origin, { exact: '/tokens/new' }),
      target: { tourId: 'token-create' },
      done: {
        type: 'page',
        url: urlCond(server.origin, { exact: '/tokens/created' }),
        hint: '作成してください',
        doneHint: '作成できました',
      },
    },
    { id: 'after', title: '作成後の確認', url: urlCond(server.origin, { exact: '/tokens/created' }) },
  ];
  const tour = tourOn(server.origin, { exact: '/tokens/new' }, steps);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);

  // 作成前は、対象のボタンがハイライトされる
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  await expect(panel.hintText()).toContainText('作成してください');

  await tab.locator('#token-name').fill('e2e-token');
  await tab.getByRole('button', { name: '作成' }).click();
  await tab.waitForURL(/\/tokens\/created/);

  // 「次へ進めます」と表示される。不一致の案内も、正しいページへ戻す案内も出ない
  await expect(panel.hintText()).toContainText('次へ進めます');
  await expect(panel.hintText()).toContainText('作成できました');
  await expect(panel.page.locator('.tab-controls .notice')).toHaveCount(0);
  await expect(panel.page.getByRole('button', { name: '今のタブで開く' })).toHaveCount(0);
  // ミニガイドは出るが、ハイライトはしない
  await expect.poll(async () => (await ui.miniGuide())?.hint).toBe('次へ進めます');
  await sleep(1000);
  expect((await ui.overlay())?.frame ?? null).toBeNull();
  await expectPanelStep(panel, '1/2');
});

/** P-I（`/tokens/new`）の入力欄が入力済みになることを目安にする 2 ステップ。 */
function tokenSteps(): StepSpec[] {
  return [
    {
      id: 'name',
      title: 'トークン名を入力する',
      target: { tourId: 'token-name' },
      done: {
        type: 'state',
        state: 'filled',
        target: { tourId: 'token-name' },
        hint: '名前を入力してください',
        doneHint: '入力できました',
      },
    },
    { id: 'create', title: '作成する', target: { tourId: 'token-create' } },
  ];
}
