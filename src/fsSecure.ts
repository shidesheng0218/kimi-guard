import fs from "node:fs";

/**
 * Local state can contain shell commands, file contents, model output and
 * credentials-adjacent metadata. Everything the guard creates under its home
 * directory is owner-only; on Windows the POSIX mode bits are mostly ignored,
 * so failures are swallowed there.
 *
 * All helpers are best-effort: a permission tightening must never break a hook.
 */

const IS_WINDOWS = process.platform === "win32";

export function ensurePrivateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!IS_WINDOWS) fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
}

/** Create the file if needed and chmod it to 0600. */
export function ensurePrivateFile(file: string): void {
  try {
    fs.closeSync(fs.openSync(file, "a", 0o600));
    if (!IS_WINDOWS) fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** Write (truncate) a file with owner-only permissions. */
export function writePrivateFile(file: string, data: string | Buffer): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  if (!IS_WINDOWS) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
}

/** Append to a file, creating it owner-only if it does not exist. */
export function appendPrivateFile(file: string, data: string): void {
  ensurePrivateFile(file);
  fs.appendFileSync(file, data, "utf8");
}

/** Tighten an existing path; no-op on Windows or when it does not exist. */
export function hardenPath(p: string, mode: 0o700 | 0o600): void {
  if (IS_WINDOWS) return;
  try {
    fs.chmodSync(p, mode);
  } catch {
    /* missing or not ours — ignore */
  }
}