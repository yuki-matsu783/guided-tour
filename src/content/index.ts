/**
 * ページ側（コンテンツスクリプト）のエントリ。
 * chrome.scripting でページに組み込まれ、ステップ実行器・完了の目安の監視・ハイライト・ミニガイドを起動する。
 * manifest の content_scripts には登録しない。
 */
import { createLevelSource } from '../shared/logger/index.ts';
import { startContent } from './bootstrap.ts';

startContent({
  win: window,
  runtime: {
    onMessage: {
      addListener: (listener) => {
        chrome.runtime.onMessage.addListener(listener);
      },
    },
    sendMessage: (message) => chrome.runtime.sendMessage(message),
  },
  createLevel: () => {
    const source = createLevelSource({
      storage: chrome.storage.local,
      onChanged: chrome.storage.onChanged,
    });
    return () => source.get();
  },
});
