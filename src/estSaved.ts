import type { BlockKindStat } from "./store.js";

/**
 * Estimated requests saved by guard interventions.
 *
 * HEURISTIC, by design conservative and documented as such: a block stops a
 * loop EARLY, so each intervention is credited with the average number of
 * wasted calls it plausibly prevented. This is not an exact measurement —
 * it exists to make invisible value visible, not for billing.
 */
const SAVED_PER_BLOCK: Record<string, number> = {
  repeat: 5,
  noGain: 5,
  noGainFuzzy: 5,
  nearRepeat: 5,
  churn: 3,
  noProgress: 2,
  explore: 2,
};

export function estSavedForKind(kind: string): number {
  return SAVED_PER_BLOCK[kind] ?? 1;
}

export interface EstSaved {
  total: number;
  byKind: Array<{ kind: string; blocks: number; saved: number }>;
}

export function estimateSaved(stats: BlockKindStat[]): EstSaved {
  const byKind = stats.map((k) => ({ kind: k.kind, blocks: k.n, saved: k.n * estSavedForKind(k.kind) }));
  return { total: byKind.reduce((a, k) => a + k.saved, 0), byKind: byKind.filter((k) => k.blocks > 0) };
}

/** Block kind stats over a window (blockKindStats is all-time; this is time-boxed). */
export interface WindowKindStat {
  kind: string;
  n: number;
}

export function estSavedFromWindow(stats: WindowKindStat[]): number {
  return stats.reduce((a, k) => a + k.n * estSavedForKind(k.kind), 0);
}
