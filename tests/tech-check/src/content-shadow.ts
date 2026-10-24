/**
 * 技術検証 6 用のコンテンツスクリプト。閉じた Shadow DOM の中にボタンを置き、
 * ボタンとホストに届いたクリックの isTrusted を Service Worker へ報告する。
 */
function report(type: string, data: Record<string, unknown>): void {
  void chrome.runtime.sendMessage({ type, ...data });
}

const host = document.createElement('div');
host.id = 'tour-host';
host.style.cssText = 'position:fixed;top:10px;left:10px;width:140px;height:44px;z-index:2147483647;';
const root = host.attachShadow({ mode: 'closed' });
const button = document.createElement('button');
button.textContent = 'Next';
button.style.cssText = 'width:100%;height:100%;';
root.append(button);

button.addEventListener('click', (e) => {
  report('shadow-button-click', { isTrusted: e.isTrusted, targetIsButton: e.target === button });
});
host.addEventListener('click', (e) => {
  report('shadow-host-click', { isTrusted: e.isTrusted, targetIsHost: e.target === host });
});
host.addEventListener('pointerdown', (e) => {
  report('shadow-host-pointerdown', { isTrusted: e.isTrusted, targetIsHost: e.target === host });
});
document.documentElement.append(host);
report('shadow-ready', {});
