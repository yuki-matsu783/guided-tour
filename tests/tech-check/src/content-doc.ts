/** 技術検証 3 用のコンテンツスクリプト。読み込まれた文書の存在を Service Worker に知らせる。 */
void chrome.runtime.sendMessage({
  type: 'doc-hello',
  href: location.href,
  isTop: window === window.top,
});
