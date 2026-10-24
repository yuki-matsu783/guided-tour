/**
 * 自前の表示を載せるホスト要素の作成。閉じた Shadow DOM を使い、ページの CSS とスクリプトから隔てる。
 * ホスト要素には要素特定エンジンが除外に使う属性を付ける。スタイルは Shadow DOM の中の `<style>` に書く。
 */
import { OWN_HOST_ATTRIBUTE } from '../core/locator/index.ts';

/** ホスト要素に Shadow DOM を付ける関数。試験では作った root を控えるために差し替える。 */
export type AttachShadow = (host: HTMLElement) => ShadowRoot;

export const attachClosed: AttachShadow = (host) => host.attachShadow({ mode: 'closed' });

/** z-index の最大値。 */
export const Z_INDEX_MAX = '2147483647';

export interface OwnHost {
  host: HTMLElement;
  root: ShadowRoot;
  remove(): void;
}

const HOST_STYLE = [
  'all: initial !important',
  'position: fixed !important',
  'top: 0 !important',
  'left: 0 !important',
  'width: 0 !important',
  'height: 0 !important',
  'overflow: visible !important',
  `z-index: ${Z_INDEX_MAX} !important`,
  'pointer-events: none !important',
].join('; ');

/**
 * `<html>` の直下にホスト要素を作り、Shadow DOM に `css` を入れる。
 * どのホストも z-index は同じ最大値なので、重なりは DOM の順で決まる。
 * `layer` が `back` のホストは、すでにある自前のホストより前（背面側）に置き、`front` は最後（前面側）に置く。
 */
export function createOwnHost(
  doc: Document,
  attach: AttachShadow,
  css: string,
  layer: 'back' | 'front' = 'front',
): OwnHost {
  const host = doc.createElement('div');
  host.setAttribute(OWN_HOST_ATTRIBUTE, '');
  host.setAttribute('style', HOST_STYLE);
  const root = attach(host);
  const style = doc.createElement('style');
  style.textContent = css;
  root.appendChild(style);
  const firstOwn = layer === 'back' ? doc.documentElement.querySelector(`:scope > [${OWN_HOST_ATTRIBUTE}]`) : null;
  doc.documentElement.insertBefore(host, firstOwn);
  return {
    host,
    root,
    remove() {
      host.remove();
    },
  };
}
