import type { GuardConfig } from "./config.js";

/**
 * Detector threshold profiles — opinionated bundles of the defaults.
 * balanced = shipped defaults (tuned for interactive use).
 * strict   = headless/CI: intervene early, fuse sooner.
 * chill    = pairs badly with false-positive-prone setups but maximally hands-off.
 */
export type ProfileName = "balanced" | "strict" | "chill";

export const PROFILE_NAMES: ProfileName[] = ["balanced", "strict", "chill"];

export function applyProfile(cfg: GuardConfig, name: string): void {
  if (name === "strict") {
    cfg.repeat.maxRepeats = 2;
    cfg.repeat.warnAt = 1;
    cfg.noGain.warnAt = 2;
    cfg.noGain.blockAt = 3;
    cfg.noGain.fuzzyWarnAt = 3;
    cfg.noGain.fuzzyBlockAt = 4;
    cfg.churn.warnAt = 3;
    cfg.churn.blockAt = 6;
    cfg.noProgress.warnAt = 8;
    cfg.noProgress.blockAt = 15;
    cfg.nearRepeat.warnAt = 4;
    cfg.nearRepeat.blockAt = 6;
    cfg.explore.warnAt = 6;
    cfg.explore.blockAt = 10;
    cfg.policy.maxBlocksPerSession = 3;
  } else if (name === "chill") {
    cfg.repeat.maxRepeats = 5;
    cfg.repeat.warnAt = 3;
    cfg.noGain.warnAt = 5;
    cfg.noGain.blockAt = 8;
    cfg.noGain.fuzzyWarnAt = 6;
    cfg.noGain.fuzzyBlockAt = 9;
    cfg.churn.warnAt = 8;
    cfg.churn.blockAt = 15;
    cfg.noProgress.warnAt = 25;
    cfg.noProgress.blockAt = 40;
    cfg.nearRepeat.warnAt = 10;
    cfg.nearRepeat.blockAt = 15;
    cfg.explore.warnAt = 15;
    cfg.explore.blockAt = 25;
    cfg.policy.maxBlocksPerSession = 8;
  }
  // balanced: defaults, nothing to apply
  cfg.profile = PROFILE_NAMES.includes(name as ProfileName) ? name : "balanced";
}
