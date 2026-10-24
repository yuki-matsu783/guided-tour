/**
 * タブ管理が使う Chrome API の最小の形。`chrome.*` と同じ形で、テストでは偽物を差し込む。
 * 使う項目だけを書き、戻り値の項目は省略できるものを `undefined` 許容にしている。
 */
import type { PermissionsApi } from '../../shared/permissions/index.ts';

export interface TabLike {
  id?: number | undefined;
  url?: string | undefined;
  title?: string | undefined;
  active: boolean;
  windowId: number;
}

export interface WindowLike {
  focused: boolean;
}

export interface EventSource<A extends unknown[]> {
  addListener(listener: (...args: A) => void): void;
  removeListener(listener: (...args: A) => void): void;
}

/** webNavigation のイベントが渡す値のうち、ここで使う項目。 */
export interface NavigationDetails {
  tabId: number;
  frameId: number;
}

export interface TabsApi {
  get(tabId: number): Promise<TabLike>;
  query(query: { active?: boolean; lastFocusedWindow?: boolean }): Promise<TabLike[]>;
  create(properties: { url: string }): Promise<TabLike>;
  update(tabId: number, properties: { url?: string; active?: boolean }): Promise<TabLike | undefined>;
  sendMessage(tabId: number, message: unknown, options?: { frameId: number }): Promise<unknown>;
  onActivated: EventSource<[unknown]>;
  onRemoved: EventSource<[number, unknown]>;
}

export interface WindowsApi {
  get(windowId: number): Promise<WindowLike>;
  update(windowId: number, properties: { focused: boolean }): Promise<unknown>;
  onFocusChanged: EventSource<[number]>;
}

export interface WebNavigationApi {
  onCommitted: EventSource<[NavigationDetails]>;
  onHistoryStateUpdated: EventSource<[NavigationDetails]>;
  onCompleted: EventSource<[NavigationDetails]>;
}

export interface ScriptingApi {
  executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown>;
}

export interface CommandsApi {
  getAll(): Promise<{ name?: string | undefined; shortcut?: string | undefined }[]>;
}

export interface TabsDeps {
  tabs: TabsApi;
  windows: WindowsApi;
  webNavigation: WebNavigationApi;
  scripting: ScriptingApi;
  commands: CommandsApi;
  /** 組み込むページ側のスクリプトのファイル名（`'content.js'`）。 */
  contentScriptFile: string;
  permissions: Pick<PermissionsApi, 'contains'>;
}
