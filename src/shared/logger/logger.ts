/**
 * レベル付きのロガー。出来事ごとのスキーマで検査し、通ったものだけを sink とコンソールへ出す。
 * 通らなかったものは内容を捨て、出来事の名前だけの `logger.invalid`（warn）にする。
 * 検査はレベルの判定より先に行う。sink やコンソールの失敗は呼び出し元へ伝えない。
 */
import type { EventFields, EventName } from './events.ts';
import { LEVEL_RANK, type Ctx, type Level } from './primitives.ts';
import { checkFields, type LogEntry } from './validate.ts';

/** ログの送り先。ページ側・サイドパネルはバックグラウンドへの送信、バックグラウンドは logstore。 */
export type LogSink = (entry: LogEntry) => void;

export type ConsoleLike = Pick<Console, 'error' | 'warn' | 'info' | 'debug'>;

export interface LoggerDeps {
  now?: () => number;
  console?: ConsoleLike;
}

export type LogMethod = <E extends EventName>(event: E, fields: EventFields[E]) => void;
export interface Logger {
  error: LogMethod;
  warn: LogMethod;
  info: LogMethod;
  debug: LogMethod;
}

/** 出来事名・項目を検査前の値で受ける口。受信データの取り込みと、検査の試験に使う。 */
export interface RawLogger {
  log(level: Level, event: string, fields: unknown): void;
}

export function createRawLogger(
  ctx: Ctx,
  sink: LogSink,
  getLevel: () => Level,
  deps: LoggerDeps = {},
): RawLogger {
  const now = deps.now ?? Date.now;
  const out = deps.console ?? console;

  const emit = (level: Level, event: EventName, fields: Record<string, unknown>): void => {
    if (LEVEL_RANK[level] > LEVEL_RANK[getLevel()]) return;
    const entry: LogEntry = { ts: now(), level, ctx, event, fields };
    try {
      sink(entry);
    } catch {
      // 送り先の失敗でログの呼び出し元を止めない
    }
    try {
      out[level](`[${ctx}] ${event}`, fields);
    } catch {
      // コンソールの失敗も同様
    }
  };

  return {
    log(level, event, fields) {
      const checked = checkFields(event, fields);
      if (checked.ok) {
        emit(level, checked.value.event, checked.value.fields);
        return;
      }
      emit('warn', 'logger.invalid', { event: checked.event });
    },
  };
}

export function createLogger(
  ctx: Ctx,
  sink: LogSink,
  getLevel: () => Level,
  deps: LoggerDeps = {},
): Logger {
  const raw = createRawLogger(ctx, sink, getLevel, deps);
  const method =
    (level: Level): LogMethod =>
    (event, fields) => {
      raw.log(level, event, fields);
    };
  return {
    error: method('error'),
    warn: method('warn'),
    info: method('info'),
    debug: method('debug'),
  };
}
