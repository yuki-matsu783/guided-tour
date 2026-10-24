import { describe, expect, it } from 'vitest';
import { containsAnyName, matchesAnyName, normalizeName } from './normalize';

describe('名前の正規化', () => {
  it('T-LOC-84: 全角英数字は NFKC で半角と一致する', () => {
    expect(matchesAnyName('ＡＢＣ１', ['ABC1'])).toBe(true);
  });

  it('T-LOC-85: 途中の連続する空白・改行は1つにまとめて比べる', () => {
    expect(normalizeName('a \n\t  b')).toBe('a b');
    expect(matchesAnyName('Save   \n changes', ['save changes'])).toBe(true);
  });

  it('T-LOC-86: 前後の空白は削って比べる', () => {
    expect(matchesAnyName('  削除 \n', ['削除'])).toBe(true);
  });

  it('T-LOC-87: 英字の大文字・小文字を区別しない', () => {
    expect(matchesAnyName('Delete', ['delete'])).toBe(true);
    expect(matchesAnyName('delete', ['DELETE'])).toBe(true);
  });

  it('T-LOC-88: 日本語と英語の候補を両方書けば、どちらの言語の名前でも一致する', () => {
    const candidates = ['削除', 'Delete'];
    expect(matchesAnyName('削除', candidates)).toBe(true);
    expect(matchesAnyName('Delete', candidates)).toBe(true);
  });

  it('T-LOC-89: 半角カナと全角カナは同じとみなす', () => {
    expect(matchesAnyName('ｻｲﾝｲﾝ', ['サインイン'])).toBe(true);
  });

  it('T-LOC-90: 完全一致の照合では、部分一致は一致とみなさない', () => {
    expect(matchesAnyName('Delete account', ['Delete'])).toBe(false);
    expect(containsAnyName('Delete account', ['delete'])).toBe(true);
  });
});

describe('空になる候補', () => {
  it('R-LOC-8: 正規化すると空文字になる候補は、完全一致の照合に使わない', () => {
    expect(matchesAnyName('', [''])).toBe(false);
    expect(matchesAnyName('', ['  \n'])).toBe(false);
    expect(matchesAnyName('削除', ['', '削除'])).toBe(true);
  });

  it('R-LOC-8: 正規化すると空文字になる候補は、部分一致の照合に使わない', () => {
    expect(containsAnyName('削除', [''])).toBe(false);
    expect(containsAnyName('削除', [' ', '　'])).toBe(false);
    expect(containsAnyName('アカウント削除', ['', '削除'])).toBe(true);
  });
});
