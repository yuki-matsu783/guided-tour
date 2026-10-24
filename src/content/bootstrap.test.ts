// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWN_HOST_ATTRIBUTE } from '../core/locator/index.ts';
import { startContent, type RuntimeApi } from './bootstrap.ts';
import { makeRender, rev } from './test-support.ts';

type Listener = Parameters<RuntimeApi['onMessage']['addListener']>[0];

function fakeRuntime() {
  const listeners: Listener[] = [];
  const sent: unknown[] = [];
  const api: RuntimeApi = {
    onMessage: { addListener: (l) => listeners.push(l) },
    sendMessage: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
  };
  return { api, listeners, sent };
}

function deliver(listener: Listener | undefined, raw: unknown): unknown {
  let response: unknown;
  listener?.(raw, {}, (r) => {
    response = r;
  });
  return response;
}

beforeEach(() => {
  Reflect.deleteProperty(window, '__guidedTourContentStarted');
});
afterEach(() => {
  document.documentElement.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`).forEach((e) => { e.remove(); });
  document.body.innerHTML = '';
});

describe('起動', () => {
  it('起動時に HELLO を1回送り、メッセージの受け口を1つ登録する', () => {
    const rt = fakeRuntime();
    expect(startContent({ win: window, runtime: rt.api, createLevel: () => () => 'warn' })).toBe(true);
    expect(rt.sent).toEqual([{ type: 'HELLO' }]);
    expect(rt.listeners).toHaveLength(1);
  });

  it('同じ文書に二重に組み込まれても、動くのは1つだけ', () => {
    const rt = fakeRuntime();
    const createLevel = vi.fn(() => () => 'warn' as const);
    expect(startContent({ win: window, runtime: rt.api, createLevel })).toBe(true);
    expect(startContent({ win: window, runtime: rt.api, createLevel })).toBe(false);
    expect(rt.listeners).toHaveLength(1);
    expect(createLevel).toHaveBeenCalledTimes(1);
  });

  it('二重に組み込まれたときは、HELLO を送り直し、実行器は増やさない（すでに動いている実行器が描画指示を受けられる）', () => {
    const rt = fakeRuntime();
    const createLevel = () => () => 'warn' as const;
    startContent({ win: window, runtime: rt.api, createLevel });
    startContent({ win: window, runtime: rt.api, createLevel });
    expect(rt.sent).toEqual([{ type: 'HELLO' }, { type: 'HELLO' }]);
    deliver(rt.listeners[0], JSON.parse(JSON.stringify(makeRender({ rev: rev(1), selected: false }))));
    expect(document.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it('PING には応答し、検証を通らないメッセージは実行器へ渡さない', () => {
    const rt = fakeRuntime();
    startContent({ win: window, runtime: rt.api, createLevel: () => () => 'warn' });
    const listener = rt.listeners[0];
    expect(deliver(listener, { type: 'PING' })).toEqual({ ok: true });
    expect(deliver(listener, { type: 'RENDER', rev: 'x' })).toBeUndefined();
    expect(deliver(listener, 'でたらめ')).toBeUndefined();
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).toBeNull();
  });

  it('検証を通った RENDER でミニガイドが描かれ、CLEAR で消える', () => {
    const rt = fakeRuntime();
    startContent({ win: window, runtime: rt.api, createLevel: () => () => 'warn' });
    const listener = rt.listeners[0];
    deliver(listener, JSON.parse(JSON.stringify(makeRender({ rev: rev(1), selected: false }))));
    expect(document.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`)).toHaveLength(1);
    deliver(listener, { type: 'CLEAR', rev: 2 });
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).toBeNull();
  });

  it('R-SWEEP-03: 経過時間は壁時計（Date.now）ではなく単調な時計で測る（時計の巻き戻しの影響を受けない）', () => {
    const wall = vi.spyOn(Date, 'now');
    try {
      const rt = fakeRuntime();
      startContent({ win: window, runtime: rt.api, createLevel: () => () => 'warn' });
      deliver(rt.listeners[0], JSON.parse(JSON.stringify(makeRender({ rev: rev(1), selected: false }))));
      expect(document.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`)).toHaveLength(1);
      expect(wall).not.toHaveBeenCalled();
    } finally {
      wall.mockRestore();
    }
  });
});
