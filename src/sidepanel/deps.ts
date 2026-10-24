/**
 * サイドパネルが外の世界（拡張機能 API・IndexedDB・ファイル保存）に触れる口。
 * 画面の部品は `PanelDeps` だけを使い、試験では偽物を渡す。実物は `createChromeDeps` が組み立てる。
 * バックグラウンドからのメッセージは、拡張機能自身の送信元（タブを持たない）のものだけを渡す。
 */
import { z } from 'zod';
import {
  STORE,
  TourRecordSchema,
  openDb,
  requestToPromise,
  FileRecordSchema,
} from '../shared/db/index.ts';
import type { TourRecord } from '../shared/db/index.ts';
import {
  LevelSchema,
  createLevelSource,
  createLogger,
  createMessageSink,
} from '../shared/logger/index.ts';
import type { Level, Logger } from '../shared/logger/index.ts';
import type { PermissionsApi } from '../shared/permissions/index.ts';
import type { PanelToBg } from '../shared/messages/index.ts';
import { importFiles } from './import/index.ts';
import type { ImportDeps, ImportResult } from './import/index.ts';

/** 画面が取り込みに渡す、確認・通知などの部分。`db` と時刻は実物の側が足す。 */
export type ImportHooks = Pick<
  ImportDeps,
  'confirmOverwrite' | 'getBundledTourIds' | 'getRunningTourId' | 'notifyCatalogChanged'
>;

export interface PanelDeps {
  /** バックグラウンドへ送り、応答を（検証せずに）返す。失敗は拒否する。 */
  send(message: PanelToBg): Promise<unknown>;
  /** バックグラウンドからのメッセージの購読。解除用の関数を返す。 */
  subscribe(listener: (raw: unknown) => void): () => void;
  /** `request(tour, permissions)` に渡す。 */
  permissions: Pick<PermissionsApi, 'request'>;
  getUrl(path: string): string;
  /** 取得できなければ null。 */
  fetchText(url: string): Promise<string | null>;
  /** 取り込んだツアーの記録。無ければ null。 */
  readTourRecord(tourId: string): Promise<TourRecord | null>;
  /** 取り込んだツアーのファイル（Markdown・画像）。無ければ null。 */
  readStoredFile(tourId: string, hash: string, path: string): Promise<Blob | null>;
  importFiles(files: File[], hooks: ImportHooks): Promise<ImportResult[]>;
  /** 同梱ツアーの ID の一覧（`tours/index.json`）。読めなければ空。 */
  bundledTourIds(): Promise<string[]>;
  /** 注目中のウィンドウで選択中のタブ。分からなければ null。 */
  getActiveTabId(): Promise<number | null>;
  /** `storage.local` の `settings.logLevel` を書く。ほかの項目は残す。 */
  writeLogLevel(level: Level): Promise<boolean>;
  /** 文字列をファイルとして保存する。 */
  saveFile(name: string, text: string, mime: string): void;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  /** 移動の受け付けの待ちに使う時計（ミリ秒）。巻き戻らないこと。 */
  now(): number;
  logger: Logger;
}

const BundledIndexSchema = z.object({ tours: z.array(z.string()) });
const SettingsRecordSchema = z.looseObject({});

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

/** 実物の依存。拡張機能のサイドパネルのページでだけ呼ぶ。 */
export function createChromeDeps(): PanelDeps {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const getDb = (): Promise<IDBDatabase> => {
    dbPromise ??= openDb();
    return dbPromise;
  };

  const levels = createLevelSource({
    storage: chrome.storage.local,
    onChanged: chrome.storage.onChanged,
  });
  const logger = createLogger(
    'sidepanel',
    createMessageSink((message) => chrome.runtime.sendMessage(message)),
    () => levels.get(),
  );

  return {
    send: (message) => chrome.runtime.sendMessage(message),
    subscribe(listener) {
      const onMessage = (
        message: unknown,
        sender: chrome.runtime.MessageSender,
      ): undefined => {
        // 拡張機能の内部（タブを持たない送信元）以外からの通知は受けない
        if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return undefined;
        listener(message);
        return undefined;
      };
      chrome.runtime.onMessage.addListener(onMessage);
      return () => {
        chrome.runtime.onMessage.removeListener(onMessage);
      };
    },
    permissions: chrome.permissions,
    getUrl: (path) => chrome.runtime.getURL(path),
    fetchText,
    async readTourRecord(tourId) {
      const db = await getDb();
      const row: unknown = await requestToPromise(
        db.transaction(STORE.tours, 'readonly').objectStore(STORE.tours).get(tourId),
      );
      const parsed = TourRecordSchema.safeParse(row);
      return parsed.success ? parsed.data : null;
    },
    async readStoredFile(tourId, hash, path) {
      const db = await getDb();
      const row: unknown = await requestToPromise(
        db.transaction(STORE.files, 'readonly').objectStore(STORE.files).get([tourId, hash, path]),
      );
      const parsed = FileRecordSchema.safeParse(row);
      return parsed.success ? parsed.data.blob : null;
    },
    async importFiles(files, hooks) {
      const db = await getDb();
      return importFiles(files, { db, now: () => Date.now(), ...hooks });
    },
    async bundledTourIds() {
      const raw = await fetchText(chrome.runtime.getURL('tours/index.json'));
      if (raw === null) return [];
      try {
        const parsed = BundledIndexSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data.tours : [];
      } catch {
        return [];
      }
    },
    async getActiveTabId() {
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tabs[0]?.id ?? null;
      } catch {
        return null;
      }
    },
    async writeLogLevel(level) {
      try {
        const items = await chrome.storage.local.get('settings');
        const current = SettingsRecordSchema.safeParse(items.settings);
        const next = { ...(current.success ? current.data : {}), logLevel: LevelSchema.parse(level) };
        await chrome.storage.local.set({ settings: next });
        return true;
      } catch {
        return false;
      }
    },
    saveFile(name, text, mime) {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 0);
    },
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => {
      URL.revokeObjectURL(url);
    },
    // 移動の受け付けの待ちに使う。時計の巻き戻しの影響を受けない、単調に進む時計
    now: () => performance.now(),
    logger,
  };
}
