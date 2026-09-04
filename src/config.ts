import fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import { userConfigPath } from "./paths.js";
import { toolDefaultsFor, type HarnessName } from "./toolsets.js";
import { applyProfile, PROFILE_NAMES, type ProfileName } from "./profiles.js";

export interface GuardConfig {
  /** which agent harness this config instance serves (affects tool-name defaults and event mapping) */
  harness: HarnessName;
  /** active threshold profile (balanced | strict | chill) */
  profile: string;
  /** canonical tool-name taxonomy — every tool-name classifier reads through here */
  tools: {
    edit: string[];
    read: string[];
    search: string[];
    shell: string[];
  };
  repeat: {
    enabled: boolean;
    maxRepeats: number;
    warnAt: number;
    windowMinutes: number;
    watch: string[];
    thresholds: Record<string, number>;
    /** regex strings matched against the JSON-serialized args — matching calls are exempt from repeat detection (e.g. polling commands) */
    exemptPatterns: string[];
  };
  cycle: {
    enabled: boolean;
    windowMinutes: number;
  };
  noGain: {
    enabled: boolean;
    windowMinutes: number;
    warnAt: number;
    blockAt: number;
    /** fuzzy variant: outputs that are merely SIMILAR (not byte-identical) */
    fuzzyEnabled: boolean;
    fuzzySimilarity: number;
    fuzzyWarnAt: number;
    fuzzyBlockAt: number;
  };
  noProgress: {
    enabled: boolean;
    windowMinutes: number;
    warnAt: number;
    blockAt: number;
  };
  nearRepeat: {
    enabled: boolean;
    windowMinutes: number;
    warnAt: number;
    blockAt: number;
  };
  explore: {
    enabled: boolean;
    windowMinutes: number;
    warnAt: number;
    blockAt: number;
  };
  verify: {
    enabled: boolean;
    blockOnNoEvidence: boolean;
    evidenceWindowMinutes: number;
    claimPatterns: string[];
    evidencePatterns: string[];
    /** tool names that execute shell commands (evidence commands are searched in these) */
    shellTools: string[];
    veto: {
      enabled: boolean;
      model: string;
      baseUrl: string;
      maxCallsPerSession: number;
      timeoutMs: number;
    };
  };
  thinking: {
    enabled: boolean;
    minThinkChars: number;
    maxTextRatio: number;
  };
  anchor: {
    enabled: boolean;
    everyNPrompts: number;
    maxChars: number;
  };
  context: {
    enabled: boolean;
    warnPercent: number;
  };
  /** macOS desktop notifications on guard interventions */
  notify: {
    enabled: boolean;
    onBlock: boolean;
    onKillSwitch: boolean;
  };
  churn: {
    enabled: boolean;
    windowMinutes: number;
    warnAt: number;
    blockAt: number;
    tools: string[];
  };
  policy: {
    killSwitch: boolean;
    maxBlocksPerSession: number;
    blockWindowMinutes: number;
  };
  budget: {
    enabled: boolean;
    plan: string;
    weekly: number;
    fiveHour: number;
    dispatchTools: string[];
    reservePercent: number;
    subagentWeight: number;
    warnPercent: number;
    /** poll the official Kimi usage API (KIMI_API_KEY) for exact plan windows instead of event-based estimates */
    precise: boolean;
    preciseUrl: string;
    preciseCacheSeconds: number;
  };
  probe: boolean;
}

export const defaultConfig: GuardConfig = {
  harness: "kimi",
  profile: "balanced",
  tools: toolDefaultsFor("kimi"),
  repeat: {
    enabled: true,
    maxRepeats: 3,
    warnAt: 2,
    windowMinutes: 30,
    watch: ["Grep", "Glob", "Shell", "Bash", "FetchURL", "SearchWeb", "ReadFile"],
    thresholds: { ReadFile: 5 },
    exemptPatterns: [],
  },
  cycle: { enabled: true, windowMinutes: 30 },
  noProgress: { enabled: true, windowMinutes: 30, warnAt: 15, blockAt: 25 },
  nearRepeat: { enabled: true, windowMinutes: 30, warnAt: 6, blockAt: 10 },
  explore: { enabled: true, windowMinutes: 30, warnAt: 10, blockAt: 15 },
  verify: {
    enabled: true,
    blockOnNoEvidence: false,
    evidenceWindowMinutes: 60,
    claimPatterns: [],
    evidencePatterns: [],
    shellTools: ["Shell", "Bash"],
    veto: {
      enabled: false,
      model: "kimi-k3",
      baseUrl: "https://api.moonshot.cn/v1",
      maxCallsPerSession: 3,
      timeoutMs: 10000,
    },
  },
  thinking: { enabled: true, minThinkChars: 20000, maxTextRatio: 0.1 },
  anchor: { enabled: true, everyNPrompts: 5, maxChars: 1000 },
  context: { enabled: true, warnPercent: 85 },
  notify: { enabled: false, onBlock: true, onKillSwitch: true },
  noGain: { enabled: true, windowMinutes: 30, warnAt: 3, blockAt: 4, fuzzyEnabled: true, fuzzySimilarity: 0.85, fuzzyWarnAt: 4, fuzzyBlockAt: 6 },
  churn: {
    enabled: true,
    windowMinutes: 30,
    warnAt: 5,
    blockAt: 10,
    tools: ["WriteFile", "StrReplaceFile", "Edit", "Write", "MultiEdit", "NotebookEdit"],
  },
  policy: { killSwitch: true, maxBlocksPerSession: 5, blockWindowMinutes: 60 },
  budget: {
    enabled: true,
    plan: "tier1",
    weekly: 0,
    fiveHour: 0,
    dispatchTools: ["Task", "Agent"],
    reservePercent: 10,
    subagentWeight: 5,
    warnPercent: 80,
    precise: false,
    preciseUrl: "",
    preciseCacheSeconds: 300,
  },
  probe: false,
};

const CONFIG_TEMPLATE = `# agent-guard configuration
# Docs: https://github.com/shidesheng0218/kimi-guard

profile = "balanced"    # balanced | strict | chill — threshold bundle; explicit keys below override it

[tools]                   # canonical tool-name taxonomy — if your CLI version renames tools, fix it HERE
edit = ["WriteFile", "StrReplaceFile", "Edit", "Write", "MultiEdit", "NotebookEdit"]
read = ["ReadFile", "Read"]
search = ["Grep", "Glob"]
shell = ["Shell", "Bash"]

[repeat]
enabled = true
maxRepeats = 3            # identical (tool, args) calls allowed per window
warnAt = 2                # soft context warning before the hard block
windowMinutes = 30
watch = ["Grep", "Glob", "Shell", "Bash", "FetchURL", "SearchWeb", "ReadFile"]
# exemptPatterns = ["git status"]  # regexes over JSON-serialized args; matching calls are never repeat-blocked (polling commands like git status, sleep)

[repeat.thresholds]       # per-tool overrides
ReadFile = 5

[cycle]                   # A->B->A->B oscillation detection
enabled = true
windowMinutes = 30

[noProgress]              # long stretch of calls with no successful edit
enabled = true
windowMinutes = 30
warnAt = 15
blockAt = 25

[nearRepeat]              # fuzzy near-duplicates (punctuation/case/order differences)
enabled = true
windowMinutes = 30
warnAt = 6
blockAt = 10

[explore]                 # pure-exploration streak: reads/searches with no action in between
enabled = true
windowMinutes = 30
warnAt = 10
blockAt = 15

[verify]                  # completion-claim gate: "tests pass" must be backed by a real run
enabled = true
blockOnNoEvidence = false # hooks path: block Stop when edits landed but nothing was verified
evidenceWindowMinutes = 60
# deprecated: shell tool names now live in [tools] shell (this key still works)

[verify.veto]             # optional LLM veto vote to suppress false positives (self-critic style)
enabled = false           # requires KIMI_GUARD_VETO_API_KEY in the environment
model = "kimi-k3"         # use a cheap fast model — the LLM only votes, never authors
baseUrl = "https://api.moonshot.cn/v1"
maxCallsPerSession = 3    # anti "vote-laundering" cap: the model cannot retry its way out
timeoutMs = 10000

[thinking]                # thinking-dominance (pure-reasoning turns), Wire mode only
enabled = true
minThinkChars = 20000
maxTextRatio = 0.1

[anchor]                  # goal anchoring: re-inject the original task periodically
enabled = true
everyNPrompts = 5         # re-inject the goal every N prompts / steps
maxChars = 1000

[context]                 # context-fill gate (Wire mode reads StatusUpdate.context_usage)
enabled = true
warnPercent = 85          # steer a wrap-up warning when context is this full

[notify]                  # macOS desktop notifications (osascript, fire-and-forget)
enabled = false           # opt-in — a guard should never spam the desktop by default
onBlock = true            # notify when a tool call is blocked
onKillSwitch = true       # notify (with sound) when the kill switch fires

[noGain]                  # different args, byte-identical output
enabled = true
windowMinutes = 30
warnAt = 3
blockAt = 4
fuzzyEnabled = true       # also catch near-identical outputs (similarity, not identity)
fuzzySimilarity = 0.85    # trigram Jaccard threshold (0..1); higher = stricter
fuzzyWarnAt = 4
fuzzyBlockAt = 6

[churn]                   # same file edited over and over
enabled = true
windowMinutes = 30
warnAt = 5
blockAt = 10
# deprecated: edit tool names now live in [tools] edit (this key still works)

[policy]
killSwitch = true         # after maxBlocksPerSession interventions, block ALL tools
maxBlocksPerSession = 5
blockWindowMinutes = 60

[budget]                  # request accounting for Kimi Coding Plans
enabled = true
plan = "tier1"            # tier1: 1024/week | tier2: 2048 | tier3: 7168 (200 per 5h)
weekly = 0                # override weekly requests (0 = use plan preset)
fiveHour = 0              # override 5h requests (0 = use plan preset)
dispatchTools = ["Task", "Agent"]
reservePercent = 10       # keep this much headroom for you, not the agent
subagentWeight = 5        # ~requests each dispatched subagent costs
warnPercent = 80
precise = false           # poll the official Kimi usage API for exact windows (needs KIMI_API_KEY, sk-kimi-...)
preciseUrl = ""           # default https://api.kimi.com/coding/v1
preciseCacheSeconds = 300 # the API is rate-limited; cache aggressively. Falls back to event-based on any error

[probe]
enabled = false
`;

/** Claude Code tool-name defaults (applied before the user config overlay). */
function applyClaudeDefaults(cfg: GuardConfig): void {
  cfg.tools = toolDefaultsFor("claude");
  cfg.repeat.watch = ["Grep", "Glob", "Bash", "Read", "WebFetch", "WebSearch"];
  cfg.repeat.thresholds = { Read: 5 };
  cfg.budget.dispatchTools = ["Task"];
}

/** Codex CLI defaults. apply_patch is the edit tool; spawn_agent matches "Agent". */
function applyCodexDefaults(cfg: GuardConfig): void {
  cfg.tools = toolDefaultsFor("codex");
  cfg.repeat.watch = ["Bash", "apply_patch"];
  cfg.repeat.thresholds = {};
  cfg.budget.dispatchTools = ["Agent", "spawn_agent"];
}

/** Gemini CLI defaults. run_shell_command is the shell tool; edits are write_file/replace. */
function applyGeminiDefaults(cfg: GuardConfig): void {
  cfg.tools = toolDefaultsFor("gemini");
  cfg.repeat.watch = ["run_shell_command", "glob", "search_file_content", "grep", "read_file", "web_fetch", "google_web_search"];
  cfg.repeat.thresholds = {};
  // no known subagent-dispatch tool name on Gemini — budget gate stays off by default
  cfg.budget.dispatchTools = [];
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function strArr(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length > 0 ? (v as string[]) : fallback;
}

/** strArr variant that reports whether the key was actually provided (for legacy-alias resolution). */
function strArrOrNull(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length > 0 ? (v as string[]) : null;
}

export function loadConfig(configPath = userConfigPath(), harness: HarnessName = "kimi", profileOverride?: string): GuardConfig {
  const cfg: GuardConfig = structuredClone(defaultConfig);
  cfg.harness = harness;
  if (harness === "claude") applyClaudeDefaults(cfg);
  if (harness === "codex") applyCodexDefaults(cfg);
  if (harness === "gemini") applyGeminiDefaults(cfg);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return cfg;
  }
  let data: Record<string, unknown>;
  try {
    data = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`[agent-guard] failed to parse ${configPath}: ${(err as Error).message}\n`);
    return cfg;
  }

  // Threshold profile overlay: sits between harness defaults and the user's
  // explicit keys (explicit keys always win). Priority: flag > env > file.
  const profileName =
    profileOverride ??
    process.env.AGENT_GUARD_PROFILE ??
    (typeof data["profile"] === "string" ? data["profile"] : "balanced");
  if (profileName !== "balanced" && !PROFILE_NAMES.includes(profileName as ProfileName)) {
    process.stderr.write(`[agent-guard] unknown profile "${profileName}" — using balanced\n`);
  }
  applyProfile(cfg, profileName);

  const section = (name: string): Record<string, unknown> =>
    (data[name] as Record<string, unknown> | undefined) ?? {};

  const tools = section("tools");
  const toolsEdit = strArrOrNull(tools["edit"]);
  const toolsRead = strArrOrNull(tools["read"]);
  const toolsSearch = strArrOrNull(tools["search"]);
  const toolsShell = strArrOrNull(tools["shell"]);
  if (toolsEdit) cfg.tools.edit = toolsEdit;
  if (toolsRead) cfg.tools.read = toolsRead;
  if (toolsSearch) cfg.tools.search = toolsSearch;
  if (toolsShell) cfg.tools.shell = toolsShell;

  const repeat = section("repeat");
  cfg.repeat.enabled = bool(repeat["enabled"], cfg.repeat.enabled);
  cfg.repeat.maxRepeats = num(repeat["maxRepeats"], cfg.repeat.maxRepeats);
  cfg.repeat.warnAt = num(repeat["warnAt"], cfg.repeat.warnAt);
  cfg.repeat.windowMinutes = num(repeat["windowMinutes"], cfg.repeat.windowMinutes);
  cfg.repeat.watch = strArr(repeat["watch"], cfg.repeat.watch);
  const exempt = repeat["exemptPatterns"];
  if (Array.isArray(exempt)) cfg.repeat.exemptPatterns = exempt.filter((p): p is string => typeof p === "string");
  const th = repeat["thresholds"] as Record<string, unknown> | undefined;
  if (th) for (const [k, v] of Object.entries(th)) if (typeof v === "number") cfg.repeat.thresholds[k] = v;

  const cycle = section("cycle");
  cfg.cycle.enabled = bool(cycle["enabled"], cfg.cycle.enabled);
  cfg.cycle.windowMinutes = num(cycle["windowMinutes"], cfg.cycle.windowMinutes);

  const noProgress = section("noProgress");
  cfg.noProgress.enabled = bool(noProgress["enabled"], cfg.noProgress.enabled);
  cfg.noProgress.windowMinutes = num(noProgress["windowMinutes"], cfg.noProgress.windowMinutes);
  cfg.noProgress.warnAt = num(noProgress["warnAt"], cfg.noProgress.warnAt);
  cfg.noProgress.blockAt = num(noProgress["blockAt"], cfg.noProgress.blockAt);

  const nearRepeat = section("nearRepeat");
  cfg.nearRepeat.enabled = bool(nearRepeat["enabled"], cfg.nearRepeat.enabled);
  cfg.nearRepeat.windowMinutes = num(nearRepeat["windowMinutes"], cfg.nearRepeat.windowMinutes);
  cfg.nearRepeat.warnAt = num(nearRepeat["warnAt"], cfg.nearRepeat.warnAt);
  cfg.nearRepeat.blockAt = num(nearRepeat["blockAt"], cfg.nearRepeat.blockAt);

  const explore = section("explore");
  cfg.explore.enabled = bool(explore["enabled"], cfg.explore.enabled);
  cfg.explore.windowMinutes = num(explore["windowMinutes"], cfg.explore.windowMinutes);
  cfg.explore.warnAt = num(explore["warnAt"], cfg.explore.warnAt);
  cfg.explore.blockAt = num(explore["blockAt"], cfg.explore.blockAt);

  const verify = section("verify");
  cfg.verify.enabled = bool(verify["enabled"], cfg.verify.enabled);
  cfg.verify.blockOnNoEvidence = bool(verify["blockOnNoEvidence"], cfg.verify.blockOnNoEvidence);
  cfg.verify.evidenceWindowMinutes = num(verify["evidenceWindowMinutes"], cfg.verify.evidenceWindowMinutes);
  const claims = verify["claimPatterns"];
  if (Array.isArray(claims)) cfg.verify.claimPatterns = claims.filter((c): c is string => typeof c === "string");
  const evidence = verify["evidencePatterns"];
  if (Array.isArray(evidence)) cfg.verify.evidencePatterns = evidence.filter((c): c is string => typeof c === "string");
  cfg.verify.shellTools = strArr(verify["shellTools"], cfg.verify.shellTools);
  // legacy alias: [verify] shellTools overrides [tools] shell unless [tools] was set explicitly
  const legacyShellTools = strArrOrNull(verify["shellTools"]);
  if (legacyShellTools && !toolsShell) cfg.tools.shell = legacyShellTools;
  const veto = verify["veto"] as Record<string, unknown> | undefined;
  if (veto) {
    cfg.verify.veto.enabled = bool(veto["enabled"], cfg.verify.veto.enabled);
    cfg.verify.veto.model = typeof veto["model"] === "string" ? veto["model"] : cfg.verify.veto.model;
    cfg.verify.veto.baseUrl = typeof veto["baseUrl"] === "string" ? veto["baseUrl"] : cfg.verify.veto.baseUrl;
    cfg.verify.veto.maxCallsPerSession = num(veto["maxCallsPerSession"], cfg.verify.veto.maxCallsPerSession);
    cfg.verify.veto.timeoutMs = num(veto["timeoutMs"], cfg.verify.veto.timeoutMs);
  }

  const thinking = section("thinking");
  cfg.thinking.enabled = bool(thinking["enabled"], cfg.thinking.enabled);
  cfg.thinking.minThinkChars = num(thinking["minThinkChars"], cfg.thinking.minThinkChars);
  cfg.thinking.maxTextRatio = num(thinking["maxTextRatio"], cfg.thinking.maxTextRatio);

  const anchor = section("anchor");
  cfg.anchor.enabled = bool(anchor["enabled"], cfg.anchor.enabled);
  cfg.anchor.everyNPrompts = num(anchor["everyNPrompts"], cfg.anchor.everyNPrompts);
  cfg.anchor.maxChars = num(anchor["maxChars"], cfg.anchor.maxChars);

  const context = section("context");
  cfg.context.enabled = bool(context["enabled"], cfg.context.enabled);
  cfg.context.warnPercent = num(context["warnPercent"], cfg.context.warnPercent);

  const notify = section("notify");
  cfg.notify.enabled = bool(notify["enabled"], cfg.notify.enabled);
  cfg.notify.onBlock = bool(notify["onBlock"], cfg.notify.onBlock);
  cfg.notify.onKillSwitch = bool(notify["onKillSwitch"], cfg.notify.onKillSwitch);

  const noGain = section("noGain");
  cfg.noGain.enabled = bool(noGain["enabled"], cfg.noGain.enabled);
  cfg.noGain.windowMinutes = num(noGain["windowMinutes"], cfg.noGain.windowMinutes);
  cfg.noGain.warnAt = num(noGain["warnAt"], cfg.noGain.warnAt);
  cfg.noGain.blockAt = num(noGain["blockAt"], cfg.noGain.blockAt);
  cfg.noGain.fuzzyEnabled = bool(noGain["fuzzyEnabled"], cfg.noGain.fuzzyEnabled);
  cfg.noGain.fuzzySimilarity = Math.max(0.5, Math.min(1, num(noGain["fuzzySimilarity"], cfg.noGain.fuzzySimilarity)));
  cfg.noGain.fuzzyWarnAt = num(noGain["fuzzyWarnAt"], cfg.noGain.fuzzyWarnAt);
  cfg.noGain.fuzzyBlockAt = num(noGain["fuzzyBlockAt"], cfg.noGain.fuzzyBlockAt);

  const churn = section("churn");
  cfg.churn.enabled = bool(churn["enabled"], cfg.churn.enabled);
  cfg.churn.windowMinutes = num(churn["windowMinutes"], cfg.churn.windowMinutes);
  cfg.churn.warnAt = num(churn["warnAt"], cfg.churn.warnAt);
  cfg.churn.blockAt = num(churn["blockAt"], cfg.churn.blockAt);
  cfg.churn.tools = strArr(churn["tools"], cfg.churn.tools);
  // legacy alias: [churn] tools overrides [tools] edit unless [tools] was set explicitly
  const legacyChurnTools = strArrOrNull(churn["tools"]);
  if (legacyChurnTools && !toolsEdit) cfg.tools.edit = legacyChurnTools;

  const policy = section("policy");
  cfg.policy.killSwitch = bool(policy["killSwitch"], cfg.policy.killSwitch);
  cfg.policy.maxBlocksPerSession = num(policy["maxBlocksPerSession"], cfg.policy.maxBlocksPerSession);
  cfg.policy.blockWindowMinutes = num(policy["blockWindowMinutes"], cfg.policy.blockWindowMinutes);

  const budget = section("budget");
  cfg.budget.enabled = bool(budget["enabled"], cfg.budget.enabled);
  cfg.budget.plan = typeof budget["plan"] === "string" ? budget["plan"] : cfg.budget.plan;
  cfg.budget.weekly = num(budget["weekly"], cfg.budget.weekly);
  cfg.budget.fiveHour = num(budget["fiveHour"], cfg.budget.fiveHour);
  cfg.budget.dispatchTools = strArr(budget["dispatchTools"], cfg.budget.dispatchTools);
  cfg.budget.reservePercent = num(budget["reservePercent"], cfg.budget.reservePercent);
  cfg.budget.subagentWeight = num(budget["subagentWeight"], cfg.budget.subagentWeight);
  cfg.budget.warnPercent = num(budget["warnPercent"], cfg.budget.warnPercent);
  cfg.budget.precise = bool(budget["precise"], cfg.budget.precise);
  cfg.budget.preciseUrl = typeof budget["preciseUrl"] === "string" ? budget["preciseUrl"] : cfg.budget.preciseUrl;
  cfg.budget.preciseCacheSeconds = num(budget["preciseCacheSeconds"], cfg.budget.preciseCacheSeconds);

  cfg.probe = bool(section("probe")["enabled"], cfg.probe);

  // keep the deprecated mirror fields consistent with the resolved taxonomy
  cfg.verify.shellTools = cfg.tools.shell;
  cfg.churn.tools = cfg.tools.edit;
  return cfg;
}

export function writeConfigTemplate(configPath = userConfigPath()): boolean {
  if (fs.existsSync(configPath)) return false;
  fs.mkdirSync(configPath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  fs.writeFileSync(configPath, CONFIG_TEMPLATE, "utf8");
  return true;
}
