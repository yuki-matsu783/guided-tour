import { describe, expect, it, vi } from 'vitest';
import { has, patternsOf, request, watchRemoved, type PermissionsApi, type RemovedPermissions } from './index.ts';

function tourOf(...origins: string[]): { origins: string[]; steps: { url: { origin: string } }[] } {
  return { origins, steps: [{ url: { origin: 'https://step.example' } }] };
}

function fakeApi(opts: { granted?: string[]; allow?: boolean } = {}): {
  api: PermissionsApi;
  request: ReturnType<typeof vi.fn>;
  fire: (removed: RemovedPermissions) => void;
  listeners: Set<(r: RemovedPermissions) => void>;
} {
  const listeners = new Set<(r: RemovedPermissions) => void>();
  const requestFn = vi.fn<PermissionsApi['request']>(() => Promise.resolve(opts.allow ?? true));
  const api: PermissionsApi = {
    contains: (q) => Promise.resolve(q.origins.every((o) => (opts.granted ?? []).includes(o))),
    request: requestFn,
    onRemoved: {
      addListener: (l) => {
        listeners.add(l);
      },
      removeListener: (l) => {
        listeners.delete(l);
      },
    },
  };
  return { api, request: requestFn, fire: (r) => {
      for (const l of listeners) l(r);
    },
    listeners,
  };
}

describe('patternsOf', () => {
  it('T-PERM-01: origins の各オリジンからホスト単位のパターンを作る', () => {
    expect(patternsOf(tourOf('https://a.example', 'https://b.example'))).toEqual([
      'https://a.example/*',
      'https://b.example/*',
    ]);
  });
  it('T-PERM-02: ポートを捨てる', () => {
    expect(patternsOf(tourOf('https://example.com:8443'))).toEqual(['https://example.com/*']);
  });
  it('T-PERM-03: http と https はそれぞれのスキームのパターンになる', () => {
    expect(patternsOf(tourOf('http://example.com', 'https://example.com'))).toEqual([
      'http://example.com/*',
      'https://example.com/*',
    ]);
  });
  it('T-PERM-04: ポートだけが違う2つから重複のない1つになる', () => {
    expect(patternsOf(tourOf('https://example.com:8443', 'https://example.com:9443'))).toEqual([
      'https://example.com/*',
    ]);
  });
  it('T-PERM-05: origins だけから作り、ステップの URL は使わない', () => {
    expect(patternsOf(tourOf('https://a.example'))).toEqual(['https://a.example/*']);
  });
  it('T-PERM-06: ワイルドカードのホストを含めない', () => {
    const patterns = patternsOf(tourOf('https://*.example.com', 'https://a.example'));
    expect(patterns).toEqual(['https://a.example/*']);
    expect(patterns.some((p) => p.includes('//*'))).toBe(false);
  });
});

describe('has', () => {
  it('T-PERM-07: すべてのパターンの権限があれば真', async () => {
    const { api } = fakeApi({ granted: ['https://a.example/*', 'https://b.example/*'] });
    expect(await has(tourOf('https://a.example', 'https://b.example'), api)).toBe(true);
  });
  it('T-PERM-08: 1つでも権限がなければ偽', async () => {
    const { api } = fakeApi({ granted: ['https://a.example/*'] });
    expect(await has(tourOf('https://a.example', 'https://b.example'), api)).toBe(false);
  });
  it('T-PERM-09: 他のツアーの権限は、このツアーの origins にないホストに影響しない', async () => {
    const { api } = fakeApi({ granted: ['https://other.example/*'] });
    expect(await has(tourOf('https://a.example'), api)).toBe(false);
    const both = fakeApi({ granted: ['https://other.example/*', 'https://a.example/*'] });
    expect(await has(tourOf('https://a.example'), both.api)).toBe(true);
  });
});

describe('request', () => {
  it('T-PERM-10: origins のパターンだけを api.request に渡す', async () => {
    const f = fakeApi();
    await request(tourOf('https://a.example:8443'), f.api);
    expect(f.request).toHaveBeenCalledWith({ origins: ['https://a.example/*'] });
  });
  it('T-PERM-11: 拒否されたら偽が返り、必要なサイトは patternsOf で分かる', async () => {
    const f = fakeApi({ allow: false });
    const tour = tourOf('https://a.example');
    expect(await request(tour, f.api)).toBe(false);
    expect(patternsOf(tour)).toEqual(['https://a.example/*']);
  });
  it('T-PERM-12: 許可されたら真が返る', async () => {
    expect(await request(tourOf('https://a.example'), fakeApi().api)).toBe(true);
  });
  it('T-PERM-13: await を挟まずに api.request を呼ぶ', () => {
    const f = fakeApi();
    void request(tourOf('https://a.example'), f.api);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('T-PERM-11: api.request が失敗しても偽を返し、例外を出さない', async () => {
    const f = fakeApi();
    f.request.mockRejectedValue(new Error('x'));
    expect(await request(tourOf('https://a.example'), f.api)).toBe(false);
  });
});

describe('watchRemoved', () => {
  it('T-PERM-14: 実行中のツアーの権限が取り消されたら onLost を呼ぶ', () => {
    const f = fakeApi();
    const onLost = vi.fn();
    watchRemoved(f.api, () => tourOf('https://a.example', 'https://b.example'), onLost);
    f.fire({ origins: ['https://b.example/*'] });
    expect(onLost).toHaveBeenCalledTimes(1);
  });
  it('T-PERM-15: 無関係なオリジンの取り消しでは呼ばない', () => {
    const f = fakeApi();
    const onLost = vi.fn();
    watchRemoved(f.api, () => tourOf('https://a.example'), onLost);
    f.fire({ origins: ['https://other.example/*'] });
    f.fire({});
    expect(onLost).not.toHaveBeenCalled();
  });
  it('T-PERM-16: 実行中のツアーがなければ何も起きない', () => {
    const f = fakeApi();
    const onLost = vi.fn();
    watchRemoved(f.api, () => null, onLost);
    f.fire({ origins: ['https://a.example/*'] });
    expect(onLost).not.toHaveBeenCalled();
  });
  it('解除すると以後は呼ばれない', () => {
    const f = fakeApi();
    const onLost = vi.fn();
    const stop = watchRemoved(f.api, () => tourOf('https://a.example'), onLost);
    stop();
    expect(f.listeners.size).toBe(0);
  });
});

/** chrome.permissions をそのまま api として渡せることを型で確かめる（実行はしない）。 */
export function chromeFits(): PermissionsApi {
  return chrome.permissions;
}
