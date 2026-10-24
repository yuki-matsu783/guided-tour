import { describe, expect, it } from 'vitest';
import {
  FIRST_GEN,
  INITIAL_REV,
  nextGen,
  nextRev,
  newOpId,
  newSessionId,
  parseGen,
  parseOpId,
  parsePageSeq,
  parseRev,
  parseSessionId,
  type Gen,
  type OpId,
  type SessionId,
} from './index.ts';

describe('識別子', () => {
  it('ランダムな SessionId・OpId を作り、毎回違う', () => {
    const a = newSessionId();
    expect(newSessionId()).not.toBe(a);
    expect(parseSessionId(a)).toBe(a);
    expect(parseOpId(newOpId())).not.toBeNull();
  });

  it('外から来た文字列は検証を通ったものだけ識別子になる', () => {
    expect(parseSessionId('s1')).toBe('s1');
    expect(parseSessionId('')).toBeNull();
    expect(parseSessionId('a b')).toBeNull();
    expect(parseSessionId(1)).toBeNull();
    expect(parseOpId('x'.repeat(65))).toBeNull();
  });

  it('Gen・PageSeq・Rev は非負整数だけ', () => {
    expect(parseGen(0)).toBe(0);
    expect(parseGen(-1)).toBeNull();
    expect(parseGen(1.5)).toBeNull();
    expect(parseGen('1')).toBeNull();
    expect(parsePageSeq(3)).toBe(3);
    expect(parseRev(null)).toBeNull();
    expect(nextGen(FIRST_GEN)).toBe(2);
    expect(nextRev(INITIAL_REV)).toBe(1);
  });

  it('string や number を直接は代入できない（型）', () => {
    // @ts-expect-error string は SessionId ではない
    const s: SessionId = 'abc';
    // @ts-expect-error SessionId と OpId は別の型
    const o: OpId = newSessionId();
    // @ts-expect-error number は Gen ではない
    const g: Gen = 1;
    expect([s, o, g]).toHaveLength(3);
  });
});
