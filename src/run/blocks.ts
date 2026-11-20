import { blocksSince } from "../store.js";
import type { RunReport } from "../wire/supervisor.js";

/**
 * Merge blocks recorded by the installed hooks into a supervisor run report.
 *
 * When hooks are live they do the blocking (the driver's in-process backstop is
 * disabled to avoid double records), so without this merge the report would
 * show zero interventions even though the guard blocked calls. The session id
 * must be the harness's own id (the one the hooks write under), not the run id.
 */
export function mergeHookBlocks(report: RunReport, sessionId: string, sinceTs: number): void {
  const seen = new Set(report.blocks.map((b) => `${b.ts}:${b.kind}:${b.tool}`));
  for (const b of blocksSince(sinceTs)) {
    if (b.session_id !== sessionId) continue;
    const key = `${b.ts}:${b.kind}:${b.tool_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    report.blocks.push({ tool: b.tool_name, kind: b.kind, message: b.reason ?? "", ts: b.ts });
  }
  report.blocks.sort((a, b) => a.ts - b.ts);
}