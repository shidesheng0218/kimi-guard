import pc from "picocolors";

/**
 * The agent-guard visual identity — one palette everywhere (TUI, CLI, reports).
 * Colors echo the banner: violet→blue shield gradient, warm red for blocks,
 * soft green for healthy, muted gray for secondary text.
 */

export const ui = {
  brand: pc.magentaBright, // shield violet
  accent: pc.blueBright, // gradient end
  ok: pc.green,
  warn: pc.yellow,
  danger: pc.redBright,
  dim: pc.dim,
  bold: pc.bold,
};

export function heading(text: string): string {
  return ui.bold(ui.brand(`◆ ${text}`));
}

export function rule(width: number): string {
  return ui.dim("─".repeat(width));
}

export function colorBar(percent: number, width = 18): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
  const color = percent >= 85 ? ui.danger : percent >= 60 ? ui.warn : ui.ok;
  return color("█".repeat(filled)) + ui.dim("░".repeat(width - filled));
}

export function label(text: string, width: number): string {
  return ui.dim(text.padEnd(width));
}

/** Budget/status percentage with semantic coloring. */
export function pct(n: number): string {
  const s = `${String(n).padStart(3)}%`;
  return n >= 85 ? ui.danger(s) : n >= 60 ? ui.warn(s) : ui.ok(s);
}
