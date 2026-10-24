/**
 * 起動時の処理。ツアー管理の組み立て → ログの保管の起動時の削除 → 状態管理の復帰 → アクションのクリックで
 * サイドパネルを開く設定、の順に行う。復帰はツアー管理を読むので、必ず後に置く。
 * 1つが失敗しても、残りは続ける（失敗は例外名と理由コードだけを記録する）。
 * `onInstalled`（更新を含む）と Service Worker の起動の両方から呼ばれるが、同じ起動の間は1回しか行わない。
 */
import { errorFields, type Logger } from '../../shared/logger/index.ts';
import type { LogStore } from '../logstore/index.ts';
import type { CatalogPort } from '../ports.ts';
import type { Session } from '../session/index.ts';

export interface StartupDeps {
  readonly catalog: Pick<CatalogPort, 'reload'>;
  readonly logstore: Pick<LogStore, 'start'>;
  readonly session: Pick<Session, 'recover'>;
  readonly sidePanel: {
    setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<unknown>;
  };
  readonly logger: Pick<Logger, 'error'>;
}

export interface Startup {
  /** 起動処理を始める（すでに始めていれば、その完了を返す）。例外は投げない。 */
  start(): Promise<void>;
  /** 起動処理の完了。`start` を呼ぶ前は、呼ぶまで待つ。 */
  ready(): Promise<void>;
}

export function createStartup(deps: StartupDeps): Startup {
  let running: Promise<void> | null = null;
  let signal: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    signal = resolve;
  });

  async function step(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      deps.logger.error('error', errorFields(error, 'unknown'));
    }
  }

  async function runAll(): Promise<void> {
    await step(() => deps.catalog.reload());
    await step(() => deps.logstore.start());
    await step(() => deps.session.recover());
    await step(() => deps.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));
  }

  return {
    start() {
      running ??= runAll();
      signal();
      return running;
    },
    async ready() {
      await started;
      await running;
    },
  };
}
