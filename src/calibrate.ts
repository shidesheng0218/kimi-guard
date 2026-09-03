import { blockKindStats, callsSince, listBlocks } from "./store.js";
import { defaultConfig } from "./config.js";

/**
 * Deterministic calibration suggestions from the user's feedback loop.
 * Rules, not ML: high false-positive rate → raise that detector's thresholds;
 * repeat false-positives with a stable command prefix → suggest an exemption.
 * Never touches the config file — prints a paste-ready TOML block.
 */

const SUGGEST: Record<string, (d: typeof defaultConfig) => string> = {
  repeat: (d) => `[repeat]\nmaxRepeats = ${d.repeat.maxRepeats + 2}`,
  noGain: (d) => `[noGain]\nwarnAt = ${d.noGain.warnAt + 2}\nblockAt = ${d.noGain.blockAt + 2}`,
  noGainFuzzy: (d) => `[noGain]\nfuzzyWarnAt = ${d.noGain.fuzzyWarnAt + 2}\nfuzzyBlockAt = ${d.noGain.fuzzyBlockAt + 2}`,
  churn: (d) => `[churn]\nwarnAt = ${d.churn.warnAt + 3}\nblockAt = ${d.churn.blockAt + 3}`,
  noProgress: (d) => `[noProgress]\nwarnAt = ${d.noProgress.warnAt + 10}\nblockAt = ${d.noProgress.blockAt + 10}`,
  nearRepeat: (d) => `[nearRepeat]\nwarnAt = ${d.nearRepeat.warnAt + 4}\nblockAt = ${d.nearRepeat.blockAt + 4}`,
  explore: (d) => `[explore]\nwarnAt = ${d.explore.warnAt + 5}\nblockAt = ${d.explore.blockAt + 5}`,
  budget: (d) => `[budget]\nreservePercent = ${Math.min(30, d.budget.reservePercent + 10)}`,
  verify: () => `[verify]\nblockOnNoEvidence = false`,
  killSwitch: (d) => `[policy]\nmaxBlocksPerSession = ${d.policy.maxBlocksPerSession + 3}`,
};

export interface CalibrateReport {
  detectorSuggestions: Array<{ kind: string; fpRate: number; toml: string }>;
  exemptSuggestions: string[];
  sampleSize: number;
}

export function buildCalibrateReport(): CalibrateReport {
  const stats = blockKindStats();
  const detectorSuggestions: CalibrateReport["detectorSuggestions"] = [];
  for (const s of stats) {
    if (s.n < 5) continue;
    const rate = s.fp / s.n;
    const suggest = SUGGEST[s.kind];
    if (rate > 0.3 && suggest) {
      detectorSuggestions.push({ kind: s.kind, fpRate: Math.round(rate * 100) / 100, toml: suggest(defaultConfig) });
    }
  }

  // repeat false-positives with a stable command prefix → exemption candidates
  const fpBlocks = listBlocks(200).filter((b) => b.kind === "repeat" && b.feedback === "fp");
  const prefixes = new Map<string, number>();
  for (const b of fpBlocks) {
    for (const call of callsSince(b.session_id, b.ts - 3_600_000, 200)) {
      if (call.tool_name !== b.tool_name) continue;
      try {
        const args = JSON.parse(call.args_json) as Record<string, unknown>;
        const cmd = typeof args["command"] === "string" ? (args["command"] as string) : "";
        if (cmd) {
          const prefix = cmd.trim().split(/\s+/).slice(0, 2).join(" ");
          if (prefix) prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
        }
      } catch {
        /* skip */
      }
    }
  }
  const exemptSuggestions = [...prefixes.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([p]) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  return { detectorSuggestions, exemptSuggestions, sampleSize: stats.reduce((a, s) => a + s.n, 0) };
}

export function formatCalibrateReport(r: CalibrateReport): string {
  if (r.sampleSize === 0) return "no blocks recorded yet — nothing to calibrate";
  if (r.detectorSuggestions.length === 0 && r.exemptSuggestions.length === 0) {
    return `calibration looks fine (${r.sampleSize} blocks on record; no detector exceeds the 30% false-positive threshold)`;
  }
  const lines: string[] = ["calibration suggestions (review before pasting into your config.toml):", ""];
  for (const d of r.detectorSuggestions) {
    lines.push(`# ${d.kind}: ${Math.round(d.fpRate * 100)}% of blocks were marked false positive`, d.toml, "");
  }
  if (r.exemptSuggestions.length > 0) {
    lines.push("# repeat false-positives with a stable command prefix → exempt them:", "[repeat]", `exemptPatterns = [${r.exemptSuggestions.map((p) => JSON.stringify(p)).join(", ")}]`);
  }
  return lines.join("\n");
}
