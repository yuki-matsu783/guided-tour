/**
 * 技術検証用の Service Worker。IndexedDB の読み書き、メッセージの送信元（sender）の記録、
 * action・commands のイベントの記録を行う。記録は storage.session に 1 件 1 キーで残し、
 * Playwright 側から読む（Service Worker が止まっても消えないように）。
 */
import { idbReadBlob, idbWriteBlob } from './idb.ts';
import type { BlobSummary } from './idb.ts';

declare global {
  var techCheckRead: (key: string) => Promise<BlobSummary | null>;
  var techCheckWrite: (key: string, size: number) => Promise<BlobSummary>;
}

globalThis.techCheckRead = (key) => idbReadBlob(key, 'service-worker');
globalThis.techCheckWrite = (key, size) => idbWriteBlob(key, size, 'service-worker');

function log(kind: string, data: unknown): Promise<void> {
  return chrome.storage.session.set({ [`log:${String(Date.now()).padStart(15, '0')}:${Math.random().toString(36).slice(2)}`]: { kind, data } });
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e: unknown) => {
  void log('setPanelBehavior-error', String(e));
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const type =
    typeof message === 'object' && message !== null && 'type' in message && typeof message.type === 'string'
      ? message.type
      : 'unknown';
  void log(type, {
    message,
    sender: {
      documentId: sender.documentId ?? null,
      documentLifecycle: sender.documentLifecycle ?? null,
      frameId: sender.frameId ?? null,
      tabId: sender.tab?.id ?? null,
      url: sender.url ?? null,
      origin: sender.origin ?? null,
    },
  }).then(() => {
    sendResponse({ ok: true });
  });
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  void log('action-onClicked', { tabId: tab.id ?? null });
});
chrome.commands.onCommand.addListener((command) => {
  void log('commands-onCommand', { command });
});
