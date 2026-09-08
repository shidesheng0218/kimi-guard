import type { BlockKindStat, BlockRow } from "./store.js";

/**
 * Estimated requests saved by guard interventions.
 *
 * HEURISTIC, by design conservative and documented as such: a block stops a
 * loop EARLY, so each intervention is credited with the average number of
 * wasted calls it plausibly prevented. For loop-family detectors we raise the
 * estimate when the loop was OBSERVED repeating longer than the default
 * credit (the waste that almost certainly would have continued). This is not
 * an exact measurement — it exists to make invisible value visible.
 */
const LOOP_FAMILY = new Set(["repeat", "noGain", "noGainFuzzy", "nearRepeat"]);

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

/**
 * Evidence-based estimate: for loop-family blocks, credit max(default, the
 * observed streak of same-tool calls in the 30 min before the block) — a loop
 * that had already repeated N times was plausibly heading for at least N more.
 * Falls back to the flat coefficient when no streak is observed.
 */
export function estSavedFromBlocks(blocks: BlockRow[], streakFor: (b: BlockRow) => number): number {
  return blocks.reduce((acc, b) => {
    const base = estSavedForKind(b.kind);
    if (!LOOP_FAMILY.has(b.kind)) return acc + base;
    return acc + Math.max(base, streakFor(b));
  }, 0);
}

/** Default streak window: 30 minutes before the block, same session+tool. */
export const STREAK_WINDOW_MS = 30 * 60_000;
