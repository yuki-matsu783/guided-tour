/**
 * 拡張機能を読み込んだ Chromium の起動と、拡張機能側（Service Worker・権限・保存領域）の操作。
 *
 * 使い方（後の担当は、通常は fixtures.ts の `ext` を使えばよい）:
 * - `launchExtension(opts?)`: 拡張機能付きの永続コンテキストを起動し、`Extension` を返す。
 *   ヘッドレスで動く。`E2E_HEADED=1` で画面ありにできる。
 * - `ext.context` / `ext.id`: Playwright のコンテキストと、固定された拡張機能 ID。
 * - `ext.worker()`: 生きている Service Worker（止まっていれば起こして返す）。`worker.evaluate` で `chrome.*` を呼べる。
 * - `ext.stopWorker()`: CDP（`ServiceWorker.stopAllWorkers`）で Service Worker を停止する。次の操作で自然に起動し直す。
 * - `ext.revokeSite(pattern)` / `ext.grantSite(pattern)`: 利用者がサイトへのアクセスを外す・戻す操作の代わり。
 *   chrome://extensions の `developerPrivate` で行うので、`permissions.onRemoved` が本物と同じように届く。
 *   `permissions.remove` は必須権限に使えないため、こちらを使う。許可ダイアログそのものは E2E では扱えない。
 * - `ext.mainWindowId`: 起動時から開いているウィンドウの ID。
 * - `ext.openTab(url, windowId?)`: `chrome.tabs.create` でタブを開いて返す。ウィンドウを指定しないときは `mainWindowId`。
 *   `context.newPage()` は、直前に作ったウィンドウ（サイドパネルのウィンドウなど）に開くことがあるので使わない。
 * - `ext.openWindow(url)`: 別のウィンドウでタブを開いて返す。
 *   ヘッドレスでは、ウィンドウの前面（`lastFocusedWindow`）は「最後に作ったウィンドウ」になり、切り替えられない
 *   （`windows.update({focused: true})` は `lastFocusedWindow` を変えない）。前面にしたいウィンドウは最後に作る。
 * - `ext.blurWindow(page)`: そのタブのウィンドウを最小化して `focused: false` にする（別のウィンドウで作業中の再現）。
 *   戻すのは `ext.focusPage(page)`。
 * - `ext.tabInfo(page)`: その `Page` のタブの `tabId`・`windowId`・選択中か・ウィンドウが前面かを、`chrome.tabs`・`chrome.windows` で読む
 *   （URL で探すので、同じ URL のタブが複数あるとエラー）。
 * - `ext.focusPage(page)`: そのタブを選択し、ウィンドウを元の大きさに戻して `focused: true` にする。
 * - `ext.recordMessages()`: タブ（ページ側）から Service Worker へ届くメッセージの種類を記録する。`recorder.take()` で取り出す。
 *   「メッセージも来ない」の確認用。Service Worker が止まると記録は途切れる。
 * - `ext.permissions()`: `chrome.permissions.getAll()` の結果。
 * - `ext.storageLocal(key?)` / `ext.storageSession(key?)`: 拡張機能の保存領域を読む。
 * - `ext.restart()`: 同じユーザーデータでブラウザを閉じて起動し直し、新しい `Extension` を返す（古いものは使えない）。
 *   `storage.session`（実行中の状態）は失われ、`storage.local`・IndexedDB（進捗・取り込んだツアー）は残る。
 * - `ext.close()`: ブラウザを閉じる。自分で作ったユーザーデータの一時ディレクトリは消す。
 */
import { chromium } from '@playwright/test';
import type { BrowserContext, CDPSession, Page, Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** 起動して、まだ閉じていない拡張機能。テストの後始末（`closeAllExtensions`）が閉じる。 */
const openExtensions = new Set<Extension>();

export async function closeAllExtensions(): Promise<void> {
  for (const ext of [...openExtensions]) await ext.close();
}

export interface LaunchOptions {
  /** 読み込む拡張機能のディレクトリ。既定は globalSetup が作ったもの。 */
  extensionDir?: string;
  /** ユーザーデータのディレクトリ。無ければ一時ディレクトリを作り、閉じるときに消す。 */
  userDataDir?: string;
}

export interface PermissionsInfo {
  origins: string[];
  permissions: string[];
}

export interface TabInfo {
  tabId: number;
  windowId: number;
  active: boolean;
  windowFocused: boolean;
}

export interface MessageRecorder {
  /** 記録を取り出して空にする。各項目はメッセージの種類（`type`）と、送ったタブの ID（タブ以外なら null）。 */
  take(): Promise<{ type: string; tabId: number | null }[]>;
}

export interface Extension {
  readonly context: BrowserContext;
  readonly id: string;
  readonly mainWindowId: number;
  readonly userDataDir: string;
  worker(): Promise<Worker>;
  stopWorker(): Promise<void>;
  revokeSite(pattern: string): Promise<void>;
  grantSite(pattern: string): Promise<void>;
  permissions(): Promise<PermissionsInfo>;
  openTab(url: string, windowId?: number): Promise<Page>;
  openWindow(url: string): Promise<Page>;
  blurWindow(page: Page): Promise<void>;
  tabInfo(page: Page): Promise<TabInfo>;
  focusPage(page: Page): Promise<void>;
  recordMessages(): Promise<MessageRecorder>;
  storageLocal(key?: string): Promise<unknown>;
  storageSession(key?: string): Promise<unknown>;
  restart(): Promise<Extension>;
  close(): Promise<void>;
}

const PermissionsSchema = z.object({
  origins: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
});

const TabInfoSchema = z.object({
  tabId: z.number(),
  windowId: z.number(),
  active: z.boolean(),
  windowFocused: z.boolean(),
});

const RecordedSchema = z.array(z.object({ type: z.string(), tabId: z.number().nullable() }));

const VersionsSchema = z.array(
  z.object({ scriptURL: z.string(), runningStatus: z.string() }),
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extensionDirOf(options: LaunchOptions): string {
  const dir = options.extensionDir ?? process.env.E2E_EXTENSION_DIR;
  if (dir === undefined || dir === '') {
    throw new Error('E2E_EXTENSION_DIR が未設定（globalSetup を通さずに実行していないか確かめる）');
  }
  return dir;
}

async function open(options: LaunchOptions, ownsDir: boolean): Promise<Extension> {
  const extensionDir = extensionDirOf(options);
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'guided-tour-e2e-profile-')));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.E2E_HEADED !== '1',
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const first = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(first.url()).host;
  const scope = `chrome-extension://${id}/`;
  const mainWindowId = await first.evaluate(async (): Promise<number> => (await chrome.windows.getAll())[0]?.id ?? -1);

  let cdp: CDPSession | null = null;
  let cdpPage: Page | null = null;
  let latestVersions: z.output<typeof VersionsSchema> = [];

  /** Service Worker の起動・停止を CDP で扱うためのセッション。ページが閉じたら作り直す。 */
  async function session(): Promise<CDPSession> {
    const page = context.pages().find((p) => !p.isClosed());
    if (cdp !== null && cdpPage !== null && !cdpPage.isClosed()) return cdp;
    const target = page ?? (await context.newPage());
    cdpPage = target;
    cdp = await context.newCDPSession(target);
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
      const parsed = VersionsSchema.safeParse(event.versions);
      if (parsed.success) latestVersions = parsed.data;
    });
    await cdp.send('ServiceWorker.enable');
    return cdp;
  }

  function myStatus(): string | undefined {
    return latestVersions.find((v) => v.scriptURL.startsWith(scope))?.runningStatus;
  }

  async function isAlive(w: Worker): Promise<boolean> {
    try {
      await Promise.race([
        w.evaluate(() => 1),
        sleep(1500).then(() => {
          throw new Error('timeout');
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  const self: Extension = {
    context,
    id,
    mainWindowId,
    userDataDir,

    async worker() {
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidates = context.serviceWorkers().filter((w) => w.url().startsWith(scope));
        for (const w of candidates.toReversed()) {
          if (await isAlive(w)) return w;
        }
        const s = await session();
        await s.send('ServiceWorker.startWorker', { scopeURL: scope }).catch(() => undefined);
        await sleep(250);
      }
      throw new Error('Service Worker を取得できなかった');
    },

    async stopWorker() {
      const s = await session();
      await s.send('ServiceWorker.stopAllWorkers');
      for (let i = 0; i < 40; i++) {
        if (myStatus() === 'stopped') return;
        await sleep(50);
      }
    },

    async revokeSite(pattern) {
      await developerPrivate('removeHostPermission', pattern);
    },

    async grantSite(pattern) {
      await developerPrivate('addHostPermission', pattern);
    },

    async permissions() {
      const w = await self.worker();
      const raw: unknown = await w.evaluate(() => chrome.permissions.getAll());
      return PermissionsSchema.parse(raw);
    },

    async openTab(url, windowId) {
      const w = await self.worker();
      const target = windowId ?? mainWindowId;
      const [page] = await Promise.all([
        context.waitForEvent('page'),
        w.evaluate(async ({ url, windowId }) => {
          await chrome.tabs.create({ url, windowId, active: true });
        }, { url, windowId: target }),
      ]);
      await page.waitForURL(url);
      return page;
    },

    async openWindow(url) {
      const w = await self.worker();
      const [page] = await Promise.all([
        context.waitForEvent('page'),
        w.evaluate(async (u) => {
          await chrome.windows.create({ url: u, type: 'normal', focused: true });
        }, url),
      ]);
      await page.waitForURL(url);
      return page;
    },

    async blurWindow(page) {
      const info = await self.tabInfo(page);
      const w = await self.worker();
      await w.evaluate(async (windowId) => {
        await chrome.windows.update(windowId, { state: 'minimized' });
      }, info.windowId);
    },

    async tabInfo(page) {
      const w = await self.worker();
      const url = page.url();
      const raw: unknown = await w.evaluate(async (u) => {
        const tabs = (await chrome.tabs.query({})).filter((t) => t.url === u);
        if (tabs.length !== 1) return { error: tabs.length };
        const t = tabs[0];
        if (t?.id === undefined) return { error: -1 };
        const win = await chrome.windows.get(t.windowId);
        return { tabId: t.id, windowId: t.windowId, active: t.active, windowFocused: win.focused };
      }, url);
      const error = z.object({ error: z.number() }).safeParse(raw);
      if (error.success) throw new Error(`URL が一致するタブが ${String(error.data.error)} 個ある（1 個だけにする）`);
      return TabInfoSchema.parse(raw);
    },

    async focusPage(page) {
      const info = await self.tabInfo(page);
      const w = await self.worker();
      await w.evaluate(async ({ tabId, windowId }) => {
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(windowId, { state: 'normal', focused: true });
      }, info);
    },

    async recordMessages() {
      const w = await self.worker();
      await w.evaluate(() => {
        const key = '__e2eMessages';
        if (Reflect.get(globalThis, key) !== undefined) return;
        const list: { type: string; tabId: number | null }[] = [];
        Reflect.set(globalThis, key, list);
        chrome.runtime.onMessage.addListener((message: unknown, sender) => {
          const type: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'type') : undefined;
          list.push({ type: typeof type === 'string' ? type : '(不明)', tabId: sender.tab?.id ?? null });
          return false;
        });
      });
      return {
        async take() {
          const live = await self.worker();
          const raw: unknown = await live.evaluate(() => {
            const list: unknown = Reflect.get(globalThis, '__e2eMessages');
            if (!Array.isArray(list)) return [];
            const taken: unknown[] = list.splice(0);
            return taken;
          });
          return RecordedSchema.parse(raw);
        },
      };
    },

    async storageLocal(key) {
      const w = await self.worker();
      const all: unknown = await w.evaluate((k) => chrome.storage.local.get(k ?? null), key);
      return key === undefined ? all : z.record(z.string(), z.unknown()).parse(all)[key];
    },

    async storageSession(key) {
      const w = await self.worker();
      const all: unknown = await w.evaluate((k) => chrome.storage.session.get(k ?? null), key);
      return key === undefined ? all : z.record(z.string(), z.unknown()).parse(all)[key];
    },

    async restart() {
      openExtensions.delete(self);
      await context.close();
      return open({ ...options, userDataDir }, ownsDir);
    },

    async close() {
      openExtensions.delete(self);
      await context.close().catch(() => undefined);
      if (ownsDir) await rm(userDataDir, { recursive: true, force: true });
    },
  };
  openExtensions.add(self);

  /** chrome://extensions のページで `chrome.developerPrivate` のホスト権限の操作を呼ぶ。 */
  async function developerPrivate(method: 'addHostPermission' | 'removeHostPermission', pattern: string): Promise<void> {
    const page = await context.newPage();
    try {
      await page.goto('chrome://extensions/');
      await page.evaluate(
        async ({ method, id, pattern }) => {
          // @types/chrome に無い、chrome://extensions のページだけが持つ API
          const api: unknown = Reflect.get(chrome, 'developerPrivate');
          const fn: unknown = typeof api === 'object' && api !== null ? Reflect.get(api, method) : undefined;
          if (typeof fn !== 'function') throw new Error('developerPrivate が使えない');
          const done: unknown = Reflect.apply(fn, api, [id, pattern]);
          await done;
        },
        { method, id, pattern },
      );
      // permissions.onRemoved / onAdded が届くのを待つ
      await sleep(300);
    } finally {
      await page.close();
    }
  }

  return self;
}

export function launchExtension(options: LaunchOptions = {}): Promise<Extension> {
  return open(options, options.userDataDir === undefined);
}
