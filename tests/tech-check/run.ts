/**
 * 設計書「実装の最初に行う技術検証」6 項目を、Playwright で読み込んだ Chromium 実機で確かめる。
 * 実行: node --experimental-strip-types tests/tech-check/run.ts
 * （項目 5 の実キー入力は DISPLAY が必要。`xvfb-run -a` を付けると試みる）
 * 結果は標準出力と docs/tmp/tech-check-result.md に出す。
 */
import { chromium } from 'playwright';
import type { BrowserContext, Worker } from 'playwright';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { buildTechCheck } from './build.ts';
import { honestZip, lyingZip, zeroZip } from './fixtures.ts';
import type { BlobSummary } from './src/idb.ts';
import { IMPACT } from './impact.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const MB = 1024 * 1024;

type Verdict = '成立' | '不成立' | '確かめられない';
interface Check { what: string; verdict: Verdict | '参考'; observed: string }
interface Item { no: number; title: string; verdict: Verdict; summary: string; checks: Check[]; notes: string[] }
const items: Item[] = [];
const env: Record<string, string> = {};

function startItem(no: number, title: string): Item {
  const item: Item = { no, title, verdict: '確かめられない', summary: '', checks: [], notes: [] };
  items.push(item);
  return item;
}
function check(item: Item, what: string, verdict: Check['verdict'], observed: unknown): void {
  const text = typeof observed === 'string' ? observed : JSON.stringify(observed);
  item.checks.push({ what, verdict, observed: text });
  console.log(`  [${String(item.no)}] ${verdict} | ${what} | ${text}`);
}
function finish(item: Item, verdict: Verdict, summary: string): void {
  item.verdict = verdict;
  item.summary = summary;
  console.log(`== 項目${String(item.no)} ${item.title}: ${verdict} - ${summary}`);
}

// ---- テスト用ページ ----
const PAGES: Record<string, string> = {
  '/a.html': '<!doctype html><title>a</title><body><h1>page a</h1><input id="i" autofocus>',
  '/b.html': '<!doctype html><title>b</title><body><h1>page b</h1>',
  '/c.html': '<!doctype html><title>c</title><body><h1>frame c</h1>',
  '/frames.html': '<!doctype html><title>frames</title><body><h1>frames</h1><iframe src="/c.html"></iframe>',
  '/shadow.html': '<!doctype html><title>shadow</title><body><h1>shadow</h1><p>text</p>',
  '/vis.html': `<!doctype html><title>vis</title><body>
<div style="opacity:0"><span id="opacity0-ancestor">x</span></div>
<div style="opacity:0"><span id="opacity0-ancestor-child-opacity1" style="opacity:1">x</span></div>
<div id="opacity0-self" style="opacity:0">x</div>
<div style="opacity:0.01"><span id="opacity-0.01-ancestor">x</span></div>
<div style="visibility:hidden"><span id="visibility-hidden-ancestor">x</span></div>
<div style="visibility:hidden"><span id="visibility-hidden-ancestor-child-visible" style="visibility:visible">x</span></div>
<div id="visibility-hidden-self" style="visibility:hidden">x</div>
<div style="display:none"><span id="display-none-ancestor">x</span></div>
<div id="display-none-self" style="display:none">x</div>
<div style="display:contents"><span id="display-contents-ancestor">x</span></div>
<span id="display-contents-self" style="display:contents">x</span>
<div style="content-visibility:hidden"><span id="content-visibility-hidden-ancestor">x</span></div>
<div id="plain">x</div>`,
};

function startServer(): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const body = PAGES[req.url?.split('?')[0] ?? ''];
      if (body === undefined) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, origin: `http://localhost:${String(port)}` });
    });
  });
}

// ---- 共通の補助 ----
const LogEntry = z.object({ kind: z.string(), data: z.record(z.string(), z.unknown()) });
type LogEntry = z.infer<typeof LogEntry>;

async function launch(dir: string, headless: boolean): Promise<{ ctx: BrowserContext; id: string }> {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const id = new URL(sw.url()).host;
  return { ctx, id };
}

async function getSw(ctx: BrowserContext): Promise<Worker> {
  return ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
}

async function readLogs(ctx: BrowserContext): Promise<LogEntry[]> {
  const sw = await getSw(ctx);
  const raw = await sw.evaluate(async (): Promise<[string, unknown][]> => {
    const all: Record<string, unknown> = await chrome.storage.session.get(null);
    return Object.entries(all).filter(([k]) => k.startsWith('log:')).sort(([a], [b]) => a.localeCompare(b));
  });
  return raw.map(([, v]) => LogEntry.parse(v));
}

async function waitLogs(ctx: BrowserContext, kind: string, count: number): Promise<LogEntry[]> {
  for (let i = 0; i < 50; i++) {
    const logs = (await readLogs(ctx)).filter((l) => l.kind === kind);
    if (logs.length >= count) return logs;
    await new Promise((r) => setTimeout(r, 100));
  }
  return (await readLogs(ctx)).filter((l) => l.kind === kind);
}

async function clearLogs(ctx: BrowserContext): Promise<void> {
  const sw = await getSw(ctx);
  await sw.evaluate(() => chrome.storage.session.clear());
}

async function inject(ctx: BrowserContext, pattern: string, file: string, allFrames: boolean): Promise<void> {
  const sw = await getSw(ctx);
  await sw.evaluate(
    async ({ pattern, file, allFrames }) => {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const t of tabs) {
        if (t.id !== undefined) await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames }, files: [file] });
      }
    },
    { pattern, file, allFrames },
  );
}

/** content script が送ったメッセージ本体（type 以外の項目）。 */
function msgOf(l: LogEntry): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(l.data.message);
}

function senderOf(l: LogEntry): { documentId: unknown; frameId: unknown; tabId: unknown; url: unknown; documentLifecycle: unknown } {
  const s = z.object({ documentId: z.unknown(), frameId: z.unknown(), tabId: z.unknown(), url: z.unknown(), documentLifecycle: z.unknown() })
    .parse(l.data.sender);
  return s;
}

// ---- 項目 1 ----
async function item1(ctx: BrowserContext, id: string): Promise<void> {
  const it = startItem(1, 'IndexedDB の Blob をサイドパネルとバックグラウンドで共有');
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/panel.html`);
  it.notes.push('サイドパネルを直接開く手段が Playwright にないため、`chrome-extension://<id>/panel.html` をタブで開いて代用した（同じ拡張機能のページ・同じオリジン）。実際のサイドパネルのビューでは確かめていない。');
  const sw = await getSw(ctx);

  const written = await panel.evaluate((): Promise<BlobSummary> => window.techCheck.write('k-panel', 5 * 1024 * 1024));
  check(it, 'パネルが 5 MB の Blob を IndexedDB に書く', '参考', written);
  const bySw = await sw.evaluate((): Promise<BlobSummary | null> => globalThis.techCheckRead('k-panel'));
  const same = bySw !== null && bySw.size === written.size && bySw.checksum === written.checksum && bySw.type === written.type;
  check(it, 'Service Worker が同じ Blob を読めて、サイズ・型・内容（先頭と合計）が一致する', same ? '成立' : '不成立', bySw);
  const byPanel = await panel.evaluate((): Promise<BlobSummary | null> => window.techCheck.read('k-panel'));
  check(it, 'パネル自身も読める', byPanel?.checksum === written.checksum ? '成立' : '不成立', byPanel);

  const writtenBySw = await sw.evaluate((): Promise<BlobSummary> => globalThis.techCheckWrite('k-sw', 1024 * 1024));
  const readByPanel = await panel.evaluate((): Promise<BlobSummary | null> => window.techCheck.read('k-sw'));
  check(it, '逆向き: Service Worker が書いた Blob をパネルが読める', readByPanel?.checksum === writtenBySw.checksum ? '成立' : '不成立', { writtenBySw, readByPanel });

  const swUrl = await sw.evaluate(() => typeof URL.createObjectURL);
  const panelUrl = await panel.evaluate(() => window.techCheck.createObjectUrl('k-panel'));
  check(it, '制約表の前提: Service Worker に URL.createObjectURL は無く、パネルでは使える', swUrl === 'undefined' && panelUrl?.startsWith('blob:chrome-extension://') ? '成立' : '不成立', { swTypeofCreateObjectURL: swUrl, panelUrl });
  await panel.close();
  const ok = same && byPanel?.checksum === written.checksum && readByPanel?.checksum === writtenBySw.checksum;
  finish(it, ok ? '成立' : '不成立', ok ? '両方向で読み書きできた。ただしパネルはタブで代用' : '共有できなかった');
}

// ---- 項目 2 ----
async function item2(ctx: BrowserContext, id: string): Promise<void> {
  const it = startItem(2, 'fflate の逐次展開（Unzip + UnzipInflate）を上限で打ち切る');
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/panel.html`);
  it.notes.push('実行場所は拡張機能のページ（タブで代用。項目 1 と同じ）。UnzipFile.terminate は同期の UnzipInflate では実質何もしないため、「以降の push をやめる」ことで打ち切る。');
  const LIMIT = 50 * MB;
  const bomb = zeroZip(100 * MB);
  const lie = lyingZip(100 * MB, 1024);
  const honest = honestZip();
  env['zip-bomb(100MB zeros)'] = `${String(bomb.length)} バイト（圧縮率 ${String(Math.round((100 * MB) / bomb.length))}:1）`;
  env['zip-lie(宣言 1024)'] = `${String(lie.length)} バイト`;
  const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
  const run = (zip: Uint8Array, limit: number, chunk: number) =>
    panel.evaluate(({ z, limit, chunk }) => window.techCheck.unzip(z, limit, chunk), { z: b64(zip), limit, chunk });

  const ctrl = await run(honest.zip, LIMIT, 16 * 1024);
  check(it, '対照: 正直な 3 MB の zip は打ち切られず、合計 3 MB を数える', !ctrl.aborted && ctrl.counted === honest.total ? '成立' : '不成立', ctrl);

  let allAborted = true;
  for (const [label, zip] of [['高圧縮（宣言どおり 100 MB）', bomb], ['宣言サイズを 1024 と偽った 100 MB', lie]] as const) {
    for (const chunk of [1024, 4096, 16 * 1024, 64 * 1024, 1024 * 1024]) {
      const r = await run(zip, LIMIT, chunk);
      const stoppedEarly = r.aborted && r.pushedCompressed < zip.length;
      if (chunk <= 16 * 1024 && !stoppedEarly) allAborted = false;
      check(
        it,
        `${label} / 圧縮側を ${String(chunk)} バイトずつ push、上限 50 MB`,
        r.aborted ? '成立' : '不成立',
        { aborted: r.aborted, 数えた展開バイト: r.counted, 上限超過分: r.counted - LIMIT, 最大ondata: r.maxOndata, push回数: r.pushes, push済み圧縮バイト: r.pushedCompressed, 宣言: r.declared, errors: r.errors, ms: r.ms },
      );
    }
  }
  await panel.close();
  finish(
    it,
    allAborted ? '成立' : '不成立',
    '合計が上限を超えた時点で以降の push をやめて打ち切れる。宣言サイズは偽れるので使えない。1 回の push の展開量は圧縮側のチャンクサイズに比例して膨らむ（観測値の表を参照）',
  );
}

// ---- 項目 3 ----
async function item3(ctx: BrowserContext, origin: string): Promise<void> {
  const it = startItem(3, 'sender.documentId の取得と、遷移での変化');
  const page = await ctx.newPage();
  env.userAgent = await page.evaluate(() => navigator.userAgent);
  const pattern = 'http://localhost/*';
  const hello = async (n: number, allFrames = false) => {
    await inject(ctx, pattern, 'content-doc.js', allFrames);
    return (await waitLogs(ctx, 'doc-hello', n)).map(senderOf);
  };

  await page.goto(`${origin}/a.html`);
  const afterA = await hello(1);
  check(it, '/a.html にコンテンツスクリプトを executeScript で組み込み、onMessage の sender を読む', afterA[0]?.documentId ? '成立' : '不成立', afterA[0]);

  await page.goto(`${origin}/b.html`);
  const afterB = await hello(2);
  check(it, '同じタブで /b.html へ遷移して再度組み込む', afterB[1]?.documentId !== afterA[0]?.documentId && afterB[1]?.tabId === afterA[0]?.tabId ? '成立' : '不成立', { a: afterA[0]?.documentId, b: afterB[1]?.documentId, 同じtabId: afterB[1]?.tabId === afterA[0]?.tabId });

  await page.reload();
  const afterR = await hello(3);
  check(it, '同じ URL の再読み込みでも documentId が変わる', afterR[2]?.documentId !== afterB[1]?.documentId ? '成立' : '不成立', { before: afterB[1]?.documentId, after: afterR[2]?.documentId });

  await page.evaluate(() => { history.pushState({}, '', '/pushed'); });
  const afterP = await hello(4);
  check(it, '同じ文書内の URL 変更（pushState）では documentId が変わらない', afterP[3]?.documentId === afterR[2]?.documentId ? '成立' : '不成立', { before: afterR[2]?.documentId, after: afterP[3]?.documentId });
  const pushLog = (await waitLogs(ctx, 'doc-hello', 4))[3];
  check(it, '参考: pushState 直後の sender.url と、文書自身が報告した location.href（sender.url が遅れるか）', '参考', { senderUrl: afterP[3]?.url, href: pushLog ? msgOf(pushLog).href : null });
  await new Promise((r) => setTimeout(r, 500));
  const afterP2 = await hello(5);
  check(it, '参考: 500ms 待ってもう一度組み込んだときの sender.url と documentId', '参考', { senderUrl: afterP2[4]?.url, documentId: afterP2[4]?.documentId });

  await page.goto(`${origin}/frames.html`);
  const afterF = await hello(6 + 1, true);
  const frameEntries = afterF.slice(5);
  const ids = new Set(frameEntries.map((e) => e.documentId));
  check(it, 'iframe 付きの文書に allFrames で組み込むと、フレームごとに別の documentId になる', frameEntries.length === 2 && ids.size === 2 ? '成立' : '不成立', frameEntries);
  check(it, 'documentLifecycle の値', '参考', afterF.map((e) => e.documentLifecycle));
  await page.close();
  const ok = Boolean(afterA[0]?.documentId) && afterB[1]?.documentId !== afterA[0]?.documentId;
  finish(it, ok ? '成立' : '不成立', `実機（${env.userAgent}）で documentId を取得でき、別の文書への遷移・再読み込みで変わり、pushState では変わらない。Chrome 114 での可否は未実測（推定を別に記す）`);
}

// ---- 項目 4 ----
async function item4(ctx: BrowserContext, origin: string): Promise<void> {
  const it = startItem(4, 'checkVisibility の指定の名前（新旧）と各ケースの結果');
  const page = await ctx.newPage();
  await page.goto(`${origin}/vis.html`);
  const optionSets: Record<string, Record<string, boolean>> = {
    指定なし: {},
    旧名のみ: { checkOpacity: true, checkVisibilityCSS: true },
    新名のみ: { opacityProperty: true, visibilityProperty: true },
    新旧の両方: { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true },
    'opacity系のみ（新）': { opacityProperty: true },
    'visibility系のみ（新）': { visibilityProperty: true },
    'opacity系のみ（旧）': { checkOpacity: true },
    'visibility系のみ（旧）': { checkVisibilityCSS: true },
  };
  const result = await page.evaluate(
    ({ optionSets }) => {
      const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id);
      const table: Record<string, Record<string, boolean>> = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const row: Record<string, boolean> = { 'getClientRects>0': el.getClientRects().length > 0 };
        for (const [name, opts] of Object.entries(optionSets)) row[name] = el.checkVisibility(opts);
        table[id] = row;
      }
      // 辞書のどのメンバーを読みに行くかを、getter で観測する
      const read: string[] = [];
      const probe = {};
      for (const k of ['checkOpacity', 'checkVisibilityCSS', 'opacityProperty', 'visibilityProperty', 'contentVisibilityAuto', 'someUnknownKey']) {
        Object.defineProperty(probe, k, { get: () => { read.push(k); return false; }, enumerable: true });
      }
      document.getElementById('plain')?.checkVisibility(probe);
      return { table, read, hasFn: typeof Element.prototype.checkVisibility };
    },
    { optionSets },
  );
  check(it, 'Element.prototype.checkVisibility がある', result.hasFn === 'function' ? '成立' : '不成立', result.hasFn);
  check(it, '辞書として読みに行くメンバー（getter で観測）', '参考', result.read);
  const oldNames = result.read.includes('checkOpacity') && result.read.includes('checkVisibilityCSS');
  const newNames = result.read.includes('opacityProperty') && result.read.includes('visibilityProperty');
  check(it, '旧名・新名の両方が辞書のメンバーとして認識される', oldNames && newNames ? '成立' : '不成立', { 旧名: oldNames, 新名: newNames });
  for (const [id, row] of Object.entries(result.table)) check(it, `要素 #${id}`, '参考', row);

  const t = result.table;
  const both = '新旧の両方';
  const get = (id: string, col: string): boolean | undefined => t[id]?.[col];
  const design =
    get('opacity0-ancestor', both) === false && get('visibility-hidden-self', both) === false &&
    get('display-none-ancestor', both) === false && get('plain', both) === true;
  const sameOldNew = Object.values(t).every((r) => r['旧名のみ'] === r['新名のみ'] && r['旧名のみ'] === r[both]);
  check(it, '新旧どちらの名前でも、全要素で結果が同じ', sameOldNew ? '成立' : '不成立', sameOldNew);
  await page.close();
  finish(it, oldNames && newNames && sameOldNew && design ? '成立' : '不成立', '新旧の名前の両方を渡しても受理され、結果は同じ。各ケースの結果は観測値の表を参照');
}

// ---- 項目 6 ----
async function item6(ctx: BrowserContext, origin: string): Promise<void> {
  const it = startItem(6, '閉じた Shadow DOM のボタンに、ページから操作を届けられないこと・isTrusted');
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    // ページ側の攻撃: attachShadow を先に差し替えて、閉じた root を横取りしようとする。結果は属性に残す
    const orig: unknown = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow')?.value;
    if (typeof orig !== 'function') throw new Error('attachShadow が無い');
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const r: unknown = Reflect.apply(orig, this, [init]);
      if (!(r instanceof ShadowRoot)) throw new Error('ShadowRoot でない');
      const el = document.documentElement;
      el.dataset.stolen = String(Number(el.dataset.stolen ?? '0') + 1);
      return r;
    };
    window.addEventListener('click', (e) => {
      const path = e.composedPath();
      document.documentElement.dataset.pageSaw = JSON.stringify({
        isTrusted: e.isTrusted,
        targetTag: e.target instanceof Element ? e.target.tagName : null,
        pathHasButton: path.some((n) => n instanceof HTMLButtonElement),
      });
    }, true);
  });
  await page.goto(`${origin}/shadow.html`);
  await inject(ctx, 'http://localhost/*', 'content-shadow.js', false);
  await waitLogs(ctx, 'shadow-ready', 1);
  await clearLogs(ctx);

  const attempt = await page.evaluate(() => {
    const host = document.getElementById('tour-host');
    if (!host) return null;
    const r = host.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const stolen = Number(document.documentElement.dataset.stolen ?? '0');
    return {
      shadowRootProp: host.shadowRoot === null ? 'null' : 'あり',
      pageQuerySelectorButtons: document.querySelectorAll('button').length,
      hostQueryButton: host.querySelector('button') === null ? 'null' : 'あり',
      elementFromPointIsHost: hit === host,
      hitHasShadowRoot: hit?.shadowRoot ?? null,
      attachShadowHookCaught: stolen,
    };
  });
  check(it, 'ページのスクリプトからは、閉じた root もボタンも見えない（shadowRoot・querySelector・elementFromPoint・attachShadow の差し替え）', attempt?.shadowRootProp === 'null' && attempt.pageQuerySelectorButtons === 0 && attempt.attachShadowHookCaught === 0 ? '成立' : '不成立', attempt);

  await page.evaluate(() => {
    const host = document.getElementById('tour-host');
    host?.click();
    host?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    host?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  const forged = await readLogs(ctx);
  const forgedButton = forged.filter((l) => l.kind === 'shadow-button-click');
  const forgedHost = forged.filter((l) => l.kind.startsWith('shadow-host'));
  check(it, 'ページが host.click() と dispatchEvent（click・pointerdown）を送ると、ボタンのハンドラは呼ばれない', forgedButton.length === 0 ? '成立' : '不成立', { ボタンに届いた回数: forgedButton.length });
  check(it, 'ホスト要素にだけ届いたイベントの isTrusted は偽', forgedHost.length > 0 && forgedHost.every((l) => msgOf(l).isTrusted === false) ? '成立' : '不成立', forgedHost.map((l) => ({ kind: l.kind, ...msgOf(l) })));

  await clearLogs(ctx);
  const box = await page.locator('#tour-host').boundingBox();
  if (!box) throw new Error('host の位置を取れない');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const real = await waitLogs(ctx, 'shadow-button-click', 1);
  const realHost = (await readLogs(ctx)).filter((l) => l.kind === 'shadow-host-click');
  check(it, 'Playwright の実クリック（page.mouse.click）がボタンに届き、isTrusted は真', real.length === 1 && (real[0] ? msgOf(real[0]).isTrusted : undefined) === true ? '成立' : '不成立', real.map((l) => msgOf(l)));
  check(it, '同じクリックがホストにも伝わり、target はホストに付け替わる（isTrusted は真）', realHost.length === 1 && realHost[0] !== undefined && msgOf(realHost[0]).isTrusted === true && msgOf(realHost[0]).targetIsHost === true ? '成立' : '不成立', realHost.map((l) => msgOf(l)));
  const saw = await page.evaluate(() => document.documentElement.dataset.pageSaw ?? null);
  check(it, '参考: ページの capture リスナーが見た実クリック（composedPath にボタンは含まれるか）', '参考', saw);
  await page.close();
  const ok = attempt?.shadowRootProp === 'null' && forgedButton.length === 0 && real.length === 1 && (real[0] ? msgOf(real[0]).isTrusted : undefined) === true;
  finish(it, ok ? '成立' : '不成立', 'ページからは閉じた root もボタンも触れず、偽のイベントは host にしか届かず isTrusted が偽。実クリックは isTrusted が真でボタンに届く');
}

// ---- 項目 5 ----
async function item5(dir: string, origin: string): Promise<void> {
  const it = startItem(5, '_execute_action のショートカットでサイドパネルが開くか');
  const probe = async (ctx: BrowserContext): Promise<unknown> => {
    const sw = await getSw(ctx);
    return sw.evaluate(async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
      const cmds = await chrome.commands.getAll();
      return { sidePanelContexts: contexts.length, urls: contexts.map((c) => c.documentUrl ?? null), commands: cmds.map((c) => ({ name: c.name, shortcut: c.shortcut })) };
    });
  };

  // (a) headless: Playwright のキー入力はページへ届くだけで、ブラウザのショートカットには届かない
  const { ctx } = await launch(dir, true);
  const page = await ctx.newPage();
  await page.goto('about:blank');
  const before = await probe(ctx);
  check(it, 'headless: 登録されたコマンドと、開始時点のサイドパネルのコンテキスト数', '参考', before);
  await page.keyboard.press('Alt+Shift+G');
  await new Promise((r) => setTimeout(r, 800));
  const afterKey = await probe(ctx);
  check(it, 'headless: page.keyboard.press("Alt+Shift+G") の後のサイドパネルのコンテキスト数', '参考', afterKey);
  const logs = (await readLogs(ctx)).filter((l) => l.kind.startsWith('action') || l.kind.startsWith('commands'));
  check(it, 'headless: action.onClicked / commands.onCommand の発火', '参考', logs);
  await ctx.close();

  // (b) headed + Xvfb: X11 の実キー入力
  if (!process.env.DISPLAY) {
    check(it, 'headed + 実キー入力', '確かめられない', 'DISPLAY が無い。`xvfb-run -a` 付きで再実行すると試みる');
  } else {
    const h = await launch(dir, false);
    const p = await h.ctx.newPage();
    await p.goto(`${origin}/a.html`);
    await p.bringToFront();
    await new Promise((r) => setTimeout(r, 800));
    // 陽性対照: 実キー入力が Chrome のページに届くか
    await p.focus('#i');
    spawnSync('python3', ['-I', join(here, 'xkey.py'), '300', '300', 'x'], { encoding: 'utf8' });
    await new Promise((r) => setTimeout(r, 500));
    const typed = await p.inputValue('#i');
    check(it, '陽性対照: XTEST で送った "x" が入力欄に届く', typed === 'x' ? '成立' : '不成立', { value: typed });
    const base = await probe(h.ctx);
    check(it, 'headed(Xvfb): キーを送る前のサイドパネルのコンテキスト', '参考', base);
    spawnSync('python3', ['-I', join(here, 'xkey.py'), '300', '300', 'Shift_L', 'g'], { encoding: 'utf8' });
    await new Promise((r2) => setTimeout(r2, 1000));
    const neg = await probe(h.ctx);
    check(it, '陰性対照: Shift+G（Alt なし）を送ってもサイドパネルは開かない', typeof neg === 'object' && neg !== null && 'sidePanelContexts' in neg && neg.sidePanelContexts === 0 ? '成立' : '不成立', neg);
    const r = spawnSync('python3', ['-I', join(here, 'xkey.py'), '300', '300', 'Alt_L', 'Shift_L', 'g'], { encoding: 'utf8' });
    await new Promise((r2) => setTimeout(r2, 1500));
    const state = await probe(h.ctx);
    const hlogs = (await readLogs(h.ctx)).filter((l) => l.kind.startsWith('action') || l.kind.startsWith('commands'));
    check(it, 'headed(Xvfb): XTEST で Alt+Shift+G を送った後のサイドパネルのコンテキスト数・発火', '参考', { state, logs: hlogs, xkeyStatus: r.status, xkeyErr: r.stderr });
    const opened = typeof state === 'object' && state !== null && 'sidePanelContexts' in state && state.sidePanelContexts === 1;
    check(it, 'headed(Xvfb): ショートカットでサイドパネルが開いた', opened ? '成立' : '確かめられない', { opened });
    await h.ctx.close();
  }
  const anyOpened = it.checks.some((c) => c.verdict === '成立' && c.what.includes('サイドパネルが開いた'));
  it.notes.push(
    '手動確認の手順: (1) `pnpm run build` で dist/ を作り、chrome://extensions で「パッケージ化されていない拡張機能を読み込む」で dist/ を選ぶ。(2) 任意の http(s) ページのタブを前面にして Alt+Shift+G を押す。(3) 右側にサイドパネル（一覧画面）が開けば成立。(4) もう一度押して閉じる／開くの挙動も見る。(5) 開かなければ chrome://extensions/shortcuts で「Activate the extension」にキーが割り当てられているか（競合で空になっていないか）を確かめる。(6) 同じ操作を、ツールバーのアクションをクリックした場合と比べる（openPanelOnActionClick: true で開くはず）。Chrome 114 での確認は 114 を入手できる環境が必要。',
  );
  finish(it, anyOpened ? '成立' : '確かめられない', anyOpened ? 'Xvfb 上の headed Chromium に XTEST の実キー入力（Alt+Shift+G）を送ると開いた（陽性・陰性対照あり）。headless の page.keyboard.press では開かない（ブラウザのショートカットに届かない）。Chrome 114・実機のデスクトップでは未確認なので手動確認も行う' : '自動化では確かめられない（headless ではキーがページにしか届かず、実キー入力でも結果が得られない場合は手動確認が必要）');
}

// ---- 結果の文書 ----
function esc(s: string): string {
  return s.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

async function writeReport(): Promise<void> {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: 技術検証の結果');
  lines.push('type: report');
  lines.push('description: 設計書「実装の最初に行う技術検証」6項目を、Playwright で読み込んだ Chromium 実機で確かめた結果。各項目の成立・不成立と観測値、設計書への影響');
  lines.push('tags: [design-doc, tech-check]');
  lines.push('keywords: [IndexedDB, fflate, documentId, checkVisibility, _execute_action, Shadow DOM, isTrusted, Playwright]');
  lines.push('---');
  lines.push('');
  lines.push('# 技術検証の結果');
  lines.push('');
  lines.push('`tests/tech-check/run.ts` が出力した。検証用の拡張機能は `tests/tech-check/` の下に作り、本番の `src/` は使っていない。');
  lines.push('');
  lines.push('## 環境');
  lines.push('');
  lines.push(`- Chromium: ${env.chromium ?? ''}（Playwright ${env.playwright ?? ''}、channel \`chromium\`）`);
  lines.push(`- ユーザーエージェント: \`${env.userAgent ?? ''}\``);
  lines.push('- 実行方法: 項目 1〜4・6 は headless（新 headless）、項目 5 は headless と Xvfb 上の headed');
  lines.push('- Chrome 114 そのものは手元にない。114 での可否は「Chrome 114 での推定」に分けて書く');
  for (const [k, v] of Object.entries(env)) if (k.startsWith('zip')) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('## 結果の一覧');
  lines.push('');
  lines.push('| 項目 | 結果 | 要点 |');
  lines.push('|---|---|---|');
  for (const it of items) lines.push(`| ${String(it.no)}. ${esc(it.title)} | ${it.verdict} | ${esc(it.summary)} |`);
  for (const it of items) {
    lines.push('');
    lines.push(`## 項目${String(it.no)}: ${it.title}`);
    lines.push('');
    lines.push(`結果: **${it.verdict}**。${it.summary}`);
    lines.push('');
    for (const n of it.notes) lines.push(`- ${n}`);
    if (it.notes.length) lines.push('');
    lines.push('| 確認したこと | 結果 | 観測した値 |');
    lines.push('|---|---|---|');
    for (const c of it.checks) lines.push(`| ${esc(c.what)} | ${c.verdict} | \`${esc(c.observed)}\` |`);
    const extra = IMPACT.perItem[it.no];
    if (extra) {
      lines.push('');
      lines.push(extra);
    }
  }
  lines.push('');
  lines.push('## 設計書への影響');
  lines.push('');
  lines.push(IMPACT.impact);
  lines.push('');
  lines.push('## 未確認のこと');
  lines.push('');
  lines.push(IMPACT.unverified);
  lines.push('');
  await mkdir(join(here, '../../docs/tmp'), { recursive: true });
  await writeFile(join(here, '../../docs/tmp/tech-check-result.md'), lines.join('\n'));
}

// ---- 実行 ----
const only = process.argv[2];
const dir = await buildTechCheck();
const { server, origin } = await startServer();
env.playwright = '1.63.0';
const main = await launch(dir, true);
try {
  const v = await main.ctx.newPage();
  env.chromium = spawnSync(chromium.executablePath(), ['--version'], { encoding: 'utf8' }).stdout.trim() || '不明';
  await v.close();
  const want = (n: number): boolean => only === undefined || only === String(n);
  if (want(1)) await item1(main.ctx, main.id);
  if (want(2)) await item2(main.ctx, main.id);
  if (want(3)) await item3(main.ctx, origin);
  if (want(4)) await item4(main.ctx, origin);
  if (want(6)) await item6(main.ctx, origin);
} finally {
  await main.ctx.close();
}
if (only === undefined || only === '5') await item5(dir, origin);
server.close();
await rm(dir, { recursive: true, force: true }); // 生成物は lint の対象になるので残さない
items.sort((a, b) => a.no - b.no);
if (only === undefined) await writeReport();
