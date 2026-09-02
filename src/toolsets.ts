import type { GuardConfig } from "./config.js";

export type HarnessName = "kimi" | "claude" | "codex";

/**
 * Canonical tool-name taxonomy. Every place that classifies a call by tool
 * name (edit/read/search/shell) reads through the helpers below, so an
 * upstream tool rename is fixed in ONE config section: [tools].
 */
export const DEFAULT_EDIT_TOOLS = ["WriteFile", "StrReplaceFile", "Edit", "Write", "MultiEdit", "NotebookEdit"];
export const DEFAULT_READ_TOOLS = ["ReadFile", "Read"];
export const DEFAULT_SEARCH_TOOLS = ["Grep", "Glob"];
export const DEFAULT_SHELL_TOOLS = ["Shell", "Bash"];

/** Claude Code tool names (hooks report these verbatim). */
export const CLAUDE_EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
export const CLAUDE_READ_TOOLS = ["Read"];
export const CLAUDE_SEARCH_TOOLS = ["Grep", "Glob"];
export const CLAUDE_SHELL_TOOLS = ["Bash"];

/**
 * Codex CLI tool names. Codex hooks report shell/unified-exec as `Bash` and
 * file edits as `apply_patch`. Codex has no dedicated read/search tool names
 * (reads go through shell or MCP) — read/search classifiers are intentionally
 * empty here, so exploration-drift stays silent on Codex.
 */
export const CODEX_EDIT_TOOLS = ["apply_patch", "Edit", "Write"];
export const CODEX_READ_TOOLS: string[] = [];
export const CODEX_SEARCH_TOOLS: string[] = [];
export const CODEX_SHELL_TOOLS = ["Bash"];

export interface ToolDefaults {
  edit: string[];
  read: string[];
  search: string[];
  shell: string[];
}

export function toolDefaultsFor(harness: HarnessName): ToolDefaults {
  if (harness === "claude")
    return { edit: [...CLAUDE_EDIT_TOOLS], read: [...CLAUDE_READ_TOOLS], search: [...CLAUDE_SEARCH_TOOLS], shell: [...CLAUDE_SHELL_TOOLS] };
  if (harness === "codex")
    return { edit: [...CODEX_EDIT_TOOLS], read: [...CODEX_READ_TOOLS], search: [...CODEX_SEARCH_TOOLS], shell: [...CODEX_SHELL_TOOLS] };
  return { edit: [...DEFAULT_EDIT_TOOLS], read: [...DEFAULT_READ_TOOLS], search: [...DEFAULT_SEARCH_TOOLS], shell: [...DEFAULT_SHELL_TOOLS] };
}

/**
 * Trust the list verbatim — loadConfig always populates cfg.tools from harness
 * defaults (an empty list is intentional, e.g. Codex has no read/search tools).
 */
function resolve(list: string[]): Set<string> {
  return new Set(list);
}

export function editTools(cfg: GuardConfig): Set<string> {
  return resolve(cfg.tools.edit);
}

export function readTools(cfg: GuardConfig): Set<string> {
  return resolve(cfg.tools.read);
}

export function searchTools(cfg: GuardConfig): Set<string> {
  return resolve(cfg.tools.search);
}

export function shellTools(cfg: GuardConfig): Set<string> {
  return resolve(cfg.tools.shell);
}
