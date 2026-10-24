/**
 * ページ側・サイドパネルからバックグラウンドへ送る `LOG{entries[]}` メッセージ。
 * 送る側は検査済みの1行ずつを包んで送り、受け取る側は `parseLogMessage` で1行ずつ再検査する。
 */
import { z } from 'zod';
import type { LogSink } from './logger.ts';
import { parseLogEntry, type Checked, type LogEntry } from './validate.ts';

export interface LogMessage {
  type: 'LOG';
  entries: LogEntry[];
}

const LogMessageShape = z.object({
  type: z.literal('LOG'),
  entries: z.array(z.unknown()),
});

/** 送信関数（`chrome.runtime.sendMessage` など）を sink にする。送信の失敗は握りつぶす。 */
export function createMessageSink(send: (message: LogMessage) => unknown): LogSink {
  return (entry) => {
    try {
      void Promise.resolve(send({ type: 'LOG', entries: [entry] })).catch(() => undefined);
    } catch {
      // 受け手がいなくても呼び出し元を止めない
    }
  };
}

/**
 * 受信した値を LOG メッセージとして読み、各行を検査する。形が合わなければ null。
 * 通らない行は `Checked` の失敗（出来事の名前だけ）で返す。
 */
export function parseLogMessage(raw: unknown): Checked<LogEntry>[] | null {
  const message = LogMessageShape.safeParse(raw);
  if (!message.success) return null;
  return message.data.entries.map((e) => parseLogEntry(e));
}
