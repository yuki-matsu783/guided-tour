/**
 * `chrome.permissions.request` の呼び出しの記録。
 * 許可のダイアログは E2E では扱えない（ヘッドレスでは出したまま応答が無く、Promise は決着しない）ので、
 * 「何を求めたか」「求めなかったこと」を、呼び出しの引数の記録で確かめる。
 *
 * 使い方: 拡張機能のページ（サイドパネル）を開く前に `await spyPermissionRequests(ext.context)` を呼ぶ。
 * 開いたあと、`await permissionRequests(panel.page)` で、そのページが呼んだ `request` の引数の一覧を読む。
 * 元の `request` も呼ぶので、既に許可済みのサイトなら普通に `true` が返る。
 */
import type { BrowserContext, Page } from '@playwright/test';

export async function spyPermissionRequests(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    const calls: unknown[] = [];
    Reflect.set(window, '__permissionRequests', calls);
    const original = chrome.permissions.request;
    Reflect.set(chrome.permissions, 'request', (query: unknown): unknown => {
      calls.push(query);
      const result: unknown = Reflect.apply(original, chrome.permissions, [query]);
      return result;
    });
  });
}

export async function permissionRequests(page: Page): Promise<unknown[]> {
  return page.evaluate((): unknown[] => {
    const calls: unknown = Reflect.get(window, '__permissionRequests');
    if (!Array.isArray(calls)) return [];
    const copy: unknown[] = calls.slice();
    return copy;
  });
}
