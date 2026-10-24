/**
 * バックグラウンド（Service Worker）のエントリ。できあがった部品を実際の Chrome API につなぐ。
 * 判断はここに書かず、振り分けは `wiring/router.ts`、起動の順序は `wiring/startup.ts` が持つ。
 * リスナーは Service Worker の起動の最初の1回の実行の中で、同期的に登録する（Chrome の決まり）。
 */
import { openDb } from '../shared/db/index.ts';
import { createLevelSource, createLogger } from '../shared/logger/index.ts';
import { watchRemoved } from '../shared/permissions/index.ts';
import { createCatalog, loadBundledTours } from './catalog/index.ts';
import { createDiagnostics } from './diagnostics/index.ts';
import { createLogStore } from './logstore/index.ts';
import { createSession } from './session/index.ts';
import { createTabs } from './tabs/index.ts';
import { createRouter } from './wiring/router.ts';
import { createStartup } from './wiring/startup.ts';

/** IndexedDB の接続。閉じられた・開けなかったときは、次の呼び出しで開き直す。 */
let dbPromise: Promise<IDBDatabase> | null = null;
function getDb(): Promise<IDBDatabase> {
  dbPromise ??= openDb().then(
    (db) => {
      db.addEventListener('versionchange', () => {
        dbPromise = null;
      });
      db.addEventListener('close', () => {
        dbPromise = null;
      });
      return db;
    },
    (error: unknown) => {
      dbPromise = null;
      throw error;
    },
  );
  return dbPromise;
}

// 保管の失敗は保管自身へ書くと連鎖するので、コンソールにだけ出す
const consoleOnly = (fields: { name: string; reason: string }): void => {
  console.error('[background] storage failure', fields);
};

const levelSource = createLevelSource({
  storage: { get: (key) => chrome.storage.local.get(key) },
  onChanged: {
    addListener: (listener) => {
      chrome.storage.onChanged.addListener(listener);
    },
    removeListener: (listener) => {
      chrome.storage.onChanged.removeListener(listener);
    },
  },
});
const logstore = createLogStore({ getDb, onFailure: consoleOnly });
const logger = createLogger(
  'background',
  (entry) => {
    logstore.append(entry);
  },
  () => levelSource.get(),
);
const diagnostics = createDiagnostics({ getDb, onFailure: consoleOnly });
const catalog = createCatalog({
  getDb,
  diagnostics,
  loadBundled: () =>
    loadBundledTours({
      getUrl: (path) => chrome.runtime.getURL(path),
      fetch: (url) => fetch(url),
    }),
});
const tabs = createTabs({
  tabs: chrome.tabs,
  windows: chrome.windows,
  webNavigation: chrome.webNavigation,
  scripting: chrome.scripting,
  commands: chrome.commands,
  contentScriptFile: 'content.js',
  permissions: chrome.permissions,
});

/** サイドパネルへ状態の写しを通知する。パネルが閉じていると失敗するので握りつぶす。 */
function notifyPanel(view: unknown): Promise<void> {
  return chrome.runtime.sendMessage({ type: 'TOUR_STATE_CHANGED', view }).then(
    () => undefined,
    () => undefined,
  );
}

const session = createSession({
  storageSession: chrome.storage.session,
  storageLocal: chrome.storage.local,
  catalog,
  tabs,
  permissions: chrome.permissions,
  diagnostics,
  logger,
  notifyPanel,
  extensionVersion: chrome.runtime.getManifest().version,
  now: () => Date.now(),
  randomId: () => crypto.randomUUID(),
});

tabs.onEvent((event) => {
  void session.onTabEvent(event).catch(() => undefined);
});
watchRemoved(
  chrome.permissions,
  () => session.runningTour(),
  () => void session.onPermissionLost().catch(() => undefined),
);

const startup = createStartup({
  catalog,
  logstore,
  session,
  sidePanel: chrome.sidePanel,
  logger,
});

const router = createRouter({
  extensionId: chrome.runtime.id,
  session,
  catalog,
  diagnostics,
  logstore,
  logger,
  notifyPanel,
  ready: () => startup.ready(),
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) =>
  router.onMessage(raw, sender, sendResponse),
);
chrome.runtime.onInstalled.addListener(() => {
  void startup.start();
});
void startup.start();
