import fs from "node:fs";
import path from "node:path";
import { guardHome } from "./paths.js";
import { hardenPath } from "./fsSecure.js";

/**
 * Retention for the artifacts the state DB pruner does not cover:
 * raw run logs (`runs/`), auto-checkpoints (`checkpoints/`) and incident
 * reports (`incidents/`). These contain model output and command text, so
 * they must not accumulate forever.
 *
 * `0` disables pruning for that category.
 */
export interface RetentionConfig {
  runsDays: number;
  checkpointsDays: number;
  incidentsDays: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  runsDays: 30,
  checkpointsDays: 30,
  incidentsDays: 90,
};

const DAY = 86_400_000;

export interface PruneResult {
  runs: number;
  checkpoints: number;
  incidents: number;
  bytes: number;
}

export interface PruneOptions {
  dryRun?: boolean;
  /** cap entries examined per category (the hook path passes a small cap) */
  maxEntries?: number;
}

function rm(p: string, dryRun: boolean): void {
  if (dryRun) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let n = 0;
    for (const d of fs.readdirSync(p)) n += sizeOf(path.join(p, d));
    return n;
  } catch {
    return 0;
  }
}

function readdir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

export function pruneArtifacts(
  now = Date.now(),
  rc: RetentionConfig = DEFAULT_RETENTION,
  opts: PruneOptions = {},
): PruneResult {
  const res: PruneResult = { runs: 0, checkpoints: 0, incidents: 0, bytes: 0 };
  const limit = opts.maxEntries ?? Infinity;
  const dryRun = opts.dryRun === true;
  const expired = (mtimeMs: number, days: number): boolean => days > 0 && now - mtimeMs > days * DAY;

  // runs/<runId>/ — mtime is the last write; started-long-ago-but-recent runs stay
  const runsDir = path.join(guardHome(), "runs");
  let examined = 0;
  for (const name of readdir(runsDir)) {
    if (examined++ >= limit) break;
    const p = path.join(runsDir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory() || !expired(st.mtimeMs, rc.runsDays)) continue;
      res.bytes += sizeOf(p);
      rm(p, dryRun);
      res.runs++;
    } catch {
      /* ignore */
    }
  }

  // checkpoints/<session>/<ts>-<reason>.md — prune files, then empty session dirs
  const cpDir = path.join(guardHome(), "checkpoints");
  examined = 0;
  for (const name of readdir(cpDir)) {
    if (examined++ >= limit) break;
    const sdir = path.join(cpDir, name);
    try {
      if (!fs.statSync(sdir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdir(sdir)) {
      if (examined++ >= limit) break;
      if (!f.endsWith(".md")) continue;
      const fp = path.join(sdir, f);
      try {
        const st = fs.statSync(fp);
        if (!expired(st.mtimeMs, rc.checkpointsDays)) continue;
        res.bytes += st.size;
        rm(fp, dryRun);
        res.checkpoints++;
      } catch {
        /* ignore */
      }
    }
    if (readdir(sdir).length === 0) rm(sdir, dryRun);
  }

  // incidents/<runId>.md
  const incDir = path.join(guardHome(), "incidents");
  examined = 0;
  for (const f of readdir(incDir)) {
    if (examined++ >= limit) break;
    if (!f.endsWith(".md")) continue;
    const fp = path.join(incDir, f);
    try {
      const st = fs.statSync(fp);
      if (!expired(st.mtimeMs, rc.incidentsDays)) continue;
      res.bytes += st.size;
      rm(fp, dryRun);
      res.incidents++;
    } catch {
      /* ignore */
    }
  }

  return res;
}

/**
 * Tighten permissions on artifacts created by older versions (which used the
 * process umask). Safe to run repeatedly; Windows mode bits are a no-op.
 */
export function hardenArtifacts(): number {
  const home = guardHome();
  if (!fs.existsSync(home)) return 0;
  let n = 0;
  const dir = (p: string): void => {
    hardenPath(p, 0o700);
    n++;
  };
  const file = (p: string): void => {
    hardenPath(p, 0o600);
    n++;
  };
  dir(home);
  for (const sub of ["runs", "checkpoints", "incidents", "bench"]) {
    const base = path.join(home, sub);
    if (!fs.existsSync(base)) continue;
    dir(base);
    for (const name of readdir(base)) {
      const p = path.join(base, name);
      try {
        if (fs.statSync(p).isDirectory()) {
          dir(p);
          for (const f of readdir(p)) {
            const fp = path.join(p, f);
            try {
              if (fs.statSync(fp).isFile()) file(fp);
            } catch {
              /* ignore */
            }
          }
        } else {
          file(p);
        }
      } catch {
        /* ignore */
      }
    }
  }
  for (const f of ["state.db", "state.db-wal", "state.db-shm", "config.toml", "probe.jsonl"]) {
    const fp = path.join(home, f);
    if (fs.existsSync(fp)) file(fp);
  }
  return n;
}