import type { GuardConfig } from "./config.js";

/**
 * Canonical tool-name taxonomy. Every place that classifies a call by tool
 * name (edit/read/search/shell) reads through the helpers below, so an
 * upstream tool rename is fixed in ONE config section: [tools].
 */
export const DEFAULT_EDIT_TOOLS = ["WriteFile", "StrReplaceFile", "Edit", "Write", "MultiEdit", "NotebookEdit"];
export const DEFAULT_READ_TOOLS = ["ReadFile", "Read"];
export const DEFAULT_SEARCH_TOOLS = ["Grep", "Glob"];
export const DEFAULT_SHELL_TOOLS = ["Shell", "Bash"];

function resolve(list: string[], fallback: string[]): Set<string> {
  return new Set(list.length > 0 ? list : fallback);
}

export function editTools(cfg: GuardConfig): Set<string> {
  return resolve(cfg.tools.edit, DEFAULT_EDIT_TOOLS);
}

export function readTools(cfg: GuardConfig): Set<string> {
  return resolve(cfg.tools.read, DEFAULT_READ_TOOLS);
}

export function searchTools(cfg: GuardConfig): Set<string> {
  return resolve(cfg.tools.search, DEFAULT_SEARCH_TOOLS);
}

export function shellTools(cfg: GuardConfig): Set<string> {
  return resolve(cfg.tools.shell, DEFAULT_SHELL_TOOLS);
}
