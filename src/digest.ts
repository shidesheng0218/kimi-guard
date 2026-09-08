import { blockKindStats, blocksSince, countCallsSince, countCallsWindow, type BlockKindStat } from "./store.js";
import { budgetSnapshot } from "./meter.js";
import { loadConfig } from "./config.js";
import { latestSessionId } from "./checkpoint.js";
import { estSavedFromBlocks, STREAK_WINDOW_MS } from "./estSaved.js";
import { calibrationHints } from "./status.js";

const WEEK = 7 * 86_400_000;

export interface DigestData {
  weeks: number;
  calls: number;
  blocksByKind: Array<{ kind: string; n: number }>;
  estSaved: number;
  fiveHourPercent: number;
  weeklyPercent: number;
  calibration: string[];
  allTimeFp: number;
  allTimeBlocks: number;
}

export function buildDigest(weeks = 1, now = Date.now()): DigestData {
  const cfg = loadConfig();
  const since = now - weeks * WEEK;
  const sid = latestSessionId() ?? "unknown";
  const snap = budgetSnapshot(sid, cfg.budget, now);
  const blocks = blocksSince(since);
  const kindStats = [...blocks.reduce((m, b) => m.set(b.kind, (m.get(b.kind) ?? 0) + 1), new Map<string, number>())].map(([kind, n]) => ({ kind, n }));
  const allTime: BlockKindStat[] = blockKindStats();
  return {
    weeks,
    calls: countCallsSince(since),
    blocksByKind: kindStats,
    estSaved: estSavedFromBlocks(blocks, (b) => countCallsWindow(b.session_id, b.tool_name, b.ts - STREAK_WINDOW_MS, b.ts)),
    fiveHourPercent: snap.fiveHour.percent,
    weeklyPercent: snap.weekly.percent,
    calibration: calibrationHints(allTime),
    allTimeFp: allTime.reduce((a, k) => a + k.fp, 0),
    allTimeBlocks: allTime.reduce((a, k) => a + k.n, 0),
  };
}

/** Markdown version of the digest — shareable with the team. */
export function formatDigestMarkdown(d: DigestData, generatedAt = Date.now()): string {
  const label = d.weeks === 1 ? "this week" : `last ${d.weeks} weeks`;
  const totalBlocks = d.blocksByKind.reduce((a, k) => a + k.n, 0);
  const lines: string[] = [
    `# agent-guard weekly digest (${label})`,
    "",
    `_generated ${new Date(generatedAt).toISOString()} — local data only_`,
    "",
    "| metric | value |",
    "|---|---|",
    `| tool calls observed | ${d.calls} |`,
    `| interventions | ${totalBlocks} |`,
    `| est. requests saved (heuristic) | ~${d.estSaved} |`,
    `| quota 5h / weekly | ${d.fiveHourPercent}% / ${d.weeklyPercent}% |`,
  ];
  if (d.blocksByKind.length > 0) {
    lines.push("", "## interventions by detector", "");
    for (const k of d.blocksByKind) lines.push(`- **${k.kind}** ×${k.n}`);
  } else {
    lines.push("", "_no interventions — agents behaved_");
  }
  if (d.allTimeFp > 0) lines.push("", `feedback so far: ${d.allTimeFp}/${d.allTimeBlocks} blocks marked false-positive`);
  for (const h of d.calibration) lines.push("", `> ⚠️ calibration: ${h}`);
  lines.push("", "---", "_estimates are heuristic: every block is credited with the wasted calls it plausibly prevented_");
  return lines.join("\n") + "\n";
}

export function formatDigest(d: DigestData): string {
  const label = d.weeks === 1 ? "this week" : `last ${d.weeks} weeks`;
  const lines: string[] = [`agent-guard digest (${label})`, ""];
  if (d.calls === 0 && d.blocksByKind.length === 0) {
    lines.push("  no agent activity recorded — the guard saw nothing this period.");
    return lines.join("\n");
  }
  const totalBlocks = d.blocksByKind.reduce((a, k) => a + k.n, 0);
  lines.push(`  ${d.calls} tool calls observed · ${totalBlocks} interventions`);
  if (d.blocksByKind.length > 0) {
    lines.push(`  ${d.blocksByKind.map((k) => `${k.kind}×${k.n}`).join(", ")}`);
    lines.push(`  est. requests saved: ~${d.estSaved} (heuristic — blocks stop loops early)`);
  } else {
    lines.push("  no interventions — agents behaved");
  }
  lines.push(`  quota: 5h ${d.fiveHourPercent}% · weekly ${d.weeklyPercent}%`);
  if (d.allTimeFp > 0) {
    lines.push(`  feedback so far: ${d.allTimeFp}/${d.allTimeBlocks} blocks marked false-positive`);
  }
  for (const h of d.calibration) lines.push(`  ! calibration: ${h}`);
  lines.push("", "  (estimates are heuristic: every block is credited with the wasted calls it plausibly prevented)");
  return lines.join("\n");
}
