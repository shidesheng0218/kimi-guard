import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openAuditDb } from "../src/auditDb.js";
import { stateDbPath } from "../src/paths.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-auditdb-"));
  process.env.AGENT_GUARD_HOME = tmp;
});

afterEach(() => {
  delete process.env.AGENT_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Minimal calls table — enough for the read-only handle assertions. */
function seedDb(): void {
  const db = new DatabaseSync(stateDbPath());
  db.exec(`
    CREATE TABLE calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      args_json TEXT NOT NULL,
      output_hash TEXT,
      output_sample TEXT,
      file_path TEXT,
      status TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    INSERT INTO calls (session_id, tool_name, args_hash, args_json, status, ts)
    VALUES ('s1', 'Read', 'abc', '{}', 'ok', 1);
  `);
  db.close();
}

describe("openAuditDb", () => {
  it("returns null and creates no file when state.db is absent", () => {
    expect(openAuditDb()).toBeNull();
    expect(fs.existsSync(stateDbPath())).toBe(false);
  });

  it("opens an existing DB read-only and leaves row counts unchanged", () => {
    seedDb();
    const db = openAuditDb();
    expect(db).not.toBeNull();
    const count = db!.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n: number };
    expect(count.n).toBe(1);
    const pragma = db!.prepare("PRAGMA query_only").get() as { query_only: number };
    expect(pragma.query_only).toBe(1);
    db!.close();
  });

  it("rejects writes through the audit handle", () => {
    seedDb();
    const db = openAuditDb();
    expect(() => db!.exec("CREATE TABLE should_not_exist(y)")).toThrow();
    db!.close();
  });
});