/** Pure projection of the current model, working directory and context budget. */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type FooterSnapshot = {
  cwd: string;
  home?: string;
  model?: { id?: string; reasoning?: boolean };
  thinkingLevel?: string;
  context?: { percent: number | null };
  /** Texts published by other extensions with `ctx.ui.setStatus()`, keyed by status id. */
  statuses?: ReadonlyMap<string, string>;
};

type FooterTheme = Pick<Theme, "getFgAnsi" | "fg">;

export function formatCwd(cwd: string, home = homedir()): string {
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativePath = relative(resolvedHome, resolvedCwd);
  const insideHome = relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  if (!insideHome) return cwd;
  return relativePath === "" ? "~" : `~${sep}${relativePath}`;
}

function sanitize(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ")
    .replace(/ +/gu, " ").trim();
}

/** Keep extension styling, but never let a status add rows. Mirrors Pi's native footer. */
function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t\u2028\u2029]/gu, " ").replace(/ +/gu, " ").trim();
}

/** Extension statuses, sorted by id like Pi's native footer, on one inset row. */
function renderStatuses(statuses: FooterSnapshot["statuses"], width: number, theme: FooterTheme): string[] {
  if (!statuses || statuses.size === 0) return [];
  const line = Array.from(statuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatus(String(text ?? "")))
    .filter(Boolean)
    .join(" ");
  if (!line) return [];
  const inset = Math.min(2, width - 1);
  const rightInset = width >= 4 ? 1 : 0;
  const available = Math.max(1, width - inset - rightInset);
  return [" ".repeat(inset) + truncateToWidth(line, available, theme.fg("dim", "…"))];
}

/** Draw accents at 85% saturation without changing Pi's chosen color mode. */
function accent(theme: FooterTheme, key: "syntaxType" | "syntaxString", text: string): string {
  let ansi = theme.getFgAnsi(key);
  const rgb = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/u.exec(ansi);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    const luma = Math.floor((77 * channels[0] + 150 * channels[1] + 29 * channels[2]) / 256);
    const softened = channels.map((channel) => Math.floor((channel * 85 + luma * 15 + 50) / 100));
    ansi = `\x1b[38;2;${softened.join(";")}m`;
  }
  return `${ansi}${text}\x1b[39m`;
}

export function renderFooter(snapshot: FooterSnapshot, width: number, theme: FooterTheme): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const inset = Math.min(2, safeWidth - 1);
  const rightInset = safeWidth >= 4 ? 1 : 0;
  const available = safeWidth - inset - rightInset;
  const model = sanitize(snapshot.model?.id ?? "") || "no-model";
  const level = snapshot.model?.reasoning ? sanitize(snapshot.thinkingLevel ?? "") || "off" : "";
  const identity = level ? `${model} ${level}` : model;
  const percent = snapshot.context?.percent;
  const remaining = typeof percent === "number" && Number.isFinite(percent)
    ? Math.round(100 - Math.max(0, Math.min(100, percent))) : undefined;
  const context = remaining === undefined ? "" : `${remaining}% ${safeWidth >= 60 ? "context left" : "left"}`;
  // Keep an intact label and some model identity; omit context at extreme widths.
  const right = context && available >= visibleWidth(context) + 2 + Math.min(8, visibleWidth(identity)) ? context : "";
  const leftBudget = available - (right ? visibleWidth(right) + 2 : 0);
  const compactModel = truncateToWidth(identity, leftBudget, "…");
  let left = accent(theme, "syntaxType", compactModel);
  const pathBudget = leftBudget - visibleWidth(compactModel) - 3;
  const path = sanitize(formatCwd(snapshot.cwd, snapshot.home));
  if (path && pathBudget >= 4) {
    left += theme.fg("dim", " · ") + accent(theme, "syntaxString", truncateToWidth(path, pathBudget, "…"));
  }
  const start = " ".repeat(inset) + left;
  const statuses = renderStatuses(snapshot.statuses, safeWidth, theme);
  if (!right) return [start, ...statuses];
  const gap = safeWidth - rightInset - visibleWidth(start) - visibleWidth(right);
  return [start + " ".repeat(gap) + theme.fg("muted", right) + " ".repeat(rightInset), ...statuses];
}
