/**
 * 取り込みと表示（AC-34〜45）の E2E。誤ったツアーの拒否、Markdown と画像の表示、説明文の文字列表示、名前の候補による照合、
 * 同梱版の上書き、origins 外の拒否と警告、宣言外のリンク、URL 条件の前方一致、合計容量の上限。
 * 使う補助は support/ の先頭の説明を参照する。画像は fixtures/import-display/images.ts が組み立てる。
 */
import type { Page } from '@playwright/test';
import { test, expect, ownUi, importTour, beginTour } from './support/fixtures.ts';
import { expectMiniGuideStep, expectPanelStep, sleep } from './support/flows.ts';
import { openPanel as openPanelOf } from './support/panel.ts';
import type { SidePanel } from './support/panel.ts';
import { permissionRequests, spyPermissionRequests } from './support/permission-spy.ts';
import { standardTour, tourOn, tourYaml, urlCond, yamlFile, zipFile } from './support/tour.ts';
import type { ImportFile, StepSpec, TourSpec } from './support/tour.ts';
import { gifImage, paddedPng, pngImage } from './fixtures/import-display/images.ts';

const INTRO_ID = 'guided-setup-tour-intro';
const INTRO_NAME = 'Guided Setup Tour の使い方';
const MB = 1024 * 1024;

/** 取り込みの結果の領域に出ている、失敗した項目の内容。 */
async function errorItems(panel: SidePanel): Promise<{ file: string; line: string; path: string; message: string }[]> {
  const issues = panel.importResults().locator('.result-error .issue');
  const count = await issues.count();
  const items = [];
  for (let i = 0; i < count; i++) {
    const issue = issues.nth(i);
    items.push({
      file: (await issue.locator('.issue-file').allTextContents()).join(''),
      line: (await issue.locator('.issue-line').allTextContents()).join(''),
      path: (await issue.locator('.issue-path').allTextContents()).join(''),
      message: (await issue.locator('.issue-message').textContent()) ?? '',
    });
  }
  return items;
}

/** 取り込まれず、結果に失敗が出ていること。ツアーの一覧は同梱の自己紹介ツアーだけのまま。 */
async function expectRejected(panel: SidePanel, fileName: string): Promise<void> {
  await expect(panel.importResults().locator('.result-error')).toHaveCount(1);
  await expect(panel.importResults().locator('.result-ok')).toHaveCount(0);
  await expect(panel.importResults().locator('.result-error')).toContainText(fileName);
  await expect(panel.page.locator('li.tour-card')).toHaveCount(1);
}

test('E-34: インデントの誤りのある YAML は、ファイル名・行番号・理由を示して取り込まれない', async ({ openPanel }) => {
  const panel = await openPanel();
  const broken = [
    'schemaVersion: 3',
    'id: broken-indent',
    'name: 壊れたツアー',
    'origins: [http://localhost:1]',
    'steps:',
    '  - id: s1',
    '    title: 一つ目',
    '   kind: guide',
    '',
  ].join('\n');
  await panel.importFiles([yamlFile(broken, 'broken-indent.yaml')]);
  await expectRejected(panel, 'broken-indent.yaml');
  const items = await errorItems(panel);
  expect(items.length).toBeGreaterThan(0);
  const first = items[0];
  expect(first?.file).toBe('broken-indent.yaml');
  // 誤りのある行（8 行目）の付近が示される
  const line = Number(/^(\d+) 行目$/.exec(first?.line ?? '')?.[1] ?? '0');
  expect(line).toBeGreaterThanOrEqual(1);
  expect(line).toBeLessThanOrEqual(9);
  expect(first?.message).not.toBe('');
});

test('E-34: スキーマに違反する YAML は、ファイル名・行番号・項目の場所・理由を示して取り込まれない', async ({
  server,
  openPanel,
}) => {
  const panel = await openPanel();
  const invalid = [
    'schemaVersion: 3',
    'id: broken-schema',
    'name: 項目の誤りのあるツアー',
    `origins: [${server.origin}]`,
    'steps:',
    '  - id: s1',
    '    titel: 題名の書き間違い',
    '    kind: guide',
    '',
  ].join('\n');
  await panel.importFiles([yamlFile(invalid, 'broken-schema.yaml')]);
  await expectRejected(panel, 'broken-schema.yaml');
  const items = await errorItems(panel);
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(item.file).toBe('broken-schema.yaml');
    expect(item.line).toMatch(/^\d+ 行目$/);
    expect(item.path).toMatch(/^場所: .+/);
    expect(item.message).not.toBe('');
  }
  // 書き間違えた項目の場所が示される
  expect(items.some((i) => i.path.includes('steps'))).toBe(true);
});

/** zip の中の step 1 の説明（Markdown）と画像を持つ、`/internal/` 向けのツアー。 */
function imageTour(origin: string, id: string, name: string, withMedia = true): TourSpec {
  return tourOn(
    origin,
    { prefix: '/internal' },
    [
      {
        id: 's1',
        title: '画像のある手順',
        bodyFile: 'steps/01.md',
        ...(withMedia ? { media: { src: 'images/sub/anim.gif', alt: '動く図', caption: '図1 動く図' } } : {}),
        target: { tourId: 'applicant-name' },
      },
    ],
    { id, name },
  );
}

const IMAGE_MARKDOWN = [
  '# 見出し',
  '',
  '説明文の段落です。**強調**もあります。',
  '',
  '![画面の例](../images/shot.png)',
  '',
  '![動く例](../images/sub/anim.gif)',
  '',
].join('\n');

async function imageSizes(page: Page, selector: string): Promise<{ alt: string; complete: boolean; width: number; height: number }[]> {
  return page.locator(selector).evaluateAll((list) =>
    list.map((el) =>
      el instanceof HTMLImageElement
        ? { alt: el.alt, complete: el.complete, width: el.naturalWidth, height: el.naturalHeight }
        : { alt: '', complete: false, width: 0, height: 0 },
    ),
  );
}

test('E-35: Markdown とサブディレクトリの画像（GIF を含む）を含む zip を取り込み、再起動してから表示すると、説明文と画像が正しく表示される', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const tour = imageTour(server.origin, 'e2e-images', '画像のあるツアー');
  const zip = zipFile('images.zip', {
    'tour.yaml': tourYaml(tour),
    'steps/01.md': IMAGE_MARKDOWN,
    'images/shot.png': pngImage(37, 23),
    'images/sub/anim.gif': gifImage(21, 13),
  });
  await importTour(panel, zip);
  await expect(panel.card(tour.name)).toBeVisible();

  // ドラッグ＆ドロップでも1回取り込む
  const dropped = standardTour({ origin: server.origin, id: 'e2e-dropped', name: 'ドロップで取り込んだツアー', steps: 1 });
  await panel.dropFiles([yamlFile(dropped)]);
  await expect(panel.importResults().locator('.result-ok')).toHaveCount(1);
  await expect(panel.card(dropped.name)).toBeVisible();

  // ブラウザを再起動してから表示する
  const restarted = await ext.restart();
  const tab2 = await restarted.openTab(server.url('/internal/'));
  const panel2 = await openPanelOf(restarted);
  await expect(panel2.card(dropped.name)).toBeVisible();
  await beginTour(panel2, tour.name, tab2);

  const body = panel2.page.locator('.step-body .markdown');
  await expect(body.locator('h2')).toHaveText('見出し');
  await expect(body.locator('p').first()).toContainText('説明文の段落です。');
  await expect(body.locator('strong')).toHaveText('強調');
  // 画像の読み込みの完了と寸法
  await expect
    .poll(async () => (await imageSizes(panel2.page, '.step-body .markdown img')).filter((i) => i.complete && i.width > 0).length)
    .toBe(2);
  const inBody = await imageSizes(panel2.page, '.step-body .markdown img');
  expect(inBody).toContainEqual({ alt: '画面の例', complete: true, width: 37, height: 23 });
  expect(inBody).toContainEqual({ alt: '動く例', complete: true, width: 21, height: 13 });
  // 補足画像（GIF）と図の説明
  await expect
    .poll(async () => (await imageSizes(panel2.page, '.step-body figure.media img')).map((i) => `${String(i.width)}x${String(i.height)}`))
    .toEqual(['21x13']);
  await expect(panel2.page.locator('.step-body figure.media figcaption')).toHaveText('図1 動く図');
});

test('E-36: パッケージ外への参照・外部 URL の画像・SVG を含むツアーは、箇所と理由を示して取り込まれず、外部への通信も起きない', async ({
  ext,
  server,
  openPanel,
}) => {
  const external = 'external.example.invalid';
  const requested: string[] = [];
  ext.context.on('request', (request) => {
    requested.push(request.url());
  });
  const panel = await openPanel();

  const cases: { name: string; entries: (tour: TourSpec) => Record<string, string | Uint8Array>; spec?: (tour: TourSpec) => TourSpec; reason: string }[] = [
    {
      name: 'outside',
      entries: () => ({ 'steps/01.md': '![外](../../outside.png)\n' }),
      reason: 'パッケージの外',
    },
    {
      name: 'external-markdown',
      entries: () => ({ 'steps/01.md': `![外部](https://${external}/a.png)\n` }),
      reason: '外部',
    },
    {
      name: 'external-media',
      entries: () => ({ 'steps/01.md': '本文\n' }),
      spec: (tour) => ({
        ...tour,
        steps: tour.steps.map((s) => ({ ...s, media: { src: `https://${external}/b.png`, alt: '外部の画像' } })),
      }),
      reason: '外部',
    },
    {
      name: 'svg',
      entries: () => ({
        'steps/01.md': '![図](../images/a.svg)\n',
        'images/a.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
      }),
      reason: 'SVG',
    },
  ];
  for (const c of cases) {
    // 補足画像を変える場合以外は、補足画像を持たない（本文の参照だけを確かめる）
    const base = imageTour(server.origin, `e2e-bad-${c.name}`, `誤ったツアー ${c.name}`, c.spec !== undefined);
    const tour = c.spec === undefined ? base : c.spec(base);
    const file = zipFile(`${c.name}.zip`, { 'tour.yaml': tourYaml(tour), ...c.entries(tour) });
    await panel.importFiles([file]);
    await expectRejected(panel, `${c.name}.zip`);
    const items = await errorItems(panel);
    expect(items.some((i) => i.message.includes(c.reason))).toBe(true);
    // 該当する箇所（ファイルまたは項目の場所）が示される
    expect(items.every((i) => i.path !== '' || i.file !== '')).toBe(true);
  }
  await sleep(500);
  expect(requested.filter((u) => u.includes(external))).toEqual([]);
});

test('E-37: 説明文の <b>重要</b> は、サイドパネルとミニガイドでタグも含めて文字列のまま表示され、<b> 要素にならない', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = tourOn(
    server.origin,
    { exact: '/static' },
    [
      {
        id: 's1',
        title: '<b>重要</b>な手順',
        tip: '<b>重要</b>を確認します',
        body: '<b>重要</b>な説明です。\n\n<script>window.injected = true</script>',
        target: { tourId: 'static-button' },
      },
    ],
    { id: 'e2e-markup', name: 'タグを含むツアー' },
  );
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/1');
  await expect.poll(async () => (await ui.overlay())?.bubble ?? null).not.toBeNull();

  // サイドパネル
  const body = panel.page.locator('.step-body .markdown');
  await expect(body).toContainText('<b>重要</b>な説明です。');
  await expect(body.locator('b')).toHaveCount(0);
  await expect(body.locator('script')).toHaveCount(0);
  await expect(panel.page.locator('.step-body h2')).toHaveText('<b>重要</b>な手順');

  // ミニガイドと吹き出し
  const mini = await ui.miniGuide();
  expect(mini?.title).toBe('<b>重要</b>な手順');
  expect(mini?.tip).toBe('<b>重要</b>を確認します');
  expect(await ui.nodes('b')).toHaveLength(0);
  expect((await ui.overlay())?.bubble?.text).toContain('<b>重要</b>');

  // ページの DOM にも <b> 要素が増えていない
  await expect(tab.locator('b')).toHaveCount(0);
  const injected = await tab.evaluate((): unknown => Reflect.get(window, 'injected'));
  expect(injected).toBeUndefined();
});

/** 要素の矩形が、ハイライトの枠の内側にあり、枠が要素から大きく外れていない。 */
async function expectFrameAround(ui: ReturnType<typeof ownUi>, locator: ReturnType<Page['locator']>): Promise<void> {
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  await expect
    .poll(async () => {
      const frame = (await ui.overlay())?.frame;
      const box = await locator.boundingBox();
      if (frame === null || frame === undefined || box === null) return false;
      const tolerance = 1;
      return (
        frame.x <= box.x + tolerance &&
        frame.y <= box.y + tolerance &&
        frame.x + frame.width >= box.x + box.width - tolerance &&
        frame.y + frame.height >= box.y + box.height - tolerance &&
        frame.width <= box.width + 40 &&
        frame.height <= box.height + 40
      );
    })
    .toBe(true);
}

test('E-38: 名前の候補（日本語・英語）を持つツアーは、英語表示の GitLab 風ページでも対象要素をハイライトする', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/gitlab/tokens?lang=en'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const steps: StepSpec[] = [
    {
      id: 'token-name',
      title: 'トークン名を入力する',
      target: { label: ['トークン名', 'Token name'], fallbackText: 'トークン名の欄が対象です' },
    },
    {
      id: 'add-token',
      title: 'トークンを追加する',
      target: { role: 'button', name: ['新しいトークンを追加', 'Add new token'], fallbackText: '追加ボタンが対象です' },
    },
  ];
  const tour = tourOn(server.origin, { prefix: '/gitlab' }, steps, {
    id: 'e2e-token-issue',
    name: 'トークン発行ツアー',
    open: server.url('/gitlab/tokens?lang=en'),
  });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);

  // 英語表示: 名前の候補の英語側で照合する
  await expectMiniGuideStep(ui, '1/2');
  await expectFrameAround(ui, tab.getByLabel('Token name'));
  await panel.next();
  await expectPanelStep(panel, '2/2');
  await expectFrameAround(ui, tab.getByRole('button', { name: 'Add new token' }));

  // 日本語表示: 日本語側で照合する
  await tab.goto(server.url('/gitlab/tokens?lang=ja'));
  await expectMiniGuideStep(ui, '2/2');
  await expectFrameAround(ui, tab.getByRole('button', { name: '新しいトークンを追加' }));
  await panel.prev();
  await expectPanelStep(panel, '1/2');
  await expectFrameAround(ui, tab.getByLabel('トークン名'));
});

test('E-38: data-tour-id の無い英語版の社内ツール風ページでも、文字列の候補で対象要素をハイライトする', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal-en/'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const steps: StepSpec[] = [
    { id: 'submit', title: '申請を送る', target: { text: ['申請を送る', 'Submit request'], fallbackText: '送信ボタンが対象です' } },
    { id: 'help', title: 'ヘルプを見る', target: { role: 'link', name: ['ヘルプ', 'Help center'], fallbackText: 'ヘルプが対象です' } },
  ];
  const tour = tourOn(server.origin, { prefix: '/internal-en' }, steps, {
    id: 'e2e-internal-en',
    name: '英語版の社内ツアー',
  });
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/2');
  await expectFrameAround(ui, tab.getByRole('button', { name: 'Submit request' }));
  await panel.next();
  await expectPanelStep(panel, '2/2');
  await expectFrameAround(ui, tab.getByRole('link', { name: 'Help center' }));
});

test('E-39: 同梱ツアーと同じ ID のツアーは、確認が出て、承認しなければ同梱版のまま、承認すると「取り込み」になり、削除すると同梱版へ戻る', async ({
  server,
  openPanel,
}) => {
  const panel = await openPanel();
  const replacement = standardTour({ origin: server.origin, id: INTRO_ID, name: '置き換えたツアー', steps: 1 });
  const file = yamlFile(replacement);
  const dialog = panel.page.getByRole('alertdialog');
  const only = panel.page.locator('li.tour-card');
  await expect(panel.card(INTRO_NAME).locator('.badge-bundled')).toHaveText('同梱');

  // 承認しない: 同梱版のまま
  await panel.importFiles([file]);
  await expect(dialog).toContainText('同梱されたツアーを、取り込んだもので置き換えます');
  await panel.cancel();
  await expect(panel.importResults().locator('.result-cancelled')).toHaveCount(1);
  await expect(only).toHaveCount(1);
  await expect(panel.card(INTRO_NAME).locator('.badge-bundled')).toHaveText('同梱');
  await expect(panel.card(replacement.name)).toHaveCount(0);
  await panel.press(panel.importResults().getByRole('button', { name: '結果を閉じる' }));

  // 承認する: 出所が「取り込み」になる
  await panel.importFiles([file]);
  await expect(dialog).toContainText('同梱されたツアーを、取り込んだもので置き換えます');
  await panel.confirm();
  await expect(panel.importResults().locator('.result-ok')).toHaveCount(1);
  await expect(only).toHaveCount(1);
  await expect(panel.card(replacement.name).locator('.badge-imported')).toHaveText('取り込み');
  await expect(panel.card(INTRO_NAME)).toHaveCount(0);

  // 取り込んだものを削除すると、同梱版へ戻る
  await panel.press(panel.card(replacement.name).getByRole('button', { name: '削除' }));
  await panel.confirm();
  await expect(panel.card(INTRO_NAME).locator('.badge-bundled')).toHaveText('同梱');
  await expect(only).toHaveCount(1);
  await expect(panel.card(replacement.name)).toHaveCount(0);
});

test('E-40: origins に含まれないホストを、開く URL や完了ページに書いたツアーは取り込まれず、そのホストへの権限も求められない', async ({
  ext,
  server,
  openPanel,
}) => {
  await spyPermissionRequests(ext.context);
  const panel = await openPanel();
  const steps: StepSpec[] = [{ id: 's1', title: '確認', target: { tourId: 'static-button' } }];

  // 開く URL に origins 外のホスト（127.0.0.1）を書いたツアー
  const openOutside = tourOn(server.origin, { exact: '/static' }, steps, {
    id: 'e2e-open-outside',
    name: '開く URL が範囲外のツアー',
    open: server.url('/static', '127.0.0.1'),
  });
  await panel.importFiles([yamlFile(openOutside)]);
  await expectRejected(panel, `${openOutside.id}.yaml`);
  expect((await errorItems(panel)).some((i) => i.message.includes('origins に含まれていません'))).toBe(true);

  // 完了ページに origins 外のホストを書いたツアー
  const doneOutside = tourOn(
    server.origin,
    { exact: '/static' },
    [
      {
        id: 's1',
        title: '完了ページへ移る',
        done: { type: 'page', url: urlCond(server.altOrigin, { exact: '/static' }) },
      },
    ],
    { id: 'e2e-done-outside', name: '完了ページが範囲外のツアー' },
  );
  await panel.importFiles([yamlFile(doneOutside)]);
  await expectRejected(panel, `${doneOutside.id}.yaml`);
  expect((await errorItems(panel)).some((i) => i.message.includes('origins に含まれていません'))).toBe(true);

  await sleep(500);
  expect(await permissionRequests(panel.page)).toEqual([]);
});

test('E-41: 必須の照合のない対象指定を含むツアーは、取り込まれ、警告が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  const tour = tourOn(
    server.origin,
    { exact: '/static' },
    [{ id: 's1', title: '確認', target: { testId: 'static-button' } }],
    { id: 'e2e-weak-target', name: '警告のあるツアー' },
  );
  await panel.importFiles([yamlFile(tour)]);
  const ok = panel.importResults().locator('.result-ok');
  await expect(ok).toHaveCount(1);
  await expect(ok).toContainText(`「${tour.name}」`);
  const warning = ok.locator('.issue').first();
  await expect(warning.locator('.issue-label')).toHaveText('警告');
  await expect(warning.locator('.issue-path')).toContainText('steps');
  await expect(warning.locator('.issue-message')).toContainText('require か名前の候補を足してください');
  await expect(panel.card(tour.name)).toBeVisible();
});

test('E-42: 説明文の origins 外へのリンクは、ホスト名と宣言外である旨が横に表示され、新しいタブで開く設定になる', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/static'));
  const panel = await openPanel();
  const tour = tourOn(
    server.origin,
    { exact: '/static' },
    [
      {
        id: 's1',
        title: 'リンクを確認する',
        body: `[外部の案内](https://docs.other-site.test/guide) と [宣言内のページ](${server.origin}/static) と [危険な指定](javascript:alert(1))`,
        target: { tourId: 'static-button' },
      },
    ],
    { id: 'e2e-links', name: 'リンクのあるツアー' },
  );
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);

  const links = panel.page.locator('.step-body .markdown a');
  await expect(links).toHaveCount(2);
  const info = await links.evaluateAll((list) =>
    list.map((a) => ({
      href: a.getAttribute('href') ?? '',
      target: a.getAttribute('target') ?? '',
      rel: a.getAttribute('rel') ?? '',
      after: a.nextSibling === null ? '' : (a.nextSibling.textContent ?? ''),
    })),
  );
  const external = info.find((i) => i.href.includes('docs.other-site.test'));
  expect(external?.after).toContain('docs.other-site.test');
  expect(external?.after).toContain('宣言外のサイト');
  expect(external?.target).toBe('_blank');
  expect(external?.rel.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
  const declared = info.find((i) => i.href.startsWith(server.origin));
  expect(declared?.after).toContain('localhost');
  expect(declared?.after).not.toContain('宣言外');
  expect(declared?.target).toBe('_blank');
  // javascript: はリンクにならない
  expect(info.some((i) => i.href.startsWith('javascript:'))).toBe(false);
});

test('E-43: URL 条件が /project の前方一致のステップでは、/project-danger は合わず、/project/settings は合う', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/project'));
  const panel = await openPanel();
  const ui = ownUi(tab);
  const tour = tourOn(
    server.origin,
    { prefix: '/project' },
    [{ id: 's1', title: '送信を確認する', target: { tourId: 'static-button' } }],
    { id: 'e2e-project', name: 'プロジェクトのツアー' },
  );
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
  const mismatch = panel.page.locator('.tab-controls .notice');
  await expect(mismatch).toHaveCount(0);

  // /project-danger は条件に合わない: 表示が消え、別のページを表示している旨が出る
  await tab.goto(server.url('/project-danger'));
  await expect(mismatch).toContainText('別のページを表示しています');
  await expect.poll(() => ui.hostCount()).toBe(0);
  await sleep(1500);
  expect(await ui.hostCount()).toBe(0);

  // /project/settings は合う
  await tab.goto(server.url('/project/settings'));
  await expect(mismatch).toHaveCount(0);
  await expectMiniGuideStep(ui, '1/1');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null).not.toBeNull();
});

/** 容量の上限の確認用。画像（PNG の頭だけ正しい、`imageBytes` ずつ）をたくさん持つ zip のツアー。 */
function weightyTour(origin: string, id: string, imageCount: number, imageBytes: number): ImportFile {
  const steps: StepSpec[] = [];
  const entries: Record<string, string | Uint8Array> = {};
  const image = paddedPng(imageBytes);
  for (let i = 1; i <= imageCount; i++) {
    steps.push({
      id: `s${String(i)}`,
      kind: 'guide',
      title: `画像 ${String(i)}`,
      media: { src: `images/p${String(i)}.png`, alt: `画像 ${String(i)}` },
    });
    entries[`images/p${String(i)}.png`] = image;
  }
  const tour = tourOn(origin, { exact: '/static' }, steps, { id, name: `容量のツアー ${id}` });
  return zipFile(`${id}.zip`, { 'tour.yaml': tourYaml(tour), ...entries });
}

/** 1 つあたり約 45 MB のツアーを 4 つ取り込み、合計を上限（200 MB）の近くまで近づける（残りは約 20 MB）。 */
async function fillNearLimit(panel: SidePanel, origin: string): Promise<void> {
  for (let n = 1; n <= 4; n++) {
    await panel.importFiles([weightyTour(origin, `e2e-fill-${String(n)}`, 9, 5 * MB - 1024)]);
    await expect(panel.importResults().locator('.result-ok')).toHaveCount(1, { timeout: 90_000 });
    await expect(panel.card(`容量のツアー e2e-fill-${String(n)}`)).toBeVisible();
    await panel.press(panel.importResults().getByRole('button', { name: '結果を閉じる' }));
  }
}

test('E-44: 合計容量の上限の近くで複数のツアーを同時に取り込むと、上限を超える分は理由を示して拒否される', async ({
  server,
  openPanel,
}) => {
  test.setTimeout(400_000);
  const panel = await openPanel();
  await fillNearLimit(panel, server.origin);

  // 残りは約 20 MB。1 つ 8 MB のツアーを 3 つ同時に取り込むと、2 つだけ入る
  await panel.importFiles([1, 2, 3].map((n) => weightyTour(server.origin, `e2e-race-${String(n)}`, 2, 4 * MB)));
  const results = panel.importResults();
  await expect(results.locator('.result')).toHaveCount(3, { timeout: 90_000 });
  await expect(results.locator('.result-ok')).toHaveCount(2);
  await expect(results.locator('.result-error')).toHaveCount(1);
  await expect(results.locator('.result-error')).toContainText('合計容量が上限（200 MB）を超えるため、取り込めません');
  // 取り込まれたのは、同梱 1 + 容量 4 + 同時の 2
  await expect(panel.page.locator('li.tour-card')).toHaveCount(7);
});

test('E-45: 取り込み済みの合計容量の上限を超えるツアーは、取り込まれず、上限が表示される', async ({ server, openPanel }) => {
  test.setTimeout(400_000);
  const panel = await openPanel();
  await fillNearLimit(panel, server.origin);

  // 残りの約 20 MB を超える、約 26 MB のツアー
  await panel.importFiles([weightyTour(server.origin, 'e2e-over', 5, 5 * MB - 1024)]);
  const results = panel.importResults();
  await expect(results.locator('.result-error')).toHaveCount(1, { timeout: 90_000 });
  await expect(results.locator('.result-ok')).toHaveCount(0);
  await expect(results.locator('.result-error')).toContainText('上限（200 MB）');
  await expect(panel.card('容量のツアー e2e-over')).toHaveCount(0);
  await expect(panel.page.locator('li.tour-card')).toHaveCount(5);
});

