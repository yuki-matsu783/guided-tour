import { describe, expect, it } from 'vitest';
import { GenSchema } from '../ids/index.ts';
import { createMoveGate, MOVE_ACCEPT_DELAY_MS } from './index.ts';

const g = (n: number) => GenSchema.parse(n);

describe('移動の受け付け', () => {
  it('R-ADR73-21: 最初の表示は待たせず、送った後は gen が変わるまで送らない', () => {
    const gate = createMoveGate(() => 0);
    gate.shown(g(1));
    expect(gate.tryMove()).toBe(true);
    expect(gate.tryMove()).toBe(false);
    gate.shown(g(1));
    expect(gate.tryMove()).toBe(false);
  });

  it('R-ADR73-22: gen が変わってから499ミリ秒は受け付けず、500ミリ秒で受け付ける。release で次を許す', () => {
    let t = 100;
    const gate = createMoveGate(() => t);
    gate.shown(g(1));
    gate.shown(g(2));
    t += MOVE_ACCEPT_DELAY_MS - 1;
    expect(gate.tryMove()).toBe(false);
    t += 1;
    expect(gate.tryMove()).toBe(true);
    gate.release();
    expect(gate.tryMove()).toBe(true);
  });

  it('R-ADR73-23: null で最初の状態に戻る', () => {
    const gate = createMoveGate(() => 0);
    gate.shown(g(1));
    gate.shown(g(2));
    gate.shown(null);
    gate.shown(g(3));
    expect(gate.tryMove()).toBe(true);
  });
});
