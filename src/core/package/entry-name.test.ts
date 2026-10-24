/**
 * エントリ名の検査と、相対パスの解決のテスト。
 */
import { describe, expect, it } from 'vitest';
import { checkEntryName, duplicateKey } from './entry-name.ts';
import { resolveRelative } from './path.ts';

describe('checkEntryName', () => {
  it('T-PKG-19: 名前に \\ を含むエントリは拒否される', () => {
    expect(checkEntryName('a\\b.md')).not.toBeNull();
  });

  it('T-PKG-20: ¥ など区切り文字を変形した文字を含む名前は拒否される', () => {
    for (const name of ['a\u00a5b.md', 'a\u20a9b.md', 'a\uff0fb.md', 'a\uff3cb.md', 'a\u2215b.md', 'a\u2044b.md']) {
      expect(checkEntryName(name), name).not.toBeNull();
    }
  });

  it('T-PKG-21: 名前に NUL を含むエントリは拒否される', () => {
    expect(checkEntryName('a\0b.md')).not.toBeNull();
  });

  it('T-PKG-22: 絶対パスは拒否される', () => {
    expect(checkEntryName('/etc/x')).not.toBeNull();
  });

  it('T-PKG-23: ドライブ名つきの名前は拒否される', () => {
    expect(checkEntryName('C:/x')).not.toBeNull();
    expect(checkEntryName('c:x')).not.toBeNull();
  });

  it('T-PKG-24: 空の区間を含む名前は拒否される', () => {
    expect(checkEntryName('a//b')).not.toBeNull();
  });

  it('T-PKG-25: .. の区間を含む名前は拒否される', () => {
    expect(checkEntryName('../x')).not.toBeNull();
    expect(checkEntryName('a/../b')).not.toBeNull();
  });

  it('T-PKG-26: ..a・a..b のように区間が .. ではない名前は拒否されない', () => {
    expect(checkEntryName('..a')).toBeNull();
    expect(checkEntryName('a..b')).toBeNull();
    expect(checkEntryName('a/..b/c..')).toBeNull();
  });

  it('T-PKG-30: 日本語の名前とサブディレクトリの名前は拒否されない', () => {
    expect(checkEntryName('images/図1.png')).toBeNull();
    expect(checkEntryName('説明/手順 1.md')).toBeNull();
  });

  it('T-PKG-31: ディレクトリのエントリ（末尾が /）は拒否されない', () => {
    expect(checkEntryName('images/')).toBeNull();
    expect(checkEntryName('a//')).not.toBeNull();
  });
});

describe('duplicateKey', () => {
  it('T-PKG-28: 大文字・小文字の違いだけの名前は同じ鍵になる', () => {
    expect(duplicateKey('a.png')).toBe(duplicateKey('A.PNG'));
    expect(duplicateKey('a.png')).not.toBe(duplicateKey('b.png'));
  });
});

describe('resolveRelative', () => {
  it('T-PKG-32: tour.yaml の場所を起点にサブディレクトリの参照を解決する', () => {
    expect(resolveRelative('tour.yaml', 'steps/a.md')).toEqual({ ok: true, path: 'steps/a.md' });
  });

  it('T-PKG-33: サブディレクトリの画像を tour.yaml の場所を起点に解決する', () => {
    expect(resolveRelative('tour.yaml', 'images/a.png')).toEqual({ ok: true, path: 'images/a.png' });
  });

  it('T-PKG-34: Markdown 内の参照はその Markdown の場所を起点に解決する', () => {
    expect(resolveRelative('steps/a.md', 'img/a.png')).toEqual({ ok: true, path: 'steps/img/a.png' });
  });

  it('T-PKG-35: steps/a.md の ../images/a.png はパッケージ内に留まるので解決できる', () => {
    expect(resolveRelative('steps/a.md', '../images/a.png')).toEqual({ ok: true, path: 'images/a.png' });
    expect(resolveRelative('steps/a.md', './b/../c.png')).toEqual({ ok: true, path: 'steps/c.png' });
  });

  it('T-PKG-36: パッケージの外に出る参照は失敗する', () => {
    expect(resolveRelative('tour.yaml', '../outside.png').ok).toBe(false);
    expect(resolveRelative('steps/a.md', '../../x.png').ok).toBe(false);
    expect(resolveRelative('tour.yaml', 'steps/../../x.png').ok).toBe(false);
  });

  it('T-PKG-38: 絶対パスの参照は失敗する', () => {
    expect(resolveRelative('tour.yaml', '/images/a.png').ok).toBe(false);
  });

  it('T-PKG-62: 外部 URL・スキーム相対の参照は失敗する', () => {
    for (const ref of ['http://example.com/a.png', 'https://example.com/a.png', '//host/x.png', 'ftp://h/a.png']) {
      expect(resolveRelative('tour.yaml', ref).ok, ref).toBe(false);
    }
  });

  it('T-PKG-20: 参照に \\ や区切りに似た文字があれば失敗する', () => {
    expect(resolveRelative('tour.yaml', 'a\\b.png').ok).toBe(false);
    expect(resolveRelative('tour.yaml', 'a\u00a5b.png').ok).toBe(false);
  });
});
