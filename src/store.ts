import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { stateDbPath } from "./paths.js";

const nodeRequire = createRequire(import.meta.url);

function sqliteCtor(): typeof DatabaseSync {
  return (nodeRequire("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
}

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  args_json TEXT NOT NULL,
  output_hash TEXT,
  file_path TEXT,
  status TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_calls_sig ON calls(session_id, tool_name, args_hash, ts);
CREATE INDEX IF NOT EXISTS idx_calls_out ON calls(session_id, tool_name, output_hash, ts);
CREATE INDEX IF NOT EXISTS idx_calls_time ON calls(ts);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(session_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(ts);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_session ON blocks(session_id, ts);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

let db: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (db) return db;
  const file = stateDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new (sqliteCtor())(file);
  d.exec("PRAGMA journal_mode = WAL;");
  migrate(d);
  db = d;
  return db;
}

function migrate(d: DatabaseSync): void {
  d.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);");
  const row = d.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string } | undefined;
  const version = row ? Number(row.v) : 0;
  if (version !== SCHEMA_VERSION) {
    d.exec("DROP TABLE IF EXISTS calls; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS blocks;");
    d.exec(SCHEMA);
    d.prepare(
      "INSERT INTO meta (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ).run(String(SCHEMA_VERSION));
  } else {
    d.exec(SCHEMA);
  }
}

export function resetDbForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface CallRow {
  tool_name: string;
  args_hash: string;
  args_json: string;
  output_hash: string | null;
  file_path: string | null;
  status: string;
  ts: number;
}

export function recordCall(call: {
  sessionId: string;
  toolName: string;
  argsHash: string;
  argsJson: string;
  outputHash: string | null;
  filePath: string | null;
  status: "ok" | "failure";
  ts?: number;
}): void {
  openDb()
    .prepare(
      "INSERT INTO calls (session_id, tool_name, args_hash, args_json, output_hash, file_path, status, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      call.sessionId,
      call.toolName,
      call.argsHash,
      call.argsJson,
      call.outputHash,
      call.filePath,
      call.status,
      call.ts ?? Date.now(),
    );
}

export function callsSince(sessionId: string, sinceTs: number, limit = 500): CallRow[] {
  return openDb()
    .prepare(
      "SELECT tool_name, args_hash, args_json, output_hash, file_path, status, ts FROM calls WHERE session_id = ? AND ts >= ? ORDER BY ts ASC LIMIT ?",
    )
    .all(sessionId, sinceTs, limit) as unknown as CallRow[];
}

export function recordEvent(sessionId: string, kind: string, meta: Record<string, unknown>, ts = Date.now()): void {
  openDb()
    .prepare("INSERT INTO events (session_id, kind, meta_json, ts) VALUES (?, ?, ?, ?)")
    .run(sessionId, kind, JSON.stringify(meta), ts);
}

export function countEvents(sessionId: string, kinds: string[], sinceTs: number): number {
  const placeholders = kinds.map(() => "?").join(",");
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND kind IN (${placeholders}) AND ts >= ?`,
    )
    .get(sessionId, ...kinds, sinceTs) as { n: number };
  return Number(row?.n ?? 0);
}

export function recordBlock(sessionId: string, toolName: string, kind: string, ts = Date.now()): void {
  openDb()
    .prepare("INSERT INTO blocks (session_id, tool_name, kind, ts) VALUES (?, ?, ?, ?)")
    .run(sessionId, toolName, kind, ts);
}

export function countBlocks(sessionId: string, sinceTs: number): number {
  const row = openDb()
    .prepare("SELECT COUNT(*) AS n FROM blocks WHERE session_id = ? AND ts >= ?")
    .get(sessionId, sinceTs) as { n: number };
  return Number(row?.n ?? 0);
}

export function pruneOlderThan(ts: number): void {
  const d = openDb();
  d.prepare("DELETE FROM calls WHERE ts < ?").run(ts);
  d.prepare("DELETE FROM events WHERE ts < ?").run(ts);
  d.prepare("DELETE FROM blocks WHERE ts < ?").run(ts);
}

export function getMeta(key: string): string | undefined {
  const row = openDb().prepare("SELECT v FROM meta WHERE k = ?").get(key) as { v: string } | undefined;
  return row?.v;
}

export function setMeta(key: string, value: string): void {
  openDb()
    .prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(key, value);
}

export function knownSessions(limit = 5): Array<{ session_id: string; last_ts: number; n: number }> {
  return openDb()
    .prepare(
      `SELECT session_id, MAX(last_ts) AS last_ts, SUM(n) AS n FROM (
         SELECT session_id, MAX(ts) AS last_ts, COUNT(*) AS n FROM calls GROUP BY session_id
         UNION ALL
         SELECT session_id, MAX(ts) AS last_ts, COUNT(*) AS n FROM events GROUP BY session_id
       ) GROUP BY session_id ORDER BY last_ts DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ session_id: string; last_ts: number; n: number }>;
}

export interface StatusReport {
  calls24h: number;
  blocks24h: Array<{ kind: string; n: number }>;
  topRepeated: Array<{ tool_name: string; args_hash: string; n: number }>;
  noGainPairs: Array<{ tool_name: string; n: number }>;
  events24h: Array<{ kind: string; n: number }>;
  lastActivityTs: number | null;
}

export function buildStatus(): StatusReport {
  const d = openDb();
  const now = Date.now();
  const day = now - 86_400_000;
  const calls24h = Number((d.prepare("SELECT COUNT(*) AS n FROM calls WHERE ts >= ?").get(day) as { n: number }).n);
  const blocks24h = (
    d.prepare("SELECT kind, COUNT(*) AS n FROM blocks WHERE ts >= ? GROUP BY kind").all(day) as Array<{ kind: string; n: number }>
  ).map((r) => ({ kind: r.kind, n: Number(r.n) }));
  const topRepeated = (
    d
      .prepare(
        "SELECT tool_name, args_hash, COUNT(*) AS n FROM calls WHERE ts >= ? GROUP BY session_id, tool_name, args_hash ORDER BY n DESC LIMIT 5",
      )
      .all(day) as Array<{ tool_name: string; args_hash: string; n: number }>
  ).map((r) => ({ tool_name: r.tool_name, args_hash: r.args_hash, n: Number(r.n) }));
  const noGainPairs = (
    d
      .prepare(
        "SELECT tool_name, COUNT(DISTINCT session_id || ':' || output_hash) AS n FROM calls WHERE ts >= ? AND output_hash IS NOT NULL GROUP BY tool_name ORDER BY n DESC LIMIT 5",
      )
      .all(day) as Array<{ tool_name: string; n: number }>
  ).map((r) => ({ tool_name: r.tool_name, n: Number(r.n) }));
  const events24h = (
    d.prepare("SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind").all(day) as Array<{ kind: string; n: number }>
  ).map((r) => ({ kind: r.kind, n: Number(r.n) }));
  const lastActivity = d.prepare("SELECT MAX(ts) AS m FROM calls").get() as { m: number | null };
  return {
    calls24h,
    blocks24h,
    topRepeated,
    noGainPairs,
    events24h,
    lastActivityTs: lastActivity?.m ?? null,
  };
}
