// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultEnv } from './env';

/** jsdom は描画をしないので、要素の矩形と checkVisibility を差し替える。 */
function stub(el: Element, rect: { width: number; height: number } | null, checkVisibility?: () => boolean): void {
  Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => (rect ? [rect] : []) });
  if (checkVisibility) Object.defineProperty(el, 'checkVisibility', { configurable: true, value: checkVisibility });
}

function makeButton(): HTMLElement {
  const el = document.createElement('button');
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('defaultEnv の表示判定', () => {
  it('T-LOC-51: 矩形の一覧が空なら表示されていない', () => {
    const el = makeButton();
    stub(el, null, () => true);
    expect(defaultEnv(window).isVisible(el)).toBe(false);
  });

  it('T-LOC-52: 幅と高さがどちらも 0 なら表示されていない', () => {
    const el = makeButton();
    stub(el, { width: 0, height: 0 }, () => true);
    expect(defaultEnv(window).isVisible(el)).toBe(false);
  });

  it('T-LOC-53: checkVisibility が偽なら表示されていない', () => {
    const el = makeButton();
    stub(el, { width: 10, height: 10 }, () => false);
    expect(defaultEnv(window).isVisible(el)).toBe(false);
  });

  it('T-LOC-53: checkVisibility が無い環境では、祖先の opacity: 0 と visibility: hidden で非表示とみなす', () => {
    const parent = document.createElement('div');
    parent.style.opacity = '0';
    const el = document.createElement('button');
    parent.append(el);
    document.body.append(parent);
    stub(el, { width: 10, height: 10 });
    expect(defaultEnv(window).isVisible(el)).toBe(false);

    parent.style.opacity = '1';
    expect(defaultEnv(window).isVisible(el)).toBe(true);
    parent.style.visibility = 'hidden';
    expect(defaultEnv(window).isVisible(el)).toBe(false);
  });

  it('T-LOC-53: checkVisibility が無い環境では、祖先の display: none で非表示とみなす', () => {
    const parent = document.createElement('div');
    parent.style.display = 'none';
    const el = document.createElement('button');
    parent.append(el);
    document.body.append(parent);
    stub(el, { width: 10, height: 10 });
    expect(defaultEnv(window).isVisible(el)).toBe(false);
  });

  it('T-LOC-55: 祖先が矩形を持たなくても、自身が矩形を持ち checkVisibility が真なら表示されている', () => {
    const parent = document.createElement('div');
    stub(parent, null);
    const el = document.createElement('button');
    parent.append(el);
    document.body.append(parent);
    stub(el, { width: 10, height: 10 }, () => true);
    expect(defaultEnv(window).isVisible(el)).toBe(true);
  });

  it('T-LOC-56: 画面外にある要素も表示されているとみなす', () => {
    const el = makeButton();
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ left: -5000, top: -5000, right: -4900, bottom: -4950, width: 100, height: 50 }),
    });
    stub(el, { width: 100, height: 50 }, () => true);
    expect(defaultEnv(window).isVisible(el)).toBe(true);
  });

  it('T-LOC-57: checkVisibility を、透明度と visibility の確認を有効にし、新旧両方の名前の指定で呼ぶ', () => {
    const el = makeButton();
    const spy = vi.fn(() => true);
    stub(el, { width: 10, height: 10 }, spy);
    defaultEnv(window).isVisible(el);
    expect(spy).toHaveBeenCalledWith({
      checkOpacity: true,
      checkVisibilityCSS: true,
      opacityProperty: true,
      visibilityProperty: true,
    });
  });
});

describe('defaultEnv の役割・名前・ホスト', () => {
  it('T-LOC-04: 役割は暗黙の役割を含めて計算し、名前は読み上げ名で返す', () => {
    document.body.innerHTML = '<button>保存</button><a href="/x">リンク</a>';
    const env = defaultEnv(window);
    const button = document.querySelector('button');
    const link = document.querySelector('a');
    expect(button && env.computeRole(button)).toBe('button');
    expect(link && env.computeRole(link)).toBe('link');
    expect(button && env.computeName(button)).toBe('保存');
  });

  it('T-LOC-91: 属性 data-guided-tour-host を持つ要素を自前のホストとみなす', () => {
    document.body.innerHTML = '<div data-guided-tour-host></div><div></div>';
    const [host, other] = Array.from(document.querySelectorAll('div'));
    const env = defaultEnv(window);
    expect(host && env.isOwnHost(host)).toBe(true);
    expect(other && env.isOwnHost(other)).toBe(false);
  });
});

describe('defaultEnv の見えている文字列', () => {
  it('R-LOC-1: innerText がある環境では、その値を返す', () => {
    const el = makeButton();
    Object.defineProperty(el, 'innerText', { configurable: true, value: '見えている' });
    expect(defaultEnv(window).visibleText(el)).toBe('見えている');
  });

  it('R-LOC-1: innerText が無い環境では、hidden・display: none・visibility: hidden の子孫を除いた文字列を返す', () => {
    document.body.innerHTML =
      '<button id="b">保<span hidden>あ</span><span style="display: none">い</span>' +
      '<span style="visibility: hidden">う</span>存<span>す</span></button>';
    const el = document.getElementById('b');
    expect(el && defaultEnv(window).visibleText(el)).toBe('保存す');
  });
});
