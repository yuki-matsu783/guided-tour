/**
 * 安全性（AC-69〜73）の E2E。悪意あるファイルの取り込み、正規表現・上限を超える URL 条件、非常に長い URL、
 * ログと保守記録に入力値・ページの文字列・URL・例外のメッセージが残らないこと、ログ・保守記録の上限。
 * 悪意あるファイルは、テストの中で組み立てる（fflate の `zipSync` と文字列）。ページは support/pages/safety-pages.ts。
 */
import { deflateSync } from 'fflate';
import { z } from 'zod';
import { test, expect, ownUi, importTour, beginTour } from './support/fixtures.ts';
import { expectMiniGuideStep, expectNoOwnUi, expectPanelStep, sleep } from './support/flows.ts';
import type { Extension } from './support/launch.ts';
import { openPanel as openPanelOf } from './support/panel.ts';
import type { SidePanel } from './support/panel.ts';
import { MARKERS } from './support/pages/safety-pages.ts';
import { tourOn, tourYaml, yamlFile, zipFile } from './support/tour.ts';
import type { ImportFile, PathCond, TourSpec } from './support/tour.ts';

/** 取り込む1ファイルを選び、拒否された結果の行を返す。 */
async function importRejected(panel: SidePanel, file: ImportFile): Promise<string> {
  await panel.importFiles([file]);
  const failed = panel.importResults().locator('.result-error');
  await expect(failed).toHaveCount(1, { timeout: 30_000 });
  await expect(panel.importResults().locator('.result-ok')).toHaveCount(0);
  const text = (await failed.innerText()).replaceAll(/\s+/g, ' ');
  await panel.press(panel.importResults().getByRole('button', { name: '結果を閉じる' }));
  return text;
}

function validTour(origin: string, extra: Partial<TourSpec> = {}): TourSpec {
  return { ...tourOn(origin, { exact: '/static' }, [{ id: 'only', title: '唯一の手順' }], { id: 'e2e-evil' }), ...extra };
}

/** 移動の操作は、新しい表示が届いてから 500 ミリ秒の間は受け付けられない（製品の仕様）。その分を待つ。 */
const MOVE_WAIT_MS = 600;

const MB = 1024 * 1024;

test('E-69: 画像でない data URL を含むツアーは拒否され、理由が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  const tour = validTour(server.origin);
  const step = { id: 'only', title: '唯一の手順', body: '![x](data:text/html;base64,PGI+eDwvYj4=)' };
  const reason = await importRejected(panel, yamlFile({ ...tour, steps: [step] }));
  expect(reason).toContain('data URL');
});

test('E-69: 巨大に展開される zip は拒否され、理由が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  const reason = await importRejected(
    panel,
    zipFile('bomb.zip', { 'tour.yaml': tourYaml(validTour(server.origin)), 'filler.bin': new Uint8Array(60 * MB) }),
  );
  expect(reason).toContain('展開後の合計サイズが上限');
});

test('E-69: 重複したファイル名を持つ zip は拒否され、理由が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  const tour = { ...validTour(server.origin), steps: [{ id: 'only', title: '唯一の手順', bodyFile: 'a.md' }] };
  const built = zipFile('dup.zip', { 'tour.yaml': tourYaml(tour), 'a.md': '本文 A', 'b.md': '本文 B' });
  // b.md の名前（ローカルヘッダーと中央ディレクトリの両方）を a.md に書き換える
  const bytes = Buffer.from(built.buffer);
  const from = Buffer.from('b.md');
  const to = Buffer.from('a.md');
  for (let at = bytes.indexOf(from); at >= 0; at = bytes.indexOf(from, at + 1)) to.copy(bytes, at);
  const reason = await importRejected(panel, { ...built, buffer: bytes });
  expect(reason).toContain('同じ名前のファイルが複数あります');
});

test('E-69: エイリアスを大量に展開する YAML は拒否され、理由が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  const refs = Array.from({ length: 150 }, () => '*a').join(', ');
  const text = `${tourYaml(validTour(server.origin))}x-anchor: &a [1, 2, 3]\nx-bomb: [${refs}]\n`;
  const reason = await importRejected(panel, yamlFile(text));
  expect(reason).toContain('エイリアスの展開が多すぎます');
});

test('E-69: 重複したキーを持つ YAML は拒否され、理由が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  const text = `${tourYaml(validTour(server.origin))}name: もう1つの名前\n`;
  const reason = await importRejected(panel, yamlFile(text));
  expect(reason).toContain('同じキーが重複しています');
});

/** 幅・高さだけが巨大な、ヘッダーだけの小さい PNG。 */
function hugePng(side: number): Uint8Array {
  const ihdr = new Uint8Array(25);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 13);
  ihdr.set([0x49, 0x48, 0x44, 0x52], 4);
  view.setUint32(8, side);
  view.setUint32(12, side);
  ihdr.set([8, 6, 0, 0, 0], 16);
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const idat = deflateSync(new Uint8Array(1));
  const out = new Uint8Array(signature.length + ihdr.length + idat.length);
  out.set(signature, 0);
  out.set(ihdr, signature.length);
  out.set(idat, signature.length + ihdr.length);
  return out;
}

test('E-69: 寸法が巨大な小さい画像を含む zip は拒否され、理由が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  const tour = {
    ...validTour(server.origin),
    steps: [{ id: 'only', title: '唯一の手順', media: { src: 'big.png', alt: '大きな画像' } }],
  };
  const reason = await importRejected(panel, zipFile('huge-image.zip', { 'tour.yaml': tourYaml(tour), 'big.png': hugePng(60_000) }));
  expect(reason).toMatch(/画像/);
  expect(reason).toMatch(/4096|画素|大き/);
});

test('E-69: 大量のファイルを含む zip は拒否され、理由が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  const entries: Record<string, string> = { 'tour.yaml': tourYaml(validTour(server.origin)) };
  for (let i = 0; i < 520; i++) entries[`docs/f${String(i)}.md`] = '本文';
  const reason = await importRejected(panel, zipFile('many.zip', entries));
  expect(reason).toContain('ファイル数が上限');
});

test('E-69: 重い取り込みの最中も、サイドパネルの一時中断・終了の操作を受け付ける（取り込み中の画面操作は手動で補う）', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url('/internal/'));
  const panel = await openPanel();
  const tour = tourOn(server.origin, { prefix: '/internal' }, [{ id: 'only', title: '唯一の手順' }], { id: 'e2e-running', name: '実行中のツアー' });
  await importTour(panel, tour);
  // 実行中の画面には取り込み画面が無いので、一覧にいる間に重い取り込みを始め、そのまま実行を始める
  const bomb = zipFile('bomb.zip', { 'tour.yaml': tourYaml(validTour(server.origin)), 'filler.bin': new Uint8Array(60 * MB) });
  await panel.importFiles([bomb, bomb, bomb]);
  await beginTour(panel, tour.name, tab);
  const started = Date.now();
  await panel.pause();
  await expect(panel.page.locator('.screen-paused')).toBeVisible();
  await expectNoOwnUi(ownUi(tab), 300);
  await panel.resumePaused();
  await expect(panel.page.locator('.screen-running')).toBeVisible();
  await panel.stop();
  await expect(panel.page.getByRole('status').filter({ hasText: 'ツアーを終了しました' })).toBeVisible();
  // 取り込みで固まらず、操作がすぐに受け付けられた
  expect(Date.now() - started).toBeLessThan(20_000);
  expect((await ext.storageSession('tour')) !== undefined).toBe(true);
});

/** URL 条件に `path` を持つツアーを取り込もうとして、拒否の理由を返す。 */
async function rejectedPath(panel: SidePanel, origin: string, path: PathCond, id: string): Promise<string> {
  const tour = tourOn(origin, path, [{ id: 'only', title: '唯一の手順' }], { id, open: `${origin}/static` });
  return importRejected(panel, yamlFile(tour));
}

test('E-70: 正規表現を書いたツアーは取り込まれず、理由が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  expect(await rejectedPath(panel, server.origin, { glob: '/tokens/(new|edit)' }, 'e2e-regex-1')).toContain('正規表現は使えません');
  expect(await rejectedPath(panel, server.origin, { exact: '/tokens/[0-9]+' }, 'e2e-regex-2')).toContain('正規表現は使えません');
  expect(await rejectedPath(panel, server.origin, { prefix: '/a.*$' }, 'e2e-regex-3')).toContain('正規表現は使えません');
});

test('E-70: 上限を超える長さ・区間数・** の個数の URL 条件を書いたツアーは取り込まれず、理由が表示される', async ({ server, openPanel }) => {
  const panel = await openPanel();
  expect(await rejectedPath(panel, server.origin, { prefix: `/${'a'.repeat(201)}` }, 'e2e-long-1')).toContain('200文字以内');
  expect(await rejectedPath(panel, server.origin, { prefix: `/${Array.from({ length: 33 }, () => 'a').join('/')}` }, 'e2e-long-2')).toContain(
    '32区間以内',
  );
  expect(await rejectedPath(panel, server.origin, { glob: '/**/a/**/b/**/c/**/d/**' }, 'e2e-long-3')).toContain('** は4個まで');
});

/** 非常に長い URL（区間が多い）。 */
function longUrlPath(): string {
  return `/long/${'a/'.repeat(100)}b/${'a/'.repeat(100)}q`;
}

test('E-71: 非常に長い URL のページで、** を複数使った URL 条件のツアーを実行しても、「終了」が受け付けられる', async ({
  server,
  openTab,
  openPanel,
}) => {
  const tab = await openTab(server.url(longUrlPath()));
  const panel = await openPanel();
  const tour = tourOn(
    server.origin,
    { glob: '/long/**/a/**/b/**/a/**/q' },
    [{ id: 'only', title: '長い URL の手順', target: { tourId: 'long-button', fallbackText: 'ボタンが対象です' } }],
    { id: 'e2e-long-url', name: '長い URL のツアー', open: server.url(longUrlPath()) },
  );
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ownUi(tab), '1/1');

  // 終了の操作が、制限時間内に受け付けられる
  await panel.stop();
  await expect(panel.page.getByRole('status').filter({ hasText: 'ツアーを終了しました' })).toBeVisible({ timeout: 10_000 });
  await expectNoOwnUi(ownUi(tab), 300);
});

test('E-71: 非常に長い URL が条件に合わない場合も、画面は応答し、「終了」が受け付けられる', async ({ server, openTab, openPanel }) => {
  const tab = await openTab(server.url(`/long/${'a/'.repeat(250)}x`));
  const panel = await openPanel();
  const tour = tourOn(
    server.origin,
    { prefix: '/long' },
    [
      {
        id: 'only',
        title: '長い URL の手順',
        url: { origin: server.origin, path: { glob: '/long/**/a/**/b/**/a/**/z' } },
        target: { tourId: 'long-button', fallbackText: 'ボタンが対象です' },
      },
    ],
    { id: 'e2e-long-url-2', name: '長い URL（不一致）のツアー', open: server.url('/long/start') },
  );
  await importTour(panel, tour);
  // 長い URL のタブはステップの条件に合わないので、タブの対応付けの候補には出ない。開始のあと、そのまま終了する
  await tab.bringToFront();
  await panel.start(tour.name);
  await expect(panel.page.locator('.screen-running')).toBeVisible();
  await expectPanelStep(panel, '1/1');
  await panel.stop();
  await expect(panel.page.getByRole('status').filter({ hasText: 'ツアーを終了しました' })).toBeVisible({ timeout: 10_000 });
});

const ExportSchema = z.object({ logs: z.string(), diagnostics: z.string() }).loose();

test('E-72: 詳細ログでツアーを実施しても、ログ・コンソール・書き出したファイルに、入力値・ページの文字列・URL・例外のメッセージが残らない', async ({
  ext,
  server,
  openTab,
  openPanel,
}) => {
  test.setTimeout(120_000);
  const consoleTexts: string[] = [];
  ext.context.on('console', (message) => {
    consoleTexts.push(message.text());
  });
  ext.context.on('weberror', (error) => {
    consoleTexts.push(error.error().message);
  });

  const path = `/safety/token-${MARKERS.urlPath}`;
  const tab = await openTab(`${server.url(path)}?token=${MARKERS.urlQuery}#${MARKERS.urlFragment}`);
  const panel = await openPanel();
  const ui = ownUi(tab);

  // ログレベルを「詳細」にする
  await panel.openSettings();
  await panel.page.getByLabel('ログレベル').selectOption('debug');
  await expect.poll(async () => JSON.stringify(await ext.storageLocal('settings'))).toContain('"debug"');
  await panel.backToList();

  const tour = tourOn(
    server.origin,
    { prefix: '/safety' },
    [
      {
        id: 's1',
        title: 'トークン名を入力する',
        target: { tourId: 't-name', fallbackText: 'トークン名の欄が対象です' },
        done: { type: 'state', state: 'filled', target: { tourId: 't-name' }, hint: '名前を入力してください', doneHint: '入力できました' },
      },
      {
        id: 's2',
        title: 'パスワード欄を確認する',
        target: { tourId: 't-pass', fallbackText: 'パスワード欄が対象です' },
        done: { type: 'state', state: 'filled', target: { tourId: 't-pass' }, hint: '入力してください', doneHint: '入力できました' },
      },
      {
        id: 's3',
        title: '書式の誤った指定',
        target: { css: [`div[data-x=${MARKERS.exception}`], fallbackText: '対象が見つからない案内です' },
      },
      {
        id: 's4',
        title: '発行する',
        target: { tourId: 't-submit', name: ['発行'], fallbackText: '発行ボタンが対象です' },
      },
    ],
    { id: 'e2e-privacy', name: '個人情報を含まないツアー', open: server.url(path) },
  );
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  await expectMiniGuideStep(ui, '1/4');
  await expect(panel.hintText()).toContainText('次へ進めます');

  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '2/4');
  await expect(panel.hintText()).toContainText('この項目は確認できません');
  await sleep(1500);
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '3/4');
  await sleep(3000);
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectPanelStep(panel, '4/4');
  await expect.poll(async () => (await ui.overlay())?.frame ?? null, { timeout: 15_000 }).not.toBeNull();

  // 収集の経路が働いていることの確認（ここで書く文字列は目印ではない）
  const worker = await ext.worker();
  await worker.evaluate(() => {
    console.log('E2E-PROBE-SW');
  });
  await tab.evaluate(() => {
    console.log('E2E-PROBE-PAGE');
  });
  await panel.page.evaluate(() => {
    console.log('E2E-PROBE-PANEL');
  });
  await expect.poll(() => consoleTexts.join('\n')).toContain('E2E-PROBE-SW');
  expect(consoleTexts.join('\n')).toContain('E2E-PROBE-PAGE');
  expect(consoleTexts.join('\n')).toContain('E2E-PROBE-PANEL');

  // ログがまとめて書かれるのを待ってから、書き出す
  await sleep(2500);
  await panel.stop();
  await panel.openSettings();
  await panel.press(panel.page.getByRole('button', { name: 'ログと保守記録を書き出す' }));
  await expect(panel.page.getByRole('status').filter({ hasText: 'ログと保守記録をファイルに保存しました' })).toBeVisible();
  const exported = ExportSchema.parse(await panel.page.evaluate(() => chrome.runtime.sendMessage({ type: 'EXPORT_LOGS' })));

  // 検査が空振りでないこと: 詳細ログが書き出されている
  const lines = exported.logs.split('\n').filter((l) => l !== '');
  expect(lines.length).toBeGreaterThan(5);
  // 詳細ログの設定なら、探索の結果（debug）が書き出される。落ちても、下の目印の検査は続ける
  expect.soft(exported.logs).toContain('"event":"locator.result"');

  const everything = [exported.logs, exported.diagnostics, JSON.stringify(await ext.storageLocal()), consoleTexts.join('\n')].join('\n');
  for (const [name, mark] of Object.entries(MARKERS)) {
    expect(everything.includes(mark), `${name} の目印がログ・書き出し・コンソールに残っている`).toBe(false);
  }
});

/** IndexedDB の `logs` と `diagnostics` に、上限を超える数の記録を書き込む（古い日付のログを含む）。 */
async function prefillRecords(ext: Extension): Promise<void> {
  const worker = await ext.worker();
  await worker.evaluate(
    async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('guided-tour');
        open.onsuccess = () => {
          resolve(open.result);
        };
        open.onerror = () => {
          reject(new Error('open failed'));
        };
      });
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const tx = db.transaction(['logs', 'diagnostics'], 'readwrite');
      const logs = tx.objectStore('logs');
      for (let i = 0; i < 2400; i++) {
        const old = i < 500;
        logs.add({ ts: old ? now - 40 * day - i : now - 5000 + i, level: 'info', ctx: 'background', event: 'e2e.fill', fields: {} });
      }
      const diagnostics = tx.objectStore('diagnostics');
      for (let i = 0; i < 1100; i++) {
        diagnostics.put({
          tourId: `old-tour-${String(i)}`,
          stepId: 's',
          reason: 'missing',
          tier: null,
          topTier: null,
          counts: [],
          total: 1,
          lastAt: now - 3 * day + i,
          lastKey: 'k',
        });
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(new Error('tx failed'));
        };
        tx.onabort = () => {
          reject(new Error('tx aborted'));
        };
      });
      db.close();
    },
  );
}

const CountsSchema = z.object({ logs: z.number(), oldestLog: z.number().nullable(), diagnostics: z.number(), hasFirstDiagnostic: z.boolean() });

async function readCounts(ext: Extension): Promise<z.output<typeof CountsSchema>> {
  const worker = await ext.worker();
  const raw: unknown = await worker.evaluate(async () => {
    const request = <T>(r: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        r.onsuccess = () => {
          resolve(r.result);
        };
        r.onerror = () => {
          reject(new Error('request failed'));
        };
      });
    const db = await request<IDBDatabase>(indexedDB.open('guided-tour'));
    const tx = db.transaction(['logs', 'diagnostics'], 'readonly');
    const logs = await request(tx.objectStore('logs').count());
    const first: unknown[] = await request(tx.objectStore('logs').index('ts').getAll(undefined, 1));
    const diagnostics = await request(tx.objectStore('diagnostics').count());
    const firstDiagnostic: unknown = await request(tx.objectStore('diagnostics').get(['old-tour-0', 's', 'missing']));
    db.close();
    const head: unknown = first[0];
    const oldest: unknown = typeof head === 'object' && head !== null ? Reflect.get(head, 'ts') : undefined;
    return { logs, oldestLog: typeof oldest === 'number' ? oldest : null, diagnostics, hasFirstDiagnostic: firstDiagnostic !== undefined };
  });
  return CountsSchema.parse(raw);
}

test('E-73: 上限を超える記録を保存領域に書いてから起動すると、ログは2,000件・30日、保守記録は1,000件に収まる（件数・期間の削除は単体で補う）', async ({
  ext,
  server,
  openPanel,
}) => {
  test.setTimeout(120_000);
  // 保存領域ができるように、ツアーを1つ取り込んでおく
  const panel = await openPanel();
  await importTour(panel, tourOn(server.origin, { exact: '/static' }, [{ id: 'only', title: '唯一の手順' }], { id: 'e2e-fill', name: '詰めるツアー' }));
  await prefillRecords(ext);
  const before = await readCounts(ext);
  expect(before.logs).toBeGreaterThan(2000);
  expect(before.diagnostics).toBeGreaterThan(1000);

  // 起動し直すと、ログは30日より古いものが消え、2,000件以内になる
  const restarted = await ext.restart();
  await expect
    .poll(async () => {
      const counts = await readCounts(restarted);
      return counts.logs <= 2000 && (counts.oldestLog ?? Date.now()) > Date.now() - 30 * 24 * 60 * 60 * 1000;
    }, { timeout: 30_000 })
    .toBe(true);

  // 保守記録は、新しい記録が加わるとき、古いものから消えて1,000件に収まる
  const tab = await restarted.openTab(server.url('/loc/guard-name'));
  const panel2 = await openPanelOf(restarted);
  const tour = tourOn(server.origin, { exact: '/loc/guard-name' }, [
    { id: 'only', title: '矛盾する手順', target: { tourId: 'g-target', require: { name: ['保存'] }, fallbackText: '案内です' } },
  ], { id: 'e2e-diag', name: '保守記録を作るツアー' });
  await importTour(panel2, tour);
  await beginTour(panel2, tour.name, tab);
  await expect
    .poll(async () => {
      const counts = await readCounts(restarted);
      return counts.diagnostics <= 1000 && !counts.hasFirstDiagnostic;
    }, { timeout: 30_000 })
    .toBe(true);
  expect((await readCounts(restarted)).logs).toBeLessThanOrEqual(2200);
});
