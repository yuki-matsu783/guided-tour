/**
 * ログレベルの取得。`storage.local` の `settings.logLevel` を読み、`storage.onChanged` で更新する。
 * 未設定・不正な値は既定（warn）として扱う。storage は差し込めるようにしてある。
 */
import { z } from 'zod';
import { DEFAULT_LEVEL, LevelSchema, type Level } from './primitives.ts';

const SettingsSchema = z.looseObject({ logLevel: z.unknown() });

/** 保存された settings の値からレベルを取り出す。読めなければ既定。 */
export function levelFromSettings(settings: unknown): Level {
  const parsed = SettingsSchema.safeParse(settings);
  if (!parsed.success) return DEFAULT_LEVEL;
  const level = LevelSchema.safeParse(parsed.data.logLevel);
  return level.success ? level.data : DEFAULT_LEVEL;
}

export interface LevelStorage {
  get(key: string): Promise<Record<string, unknown>>;
}
export interface LevelChangeEvent {
  addListener(
    listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void,
  ): void;
  removeListener(
    listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void,
  ): void;
}

export interface LevelSource {
  get(): Level;
  /** 最初の読み込みが終わるまで待つ。失敗しても既定のまま解決する。 */
  ready: Promise<void>;
  dispose(): void;
}

export function createLevelSource(deps: {
  storage: LevelStorage;
  onChanged: LevelChangeEvent;
}): LevelSource {
  let current: Level = DEFAULT_LEVEL;
  const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string): void => {
    if (areaName !== 'local') return;
    const change = changes.settings;
    if (change) current = levelFromSettings(change.newValue);
  };
  deps.onChanged.addListener(listener);
  const ready = deps.storage
    .get('settings')
    .then((items) => {
      current = levelFromSettings(items.settings);
    })
    .catch(() => {
      current = DEFAULT_LEVEL;
    });
  return {
    get: () => current,
    ready,
    dispose: () => {
      deps.onChanged.removeListener(listener);
    },
  };
}
