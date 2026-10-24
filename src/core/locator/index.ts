/**
 * 要素特定エンジンの公開入口。
 */
export { locate } from './locate';
export { defaultEnv, OWN_HOST_ATTRIBUTE } from './env';
export { normalizeName, matchesAnyName, containsAnyName } from './normalize';
export type {
  LocateOptions,
  LocateReason,
  LocateResult,
  LocateSummary,
  LocatorEnv,
  LocatorTarget,
  LocatorWithin,
  Tier,
  TierCount,
} from './types';
