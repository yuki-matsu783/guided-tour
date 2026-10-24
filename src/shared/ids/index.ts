/**
 * 実行場所の間でやり取りする識別子の型と、作る・検証する関数。
 * `SessionId`・`OpId` はランダムな識別子で、作れるのは `newSessionId`・`newOpId`（crypto.randomUUID）と、
 * 外から来た文字列を zod で検証する `parseSessionId`・`parseOpId` だけ。ただの string は代入できない。
 * `Gen`・`PageSeq`・`Rev` は非負整数で、検証する `parse*` と、1進める `next*` だけが作る。
 * 識別子はログに出してよい形（英数字・`_`・`-` の64文字まで）に限る。
 */
import { z } from 'zod';

const idString = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const SessionIdSchema = idString.brand<'SessionId'>();
export type SessionId = z.output<typeof SessionIdSchema>;

export const OpIdSchema = idString.brand<'OpId'>();
export type OpId = z.output<typeof OpIdSchema>;

const counter = z.int().nonnegative();

/** 表示世代。ステップに入るたびに増える。 */
export const GenSchema = counter.brand<'Gen'>();
export type Gen = z.output<typeof GenSchema>;

/** ページ世代。役割のタブで新しい文書・URL 変更を検知するたびに増える。 */
export const PageSeqSchema = counter.brand<'PageSeq'>();
export type PageSeq = z.output<typeof PageSeqSchema>;

/** 描画の版。実行回をまたいで単調に増える。 */
export const RevSchema = counter.brand<'Rev'>();
export type Rev = z.output<typeof RevSchema>;

export function newSessionId(): SessionId {
  return SessionIdSchema.parse(crypto.randomUUID());
}

export function newOpId(): OpId {
  return OpIdSchema.parse(crypto.randomUUID());
}

/** 検証を通らなければ null。 */
export function parseSessionId(raw: unknown): SessionId | null {
  const r = SessionIdSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parseOpId(raw: unknown): OpId | null {
  const r = OpIdSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parseGen(raw: unknown): Gen | null {
  const r = GenSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parsePageSeq(raw: unknown): PageSeq | null {
  const r = PageSeqSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parseRev(raw: unknown): Rev | null {
  const r = RevSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** 実行回の最初の表示世代。 */
export const FIRST_GEN: Gen = GenSchema.parse(1);
/** ページ世代の初期値。 */
export const INITIAL_PAGE_SEQ: PageSeq = PageSeqSchema.parse(0);
/** 描画の版の初期値（まだ何も送っていない）。 */
export const INITIAL_REV: Rev = RevSchema.parse(0);

export function nextGen(gen: Gen): Gen {
  return GenSchema.parse(gen + 1);
}

export function nextPageSeq(pageSeq: PageSeq): PageSeq {
  return PageSeqSchema.parse(pageSeq + 1);
}

export function nextRev(rev: Rev): Rev {
  return RevSchema.parse(rev + 1);
}
