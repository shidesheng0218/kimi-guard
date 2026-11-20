import { describe, expect, it } from "vitest";
import { auditFindings, type AuditRuleInput } from "../src/auditRules.js";

function base(): AuditRuleInput {
  return {
    now: 1_000_000,
    windowMs: 86_400_000,
    reservePercent: 10,
    subagentWeight: 5,
    budget: {
      enabled: true,
      plan: "tier1",
      harness: "kimi",
      scope: "harness",
      fiveHour: { label: "5h", used: 0, limit: 100, percent: 0, resetsInMs: 0 },
      weekly: { label: "weekly", used: 0, limit: 1000, percent: 0, resetsInMs: 0 },
      turnsLastHour: 10,
      subagentsLastHour: 0,
      projectedFiveHour: 0,
      precise: false,
    },
    totals: { calls: 100, turns: 10, subagentDispatches: 0, blocks: 0 },
    sessions: [],
    retries: { stepRetries: 0, stopFailures: 0, interrupts: 0, maxIn30Min: 0 },
    runs: [],
    stalls: 0,
    blocksByKind: [],
  };
}

describe("auditFindings", () => {
  it("fires quota-pressure at 85%", () => {
    const input = base();
    input.budget.fiveHour.percent = 85;
    const f = auditFindings(input);
    expect(f.find((x) => x.id === "quota-pressure")).toMatchObject({ severity: "info" });
    expect(f.find((x) => x.id === "quota-pressure")!.evidence).toContain("85");
  });

  it("fires burn-projection only when projection exceeds the reserve-adjusted limit", () => {
    const input = base();
    input.budget.projectedFiveHour = 89;
    expect(auditFindings(input).some((x) => x.id === "burn-projection")).toBe(false);
    input.budget.projectedFiveHour = 90;
    expect(auditFindings(input).find((x) => x.id === "burn-projection")).toMatchObject({ severity: "warn" });
  });

  it("fires subagent-fanout at >=3 dispatches and >=50% weighted share", () => {
    const input = base();
    input.budget.subagentsLastHour = 2;
    expect(auditFindings(input).some((x) => x.id === "subagent-fanout")).toBe(false);
    input.budget.subagentsLastHour = 3;
    const f = auditFindings(input).find((x) => x.id === "subagent-fanout");
    expect(f).toMatchObject({ severity: "warn" });
    expect(f!.evidence).toContain("3");
  });

  it("fires retry-storm at 5 retries in 30 minutes", () => {
    const input = base();
    input.retries.maxIn30Min = 4;
    expect(auditFindings(input).some((x) => x.id === "retry-storm")).toBe(false);
    input.retries.maxIn30Min = 5;
    expect(auditFindings(input).find((x) => x.id === "retry-storm")).toMatchObject({ severity: "warn" });
  });

  it("fires cache-amplification above 10x", () => {
    const input = base();
    input.runs = [{ runId: "r1", cacheRatio: 10 }];
    expect(auditFindings(input).some((x) => x.id === "cache-amplification")).toBe(false);
    input.runs = [{ runId: "r1", cacheRatio: 12 }];
    const f = auditFindings(input).find((x) => x.id === "cache-amplification");
    expect(f).toMatchObject({ severity: "warn" });
    expect(f!.evidence).toContain("r1");
  });

  it("fires guard-inactive with no calls or turns", () => {
    const input = base();
    input.totals = { calls: 0, turns: 0, subagentDispatches: 0, blocks: 0 };
    expect(auditFindings(input).find((x) => x.id === "guard-inactive")).toMatchObject({ severity: "info" });
  });

  it("fires intervention-heavy at 10 blocks", () => {
    const input = base();
    input.totals = { calls: 100, turns: 10, subagentDispatches: 0, blocks: 10 };
    input.blocksByKind = [{ kind: "repeat", n: 7 }, { kind: "noGain", n: 3 }];
    const f = auditFindings(input).find((x) => x.id === "intervention-heavy");
    expect(f).toMatchObject({ severity: "info" });
    expect(f!.evidence).toContain("repeat");
  });

  it("fires context-pressure at 3 distinct cycles", () => {
    const input = base();
    input.sessions = [{ sessionId: "s1", compactionCycles: 2 }];
    expect(auditFindings(input).some((x) => x.id === "context-pressure")).toBe(false);
    input.sessions = [{ sessionId: "s1", compactionCycles: 3 }];
    expect(auditFindings(input).find((x) => x.id === "context-pressure")).toMatchObject({ severity: "info" });
  });

  it("fires stall-signal when stalls > 0", () => {
    const input = base();
    input.stalls = 1;
    expect(auditFindings(input).find((x) => x.id === "stall-signal")).toMatchObject({ severity: "info" });
  });

  it("returns no findings for a quiet window", () => {
    expect(auditFindings(base())).toHaveLength(0);
  });
});