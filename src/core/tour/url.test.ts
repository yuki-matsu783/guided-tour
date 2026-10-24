import { describe, expect, it } from 'vitest';
import type { UrlCond } from './schema.ts';
import { matchGlobSegments, matchUrl } from './url.ts';

const ORIGIN = 'https://example.com';

const exact = (p: string): UrlCond => ({ origin: ORIGIN, path: { exact: p } });
const prefix = (p: string): UrlCond => ({ origin: ORIGIN, path: { prefix: p } });
const glob = (p: string): UrlCond => ({ origin: ORIGIN, path: { glob: p } });
const at = (path: string): string => `${ORIGIN}${path}`;
const deep = (n: number): string => at('/a'.repeat(n));

describe('正規化', () => {
  it('T-URL-01: クエリがあっても、クエリのない同じパスの条件と一致する', () => {
    expect(matchUrl(exact('/a/b'), at('/a/b?a=1'))).toBe(true);
    expect(matchUrl(exact('/a/b'), at('/a/b?a=1&b=2'))).toBe(true);
  });

  it('T-URL-02: フラグメントがあっても、フラグメントのない同じパスの条件と一致する', () => {
    expect(matchUrl(exact('/a/b'), at('/a/b#top'))).toBe(true);
    expect(matchUrl(exact('/a/b'), at('/a/b?x=1#top'))).toBe(true);
  });

  it('T-URL-03: URL の末尾に / があっても、末尾に / のない exact と一致する', () => {
    expect(matchUrl(exact('/a/b'), at('/a/b/'))).toBe(true);
  });

  it('T-URL-04: 条件の exact の末尾に / があっても、末尾に / のない URL と一致する', () => {
    expect(matchUrl(exact('/a/b/'), at('/a/b'))).toBe(true);
  });

  it('T-URL-05: ルートの URL は exact: / と一致し、path 省略はルートを含むオリジン内のすべてと一致する', () => {
    expect(matchUrl(exact('/'), at('/'))).toBe(true);
    expect(matchUrl(exact('/'), ORIGIN)).toBe(true);
    expect(matchUrl({ origin: ORIGIN }, at('/'))).toBe(true);
    expect(matchUrl({ origin: ORIGIN }, at('/a/b/c?x=1'))).toBe(true);
  });

  it('T-URL-06: スキーム・ホスト・ポートのどれかが違えば、パスが同じでも一致しない', () => {
    expect(matchUrl(exact('/a'), 'http://example.com/a')).toBe(false);
    expect(matchUrl(exact('/a'), 'https://other.example.com/a')).toBe(false);
    expect(matchUrl(exact('/a'), 'https://example.com:8443/a')).toBe(false);
    expect(matchUrl({ origin: 'http://localhost:8080' }, 'http://localhost:8080/x')).toBe(true);
    expect(matchUrl({ origin: 'http://localhost:8080' }, 'http://localhost:9090/x')).toBe(false);
  });

  it('T-URL-07: パスの大文字・小文字が違えば一致しない', () => {
    expect(matchUrl(exact('/project'), at('/Project'))).toBe(false);
    expect(matchUrl(prefix('/project'), at('/Project/x'))).toBe(false);
  });

  it('T-URL-08: 空の区間は詰められ、/a/b の条件と一致する', () => {
    expect(matchUrl(exact('/a/b'), at('/a//b'))).toBe(true);
    expect(matchUrl(exact('/a//b'), at('/a/b'))).toBe(true);
  });

  it('T-URL-09: パーセントエンコードは戻されず、/a b の条件とは一致しない', () => {
    expect(matchUrl(exact('/a b'), at('/a%20b'))).toBe(false);
    expect(matchUrl(exact('/a%20b'), at('/a%20b'))).toBe(true);
  });

  it('T-URL-10: /a/./b と /a/../b は、ブラウザが正規化した pathname で比べる', () => {
    expect(matchUrl(exact('/a/b'), at('/a/./b'))).toBe(true);
    expect(matchUrl(exact('/b'), at('/a/../b'))).toBe(true);
    expect(matchUrl(exact('/a/b'), at('/a/../b'))).toBe(false);
  });

  it('T-URL-11: 解析できない文字列は、例外にならず一致しない（http/https 以外も一致しない）', () => {
    expect(matchUrl(exact('/a'), 'not a url')).toBe(false);
    expect(matchUrl(exact('/a'), '')).toBe(false);
    expect(matchUrl(exact('/a'), '/a')).toBe(false);
    expect(matchUrl({ origin: 'ftp://example.com' }, 'ftp://example.com/a')).toBe(false);
    expect(matchUrl({ origin: ORIGIN }, 'javascript:alert(1)')).toBe(false);
  });

  it('T-URL-12: 区間が256のURLは照合され、257のときは prefix・** の条件でも一致しない', () => {
    expect(matchUrl(prefix('/a'), deep(256))).toBe(true);
    expect(matchUrl(glob('/**'), deep(256))).toBe(true);
    expect(matchUrl(exact('/a'.repeat(256)), deep(256))).toBe(true);
    expect(matchUrl(prefix('/a'), deep(257))).toBe(false);
    expect(matchUrl(glob('/**'), deep(257))).toBe(false);
    expect(matchUrl({ origin: ORIGIN }, deep(257))).toBe(false);
  });
});

describe('exact・prefix', () => {
  it('T-URL-13: exact は区間の列が完全に一致するときだけ一致する', () => {
    const c = exact('/a/b');
    expect(matchUrl(c, at('/a/b'))).toBe(true);
    expect(matchUrl(c, at('/a'))).toBe(false);
    expect(matchUrl(c, at('/a/b/c'))).toBe(false);
    expect(matchUrl(c, at('/a/bc'))).toBe(false);
  });

  it('T-URL-14: prefix: /project は /project・/project/・/project/settings と一致する', () => {
    const c = prefix('/project');
    expect(matchUrl(c, at('/project'))).toBe(true);
    expect(matchUrl(c, at('/project/'))).toBe(true);
    expect(matchUrl(c, at('/project/settings'))).toBe(true);
  });

  it('T-URL-15: prefix: /project は区間の途中では一致しない', () => {
    const c = prefix('/project');
    expect(matchUrl(c, at('/project-danger'))).toBe(false);
    expect(matchUrl(c, at('/projects'))).toBe(false);
    expect(matchUrl(c, at('/projectx/settings'))).toBe(false);
  });

  it('T-URL-16: prefix: / はオリジンが一致する任意のパスと一致する', () => {
    const c = prefix('/');
    expect(matchUrl(c, at('/'))).toBe(true);
    expect(matchUrl(c, at('/a/b/c'))).toBe(true);
    expect(matchUrl(c, 'https://other.com/a')).toBe(false);
  });

  it('T-URL-17: 複数区間の prefix: /a/b は /a/b/c と一致し、/a/bc と /a とは一致しない', () => {
    const c = prefix('/a/b');
    expect(matchUrl(c, at('/a/b/c'))).toBe(true);
    expect(matchUrl(c, at('/a/b'))).toBe(true);
    expect(matchUrl(c, at('/a/bc'))).toBe(false);
    expect(matchUrl(c, at('/a'))).toBe(false);
  });
});

describe('glob', () => {
  it('T-URL-18: /a/*/c は1区間だけと一致する', () => {
    const c = glob('/a/*/c');
    expect(matchUrl(c, at('/a/x/c'))).toBe(true);
    expect(matchUrl(c, at('/a/c'))).toBe(false);
    expect(matchUrl(c, at('/a/x/y/c'))).toBe(false);
  });

  it('T-URL-19: /a/**/c は0区間以上と一致する', () => {
    const c = glob('/a/**/c');
    expect(matchUrl(c, at('/a/c'))).toBe(true);
    expect(matchUrl(c, at('/a/x/c'))).toBe(true);
    expect(matchUrl(c, at('/a/x/y/c'))).toBe(true);
    expect(matchUrl(c, at('/a/x/d'))).toBe(false);
  });

  it('T-URL-20: 先頭の ** と末尾の ** は、前方・後方の任意の区間数と一致する', () => {
    const head = glob('/**/c');
    expect(matchUrl(head, at('/c'))).toBe(true);
    expect(matchUrl(head, at('/x/y/c'))).toBe(true);
    expect(matchUrl(head, at('/c/d'))).toBe(false);
    const tail = glob('/a/**');
    expect(matchUrl(tail, at('/a'))).toBe(true);
    expect(matchUrl(tail, at('/a/x/y'))).toBe(true);
    expect(matchUrl(tail, at('/b/x'))).toBe(false);
  });

  it('T-URL-21: /** はオリジンが一致する任意のパスと一致する', () => {
    const c = glob('/**');
    expect(matchUrl(c, at('/'))).toBe(true);
    expect(matchUrl(c, at('/a/b/c'))).toBe(true);
    expect(matchUrl(c, 'https://other.com/a')).toBe(false);
  });

  it('T-URL-22: * と ** を組み合わせた /*/**/x/* が、区間の数に応じて一致・不一致になる', () => {
    const c = glob('/*/**/x/*');
    expect(matchUrl(c, at('/a/x/b'))).toBe(true);
    expect(matchUrl(c, at('/a/b/c/x/d'))).toBe(true);
    expect(matchUrl(c, at('/x/x/x'))).toBe(true);
    expect(matchUrl(c, at('/x/b'))).toBe(false);
    expect(matchUrl(c, at('/a/x'))).toBe(false);
    expect(matchUrl(c, at('/a/x/b/c'))).toBe(false);
  });

  it('T-URL-23: * は区間全体に一致する（/a/* が /a/bc と一致する）', () => {
    const c = glob('/a/*');
    expect(matchUrl(c, at('/a/bc'))).toBe(true);
    expect(matchUrl(c, at('/a/b/c'))).toBe(false);
    expect(matchUrl(c, at('/a'))).toBe(false);
  });

  it('T-URL-24: 区間の途中の * は、matchUrl では文字どおりの区間として扱う（検証側でエラーにする）', () => {
    const c = glob('/a/b*');
    expect(matchUrl(c, at('/a/bc'))).toBe(false);
    expect(matchUrl(c, at('/a/b*'))).toBe(true);
  });
});

describe('手間の上限', () => {
  it('T-URL-25: ** 4個のパターンと256区間の URL で、不一致の最悪の入力でも手間がパターン区間数 × URL 区間数に収まる', () => {
    const pattern = ['**', 'a', '*', '**', 'a', '*', '**', 'a', '**', 'a', ...Array<string>(10).fill('a'), 'b'];
    const segments = Array<string>(256).fill('a');
    const stats = { steps: 0 };
    const started = performance.now();
    expect(matchGlobSegments(pattern, segments, stats)).toBe(false);
    expect(stats.steps).toBeLessThanOrEqual(pattern.length * segments.length);
    expect(performance.now() - started).toBeLessThan(500);
    // matchUrl を通しても、固定の時間内に終わる
    const startedUrl = performance.now();
    expect(matchUrl(glob('/**/a/**/a/**/a/**/b'), deep(256))).toBe(false);
    expect(performance.now() - startedUrl).toBeLessThan(500);
  });

  it('T-URL-26: 257区間以上の URL は、パターンの形によらず一致しない', () => {
    for (const c of [glob('/**'), glob('/a/**'), prefix('/'), exact('/a'), { origin: ORIGIN }]) {
      expect(matchUrl(c, deep(257))).toBe(false);
      expect(matchUrl(c, deep(1000))).toBe(false);
    }
  });

  it('T-URL-27: ** を連続させたパターンと、末尾が一致しない長い URL でも、手間が増え続けない', () => {
    const pattern = ['**', '**', '**', '**', 'x'];
    for (const n of [64, 128, 256]) {
      const stats = { steps: 0 };
      expect(matchGlobSegments(pattern, Array<string>(n).fill('a'), stats)).toBe(false);
      expect(stats.steps).toBeLessThanOrEqual(pattern.length * n);
    }
    expect(matchUrl(glob('/**/**/**/**/x'), deep(256))).toBe(false);
    expect(matchUrl(glob('/**/**/**/**/x'), at('/a/b/x'))).toBe(true);
  });
});
