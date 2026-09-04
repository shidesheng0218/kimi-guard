import { describe, expect, it } from "vitest";
import { renderDashboard, type WatchState } from "../src/watch/render.js";
import { defaultConfig } from "../src/config.js";
import { budgetSnapshot } from "../src/meter.js";

function state(overrides?: Partial<WatchState>): WatchState {
  return {
    sessions: [],
    blocks: [],
    budget: budgetSnapshot("s", { ...defaultConfig.budget }),
    now: Date.parse("2026-09-03T12:00:00Z"),
    ...overrides,
  };
}

describe("watch render (pure)", () => {
  it("renders the three panels with data", () => {
    const s = state({
      sessions: [{ session_id: "sess-abc-123", last_ts: Date.parse("2026-09-03T11:59:30Z"), n: 42 }],
      blocks: [{ id: 1, session_id: "sess-abc-123", tool_name: "Grep", kind: "repeat", ts: Date.parse("2026-09-03T11:59:50Z"), feedback: null }],
    });
    const lines = renderDashboard(s, 100, 30);
    const text = lines.join("\n");
    expect(text).toContain("BUDGET");
    expect(text).toContain("SESSIONS (1)");
    expect(text).toContain("sess-abc-123");
    expect(text).toContain("🔴"); // session with a block is marked hot
    expect(text).toContain("INTERVENTIONS (1)");
    expect(text).toContain("repeat");
  });

  it("empty state renders placeholders, no crash", () => {
    const text = renderDashboard(state(), 80, 24).join("\n");
    expect(text).toContain("no sessions recorded yet");
    expect(text).toContain("no interventions");
  });

  it("never exceeds the terminal width", () => {
    const s = state({
      sessions: [{ session_id: "x".repeat(80), last_ts: 0, n: 99999 }],
    });
    for (const line of renderDashboard(s, 60, 20)) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("respects the terminal height", () => {
    const s = state({
      blocks: Array.from({ length: 50 }, (_, i) => ({ id: i, session_id: "s", tool_name: "Grep", kind: "repeat", ts: 0, feedback: null })),
    });
    expect(renderDashboard(s, 80, 15)).toHaveLength(15);
  });
});
