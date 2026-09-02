import { getMeta, setMeta } from "./store.js";

/**
 * Optional precise plan-usage metering via the official Kimi Coding Plan API
 * (the same endpoint kimi-code-usage reads). Event-based accounting is the
 * fallback; this module only ever ADDS precision — every failure path returns
 * null and the guard falls back to event-based estimates.
 */

/** Structural subset of GuardConfig["budget"] — avoids a meter↔precise import cycle. */
export interface PreciseBudgetConfig {
  precise: boolean;
  preciseUrl: string;
  preciseCacheSeconds: number;
}

export interface PreciseWindow {
  used: number;
  limit: number;
  /** epoch ms when the window resets, if the API provided it */
  resetsAt: number | null;
}

export interface PreciseUsage {
  fiveHour: PreciseWindow | null;
  weekly: PreciseWindow | null;
  fetchedAt: number;
}

const DEFAULT_URL = "https://api.kimi.com/coding/v1";
const FETCH_TIMEOUT_MS = 3000;

export function preciseKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KIMI_API_KEY?.trim());
}

export function cachedPreciseUsage(cfg: PreciseBudgetConfig, now = Date.now()): PreciseUsage | null {
  if (!cfg.precise) return null;
  try {
    const raw = getMeta("precise_usage");
    const ts = Number(getMeta("precise_usage_ts") ?? "0");
    if (!raw || ts <= 0) return null;
    if (now - ts > cfg.preciseCacheSeconds * 1000) return null;
    const parsed = JSON.parse(raw) as Omit<PreciseUsage, "fetchedAt">;
    return { ...parsed, fetchedAt: ts };
  } catch {
    return null;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const n = numOrNull(obj[k]);
    if (n !== null) return n;
  }
  return null;
}

function pickResetMs(obj: Record<string, unknown>, now: number): number | null {
  for (const k of ["resetTime", "reset_at", "reset_time"]) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
    if (typeof v === "string") {
      const parsed = Date.parse(v);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  const inSeconds = numOrNull(obj["reset_in"]);
  return inSeconds !== null ? now + inSeconds * 1000 : null;
}

function windowMinutes(item: Record<string, unknown>): number | null {
  const duration = numOrNull(item["duration"]);
  const unit = String(item["timeUnit"] ?? item["time_unit"] ?? "").toLowerCase();
  if (duration === null) return null;
  if (unit.includes("min")) return duration;
  if (unit.includes("hour") || unit === "h") return duration * 60;
  if (unit.includes("day") || unit === "d") return duration * 60 * 24;
  if (unit.includes("week")) return duration * 60 * 24 * 7;
  return null;
}

function toWindow(item: Record<string, unknown>, now: number): PreciseWindow | null {
  const limit = pickNum(item, ["limit", "limit_amount"]);
  const usedRaw = pickNum(item, ["used", "used_amount"]);
  const remaining = pickNum(item, ["remaining"]);
  const used = usedRaw ?? (limit !== null && remaining !== null ? limit - remaining : null);
  if (limit === null || used === null) return null;
  return { used, limit, resetsAt: pickResetMs(item, now) };
}

/**
 * Parse the official usage response. The API has shipped several payload
 * shapes (observed in kimi-code-usage's provider): a top-level `data` list,
 * or `usage`+`limits`. Items may nest windowed limits under `detail`.
 * Weekly summary items carry model_name "all"; the 5h window is identified
 * by a ~300-minute duration.
 */
export function parseUsagePayload(payload: unknown, now = Date.now()): PreciseUsage | null {
  if (payload === null || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const items: Record<string, unknown>[] = [];
  const push = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const it of v) if (it !== null && typeof it === "object") items.push(it as Record<string, unknown>);
    } else if (v !== null && typeof v === "object") {
      items.push(v as Record<string, unknown>);
    }
  };
  push(root["data"]);
  push(root["usage"]);
  push(root["limits"]);

  let fiveHour: PreciseWindow | null = null;
  let weekly: PreciseWindow | null = null;

  for (const item of items) {
    const candidates = [item];
    if (item["detail"] !== null && typeof item["detail"] === "object") candidates.push(item["detail"] as Record<string, unknown>);
    const isSummary = item["model_name"] === "all" || item["scope"] === "all";
    for (const c of candidates) {
      const win = toWindow(c, now);
      if (!win) continue;
      const mins = windowMinutes(c);
      if (mins !== null && Math.abs(mins - 300) <= 5 && !fiveHour) fiveHour = win;
      else if ((isSummary || mins === null || mins >= 60 * 24) && !weekly) weekly = win;
    }
  }

  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly, fetchedAt: now };
}

/**
 * Fetch precise usage from the official API and cache it. Honors the cache
 * TTL (preciseCacheSeconds) — never re-fetches within a fresh window. Any
 * error (network, HTTP, parse) resolves to null: event-based metering takes
 * over, so precise metering can never break the guard.
 */
export async function refreshPreciseUsage(cfg: PreciseBudgetConfig, env: NodeJS.ProcessEnv = process.env): Promise<PreciseUsage | null> {
  if (!cfg.precise || !preciseKeyConfigured(env)) return null;
  const fresh = cachedPreciseUsage(cfg);
  if (fresh) return fresh;

  const base = (cfg.preciseUrl || DEFAULT_URL).replace(/\/+$/, "");
  const key = env.KIMI_API_KEY!.trim();
  for (const path of ["/usages", "/usage"]) {
    try {
      const res = await fetch(base + path, {
        headers: { Authorization: `Bearer ${key}`, "User-Agent": "KimiCLI/1.6" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404) continue;
      if (!res.ok) return null;
      const parsed = parseUsagePayload(await res.json());
      if (!parsed) return null;
      setMeta("precise_usage", JSON.stringify({ fiveHour: parsed.fiveHour, weekly: parsed.weekly }));
      setMeta("precise_usage_ts", String(parsed.fetchedAt));
      return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/** Refresh only when enabled, keyed and stale — safe to call on hot paths. */
export async function refreshPreciseIfStale(cfg: PreciseBudgetConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    if (cfg.precise && !cachedPreciseUsage(cfg)) await refreshPreciseUsage(cfg, env);
  } catch {
    /* fail-open */
  }
}
