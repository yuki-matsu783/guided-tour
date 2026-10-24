/**
 * 移動の操作（戻る・次へ・完了）の受け付けを絞る。
 * 移動を送ったら、新しい表示（`gen` が変わった描画）が届くまで次の移動を送らない。
 * 新しい表示が届いてから `MOVE_ACCEPT_DELAY_MS` の間も、移動を受け付けない。
 * ミニガイドとサイドパネルが同じ規則で使う。
 * 最初の表示（前の表示が無い）は、二重に移動する相手がいないので待たせない。
 * 時刻は注入されたものを使う。
 */
import type { Gen } from '../ids/index.ts';

/** 新しい表示が届いてから、移動の操作を受け付けるまでの待ち（ミリ秒）。 */
export const MOVE_ACCEPT_DELAY_MS = 500;

export interface MoveGate {
  /** 表示が届いたときに呼ぶ。`gen` が変わったときだけ、待ちの起点と「送った」印をやり直す。null で最初の状態に戻す。 */
  shown(gen: Gen | null): void;
  /** 今、移動を送ってよいか。true を返したときは「送った」ことにする。 */
  tryMove(): boolean;
  /** 送ったが受け付けられなかったときに、次の移動を許す。 */
  release(): void;
}

export function createMoveGate(now: () => number): MoveGate {
  let gen: Gen | null = null;
  /** 現在の表示が届いた時刻。最初の表示は null（待たせない）。 */
  let shownAt: number | null = null;
  let sent = false;
  return {
    shown(next) {
      if (next === gen) return;
      shownAt = gen === null || next === null ? null : now();
      gen = next;
      sent = false;
    },
    tryMove() {
      if (sent) return false;
      if (shownAt !== null && now() - shownAt < MOVE_ACCEPT_DELAY_MS) return false;
      sent = true;
      return true;
    },
    release() {
      sent = false;
    },
  };
}
