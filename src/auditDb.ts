import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { stateDbPath } from "./paths.js";
import { sqliteCtor } from "./store.js";

/**
 * Read-only handle for `agentguard audit`.
 *
 * Unlike store.openDb(), this never creates the file, never runs migrations
 * and never writes. A machine where the guard was never used gets `null`,
 * and the caller reports "no data" instead of creating an empty DB.
 *
 * SQLite may still touch WAL sidecar files while reading; that is storage
 * behavior, not a logical write. `PRAGMA query_only` is a second guard
 * against accidental writes from future audit code.
 */
export function openAuditDb(): DatabaseSync | null {
  const file = stateDbPath();
  if (!fs.existsSync(file)) return null;

  let db: DatabaseSync;
  try {
    db = new (sqliteCtor())(file, { readOnly: true });
  } catch {
    // Some WAL setups refuse a read-only open without the -shm sidecar.
    // Fall back to a normal open; query_only still blocks writes.
    db = new (sqliteCtor())(file);
  }
  db.exec("PRAGMA query_only = ON;");
  return db;
}