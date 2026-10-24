/**
 * 取り込み（importFiles）の入出力の型。依存（IndexedDB・確認・通知・時刻）は呼び出し側が渡す。
 */
import type { Issue } from '../../core/tour/index.ts';

export type { Issue };

/** 上書きの確認に渡す情報。 */
export interface OverwriteRequest {
  tourId: string;
  /** 置き換える相手。取り込み済みがあればそれ（`imported`）、同梱だけなら `bundled` */
  existingSource: 'bundled' | 'imported';
  /** 置き換えるツアーが実行中か（承認すると一時中断になる） */
  running: boolean;
}

export interface CatalogChange {
  tourId: string;
  hash: string;
}

export interface ImportDeps {
  /** `openDb` の結果 */
  db: IDBDatabase;
  /** 上書きの確認。承認なら true */
  confirmOverwrite: (request: OverwriteRequest) => Promise<boolean>;
  /** 同梱ツアーの ID の一覧 */
  getBundledTourIds: () => readonly string[] | Promise<readonly string[]>;
  /** 実行中のツアーの ID（なければ null） */
  getRunningTourId: () => string | null | Promise<string | null>;
  /** バックグラウンドへの `CATALOG_CHANGED` の送信。失敗しても取り込みは成功とする */
  notifyCatalogChanged: (change: CatalogChange) => void | Promise<void>;
  now: () => number;
  /** zip の展開の調整（試験用）。省略すると既定 */
  unzip?: { yieldToHost?: () => Promise<void>; sliceMs?: number };
}

export type ImportResult =
  | {
      status: 'imported';
      fileName: string;
      tourId: string;
      name: string;
      origins: string[];
      warnings: Issue[];
    }
  | { status: 'cancelled'; fileName: string; tourId: string; name: string }
  | { status: 'rejected'; fileName: string; errors: Issue[] };
