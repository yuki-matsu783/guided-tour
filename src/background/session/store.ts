/**
 * storage への読み書き。外から読んだ値は zod で検証し、通らなければ「無い」ものとして扱う。
 * 書き込み系は例外を投げず、成否（真偽値）を返す（失敗しても操作は続け、`saveError` に反映するため）。
 * 進捗の書き込み・削除は、同じ `sessionId` のものだけを対象にする。
 */
import type { SessionId } from '../../shared/ids/index.ts';
import {
  PENDING_DELETES_KEY,
  PROGRESS_KEY,
  PendingDeleteSchema,
  ProgressSchema,
  SETTINGS_KEY,
  STATE_KEY,
  SettingsSchema,
  TourStateSchema,
  type PendingDelete,
  type Progress,
  type Settings,
  type TourState,
} from './state.ts';
import type { StorageArea } from './types.ts';

export type ProgressMap = Record<string, Progress>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface Store {
  readState(): Promise<TourState | null>;
  writeState(state: TourState): Promise<boolean>;
  /** 読めなかったとき（storage の失敗）は null。無いときは空の対応表。 */
  readProgress(): Promise<ProgressMap | null>;
  /** 同じ `sessionId` でより大きい `gen` の記録があれば書かず、成功として返す。 */
  saveProgress(state: TourState, savedAt: number): Promise<boolean>;
  /** `tourId` の進捗が `sessionId` のものであれば削除する。別の `sessionId` のものは残す。 */
  removeProgress(tourId: string, sessionId: SessionId): Promise<boolean>;
  readPendingDeletes(): Promise<PendingDelete[] | null>;
  writePendingDeletes(list: readonly PendingDelete[]): Promise<boolean>;
  readSettings(): Promise<Settings | null>;
  writeSettings(settings: Settings): Promise<boolean>;
}

export function createStore(session: StorageArea, local: StorageArea): Store {
  async function readLocalRecord(key: string): Promise<unknown> {
    const got = await local.get(key);
    return got[key];
  }

  async function readProgress(): Promise<ProgressMap | null> {
    let raw: unknown;
    try {
      raw = await readLocalRecord(PROGRESS_KEY);
    } catch {
      return null;
    }
    const map: ProgressMap = {};
    if (!isRecord(raw)) return map;
    for (const [tourId, value] of Object.entries(raw)) {
      const parsed = ProgressSchema.safeParse(value);
      if (parsed.success) map[tourId] = parsed.data;
    }
    return map;
  }

  async function writeProgress(map: ProgressMap): Promise<boolean> {
    try {
      await local.set({ [PROGRESS_KEY]: map });
      return true;
    } catch {
      return false;
    }
  }

  return {
    async readState() {
      try {
        const got = await session.get(STATE_KEY);
        const parsed = TourStateSchema.safeParse(got[STATE_KEY]);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    async writeState(state) {
      try {
        await session.set({ [STATE_KEY]: state });
        return true;
      } catch {
        return false;
      }
    },

    readProgress,

    async saveProgress(state, savedAt) {
      const map = await readProgress();
      if (map === null) return false;
      const current = map[state.tourId];
      if (current?.sessionId === state.sessionId && current.gen > state.gen) return true;
      map[state.tourId] = {
        sessionId: state.sessionId,
        gen: state.gen,
        stepId: state.stepId,
        stepIndex: state.stepIndex,
        savedAt,
      };
      return writeProgress(map);
    },

    async removeProgress(tourId, sessionId) {
      const map = await readProgress();
      if (map === null) return false;
      if (map[tourId]?.sessionId !== sessionId) return true;
      return writeProgress(Object.fromEntries(Object.entries(map).filter(([id]) => id !== tourId)));
    },

    async readPendingDeletes() {
      let raw: unknown;
      try {
        raw = await readLocalRecord(PENDING_DELETES_KEY);
      } catch {
        return null;
      }
      if (!Array.isArray(raw)) return [];
      const list: PendingDelete[] = [];
      const items: unknown[] = raw;
      for (const item of items) {
        const parsed = PendingDeleteSchema.safeParse(item);
        if (parsed.success) list.push(parsed.data);
      }
      return list;
    },

    async writePendingDeletes(list) {
      try {
        await local.set({ [PENDING_DELETES_KEY]: list });
        return true;
      } catch {
        return false;
      }
    },

    async readSettings() {
      try {
        const raw = await readLocalRecord(SETTINGS_KEY);
        const parsed = SettingsSchema.safeParse(isRecord(raw) ? raw : {});
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    async writeSettings(settings) {
      try {
        await local.set({ [SETTINGS_KEY]: settings });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type { Progress };
