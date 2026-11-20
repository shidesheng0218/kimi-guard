import path from "node:path";

/**
 * Cross-platform way to invoke the TypeScript CLI under test.
 * `node_modules/.bin/tsx` is a shell script on POSIX and a .cmd on Windows —
 * neither is executable via `execFile(node, ...)`, so always drive node with
 * tsx's real JS entry.
 */
export function tsxCli(): string[] {
  return [process.execPath, path.join(import.meta.dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs")];
}

/** node + tsx entry + the given CLI args. */
export function tsxArgs(...args: string[]): [string, string[]] {
  const [node, tsx] = tsxCli() as [string, string];
  return [node, [tsx, ...args]];
}