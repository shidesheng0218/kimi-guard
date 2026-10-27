import fs from "node:fs";
import path from "node:path";

/**
 * Keep the Claude plugin manifests on the CLI version. Run by npm's `version`
 * lifecycle (after the package.json bump, before the release commit), so the
 * packaging test and a fresh install never advertise a stale plugin version.
 */
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

const pluginPath = path.join(root, "claude-plugin/.claude-plugin/plugin.json");
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
plugin.version = version;
fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");

const marketPath = path.join(root, ".claude-plugin/marketplace.json");
const market = JSON.parse(fs.readFileSync(marketPath, "utf8"));
for (const p of market.plugins ?? []) p.version = version;
fs.writeFileSync(marketPath, JSON.stringify(market, null, 2) + "\n");

console.log(`synced plugin manifests to ${version}`);