import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Packaging regressions are invisible in the repo (dist/test exist) but break
 * the published CLI. These assertions keep the npm tarball honest:
 * - the benchmark fixture must ship, or `agentguard bench` is dead on install;
 * - the kguard/kimi-guard aliases are documented and must exist;
 * - the plugin manifests must track the CLI version.
 */

const repoRoot = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  version: string;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
};

describe("npm packaging contract", () => {
  it("exposes the documented binary aliases", () => {
    expect(pkg.bin["agentguard"]).toBe("dist/cli.js");
    expect(pkg.bin["kguard"]).toBe("dist/cli.js");
    expect(pkg.bin["kimi-guard"]).toBe("dist/cli.js");
  });

  it("ships the bench fixture", () => {
    expect(pkg.files).toContain("test/wire/fake-kimi.mjs");
    expect(fs.existsSync(path.join(repoRoot, "test/wire/fake-kimi.mjs"))).toBe(true);
  });

  it("builds before publishing", () => {
    expect(pkg.scripts["prepack"]).toBeTruthy();
  });

  it("keeps plugin manifests on the CLI version", () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, "claude-plugin/.claude-plugin/plugin.json"), "utf8")) as {
      version: string;
    };
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".claude-plugin/marketplace.json"), "utf8"),
    ) as { plugins: Array<{ version: string }> };
    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.plugins[0]?.version).toBe(pkg.version);
  });
});