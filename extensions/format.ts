/** Pure process-item formatting; width is terminal columns, minus a right gutter. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fg256, pulse256 } from "./colors.ts";

export type ToolStatus = "running" | "completed" | "errored" | "notice";

/** One call a codemode script made, as its `details.calls` reports it. */
export type InnerCall = { name: string; args: string; status: string; error?: string };

export type TreeCard = {
  toolName: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  /** Thinking's complete source. */
  detail?: string;
  /** Tool output text so far, without ANSI; codemode's without its fixed header. */
  output?: string;
  /** Pi edit's numbered display diff. */
  diff?: string;
  calls?: readonly InnerCall[];
};

export type TreeTheme = Pick<Theme, "bold">;

/**
 * Item layout, after Claude Code: ` ● Name(args)` with the marker in Pi's
 * one-column prose margin, then `   ⎿  result` whose later rows align with
 * the result text. Thinking's body aligns with its title text.
 */
export const BODY_INDENT = 3;
const RESULT_INDENT = BODY_INDENT + 3;
const GUTTER = 2;
/** Process text never runs wider than this, however wide the terminal. */
export const MAX_COLUMNS = 100;

function contentWidth(width: number): number {
  return Math.max(0, Math.min(width - GUTTER, MAX_COLUMNS));
}

export function isSpawnTool(name: string): boolean {
  return name === "spine_spawn";
}

export function isNoticeCard(card: Pick<TreeCard, "toolName">): boolean {
  return card.toolName === "cache_miss";
}

/** Provider `Error:` text stays a row. It is not the `× N Tool errors` tally. */
export function isProviderErrorCard(card: Pick<TreeCard, "toolName">): boolean {
  return card.toolName === "provider_error";
}

export function statusMarker(status: ToolStatus): string {
  return status === "notice" ? "!" : "●";
}

function paintMarker(status: ToolStatus, pulse: number): string {
  const marker = statusMarker(status);
  if (status === "notice") return fg256("warning", marker);
  if (status === "errored") return fg256("error", marker);
  if (status === "completed") return fg256("success", marker);
  return pulse256(pulse, marker);
}

export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color sequences are intentional input.
  return text.replace(/\x1b\[[0-9;]*m/gu, "");
}

export function collapseWs(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function finalizePreview(text: string): string {
  return collapseWs(stripAnsi(text));
}

export function basename(path: string): string {
  if (!path) return path;
  if (path === "." || path === "~") return path;
  const trimmed = path.replace(/[/\\]+$/u, "");
  if (!trimmed) return path;
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (slash < 0) return trimmed;
  return trimmed.slice(slash + 1) || trimmed;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstQuery(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

/** JSON call arguments, without tool-specific field guesses or full payload serialization. */
function argumentPreview(args: Record<string, unknown>, columns: number): string {
  if (columns <= 0) return "";
  const limit = Math.max(16, columns * 4);
  let remainingValues = 16;
  const quote = (text: string): string => {
    let prefix = text.slice(0, limit);
    // Do not split a surrogate pair at the sampling boundary.
    if (prefix.length < text.length && /[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
    const sampled = collapseWs(prefix) + (prefix.length < text.length ? "…" : "");
    return JSON.stringify(sampled).replace(/[\u007f-\u009f]/gu,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  };
  const keyText = (key: string): string => {
    const quoted = quote(key);
    return key.length <= limit && /^[A-Za-z_$][\w$]*$/u.test(key) ? key : quoted;
  };
  const valueText = (value: unknown, depth: number): string => {
    remainingValues -= 1;
    if (typeof value === "string") return quote(value);
    if (value === null || typeof value !== "object") return String(value);
    const array = Array.isArray(value);
    const [open, close] = array ? ["[", "]"] : ["{", "}"];
    if (depth >= 2) return `${open}…${close}`;
    return open + entries(value as Record<string, unknown>, depth + 1, array ? "" : ":", ", ") + close;
  };
  const entries = (object: Record<string, unknown>, depth: number, separator: string, joiner: string): string => {
    const parts: string[] = [];
    let length = 0;
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      if (remainingValues <= 0 || length >= limit) { parts.push("…"); break; }
      const part = (separator ? keyText(key) + separator : "") + valueText(object[key], depth);
      parts.push(part);
      length += part.length + joiner.length;
    }
    return parts.join(joiner);
  };
  return truncateToWidth(entries(args, 0, "=", " "), columns, "…");
}

export function toolPreview(name: string, args: Record<string, unknown>, columns = 120): string {
  switch (name) {
    case "bash":
      return finalizePreview(asString(args.command)) || "(empty command)";
    case "powershell":
      return finalizePreview(asString(args.command));
    case "read":
      return finalizePreview(asString(args.path)) || "(no path)";
    case "write":
    case "edit":
      return finalizePreview(asString(args.path));
    case "grep":
      return finalizePreview(asString(args.pattern));
    case "find":
      return finalizePreview(basename(asString(args.path) || asString(args.pattern) || "."));
    case "ls":
      return finalizePreview(basename(asString(args.path) || "."));
    case "spine_open":
      return finalizePreview(asString(args.goal) || asString(args.summary));
    case "spine_next":
      return finalizePreview(asString(args.summary) || asString(args.goal));
    case "spine_close":
      return "";
    case "thinking":
      return finalizePreview(asString(args.thinking));
    case "cache_miss":
    case "provider_error":
      return finalizePreview(asString(args.text));
    case "web_search":
      return finalizePreview(firstQuery(args.query) || firstQuery(args.queries));
    default:
      return argumentPreview(args, columns);
  }
}

/** Complete call input. Shell layout remains literal; other arguments are JSON. */
export function toolCallText(card: Pick<TreeCard, "toolName" | "args">): string {
  if (card.toolName === "thinking" || isNoticeCard(card) || isProviderErrorCard(card)) return "";
  const visibleControls = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu,
    (char) => char.charCodeAt(0) >= 0x7f
      ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
      : JSON.stringify(char).slice(1, -1));
  if ((card.toolName === "bash" || card.toolName === "powershell") && typeof card.args.command === "string") {
    const { command, ...argumentsRest } = card.args;
    const suffix = Object.keys(argumentsRest).length ? `\n\nArguments:\n${JSON.stringify(argumentsRest, null, 2)}` : "";
    return visibleControls(command + suffix);
  }
  return visibleControls(JSON.stringify(card.args, null, 2));
}

/** Keep Spine control rows readable without exposing their transport prefix. */
export function toolLabel(name: string): string {
  // `cache_miss` owns the complete warning text, so a second label would
  // duplicate it. Every other tool name follows the host's snake_case naming
  // convention; derive the display label instead of maintaining a registry.
  if (name === "cache_miss" || name === "provider_error") return "";
  const transportPrefix = name.startsWith("spine_") ? name.slice("spine_".length) : name;
  return transportPrefix.replace(/(^|[_-])([a-z])/gu, (_match, separator, first) => {
    return `${separator === "_" || separator === "-" ? " " : separator}${first.toUpperCase()}`;
  });
}

/** An item's body shows at most this many rows: a playing Thinking or a running tool its newest, otherwise its first. */
export const BODY_ROWS = 8;
const flowGraphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/** Last complete current-source grapheme within a previously granted prefix. */
export function normalizeThinkingPrefix(text: string, shown: string): string {
  if (!text.startsWith(shown) || !shown) return "";
  const part = flowGraphemes.segment(text).containing(shown.length - 1)!;
  return part.index + part.segment.length === shown.length ? shown : text.slice(0, part.index);
}

/**
 * One more grant of a playing Thinking: at most one more row as its body lays
 * out. A row's width of columns gives the candidate; where word wrap would carry
 * an unfinished word down and overflow as well, the grant is cut back to one row,
 * measured on the paragraph being written only.
 */
export function thinkingFlowLimit(text: string, shown: string, width: number): string {
  const budget = Math.max(1, contentWidth(width) - BODY_INDENT);
  shown = normalizeThinkingPrefix(text, shown);
  let columns = 0;
  let end = shown.length;
  for (const part of flowGraphemes.segment(text.slice(end))) {
    const cost = visibleWidth(part.segment), newline = part.segment.includes("\n");
    // A line break is a grant of its own: it opens the next row.
    if ((newline || columns + cost > budget) && end > shown.length) break;
    columns += cost;
    end = shown.length + part.index + part.segment.length;
    if (newline || columns >= budget) break;
  }
  const start = Math.max(thinkingTitle(text).rest, text.lastIndexOf("\n", shown.length - 1) + 1);
  if (shown.length <= start) return text.slice(0, end);
  const rows = (to: number) => wrapTextWithAnsi(thinkingMarkdown(text.slice(start, to)), budget).length;
  const allowed = rows(shown.length) + 1;
  if (rows(end) <= allowed) return text.slice(0, end);
  const ends = [...flowGraphemes.segment(text.slice(shown.length, end))].map(part => shown.length + part.index + part.segment.length);
  let lo = 0, hi = ends.length - 1, best = ends[0];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows(ends[mid]) <= allowed) { best = ends[mid]; lo = mid + 1; } else hi = mid;
  }
  return text.slice(0, best);
}

/** One more grant of live prose: through the end of the next rendered row. */
export function proseFlowLimit(text: string, shown: string): string {
  const end = text.indexOf("\n", shown.length);
  return end < 0 ? text : text.slice(0, end + 1);
}

/** The text a host row shows: no styling, and no trailing padding, which is layout rather than content. */
export function rowText(row: string): string {
  return stripTerminalSequences(row).trimEnd();
}

/** Host rows cut to the shown prefix of their text (rowText, rows joined by newlines); the edge row by columns. */
export function pacedRows(rows: readonly string[], shown: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (const row of rows) {
    const plain = rowText(row);
    if (at + plain.length <= shown.length) out.push(row);
    else {
      if (at < shown.length) out.push(sliceByColumn(row, 0, visibleWidth(shown.slice(at))));
      break;
    }
    at += plain.length + 1;
  }
  return out;
}

/** Literal wrapping preserves blank lines and indentation; native word-wrap trims them. */
function callRows(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    let row = "", columns = 0;
    // Match Pi's three-column visible tab layout, without terminal tab stops.
    for (const { segment } of flowGraphemes.segment(line.replace(/\t/gu, "   "))) {
      const cost = visibleWidth(segment);
      if (columns + cost > width && columns > 0) {
        rows.push(row); row = ""; columns = 0;
      }
      row += segment;
      columns += cost;
    }
    rows.push(row);
  }
  return rows;
}

function thinkingMarkdown(text: string): string {
  return stripAnsi(text).replace(/\*\*([^*\n]+)\*\*/gu, "\x1b[1m$1\x1b[22m");
}

const thinkingWords = new Intl.Segmenter("zh", { granularity: "word" });

/** A Thinking title is at most this many words of its first clause. */
export const PREVIEW_WORDS = 10;
const TITLE_END = /\n|[。，；：！？]|[.,;:!?](?=[\s*]|$)/gu;

/**
 * Where a Thinking's title sits in its text: its first clause (to the first
 * stop or line break, past any leading Markdown such as `**Heading**`), at
 * most PREVIEW_WORDS words. `rest` is where the body after it begins; `cut`
 * says the word limit, not a stop, ended the title.
 */
export function thinkingTitle(text: string): { start: number; end: number; rest: number; cut: boolean } {
  const start = /^[\s*#]*/u.exec(text)![0].length;
  TITLE_END.lastIndex = start;
  let end = TITLE_END.exec(text)?.index ?? text.length, cut = false, words = 0;
  for (const part of thinkingWords.segment(text.slice(start, end))) {
    if (part.isWordLike && ++words > PREVIEW_WORDS) { end = start + part.index; cut = true; break; }
  }
  end = start + text.slice(start, end).replace(/[\s*]+$/u, "").length;
  return { start, end, rest: end + /^[\s*。，；：！？.,;:!?]*/u.exec(text.slice(end))![0].length, cut };
}

function normalizeTailRows(rows: string[]): string[] {
  const first = rows.findIndex((row) => !isGapRow(row));
  if (first < 0) return [];
  let last = rows.length - 1;
  while (last >= first && isGapRow(rows[last])) last -= 1;

  const normalized: string[] = [];
  let gap = false;
  for (const row of rows.slice(first, last + 1)) {
    if (isGapRow(row)) {
      if (gap) continue;
      gap = true;
      normalized.push("");
      continue;
    }
    gap = false;
    normalized.push(row);
  }
  return normalized;
}

function detailRows(text: string, width: number, markdown = false, full = false): string[] {
  const source = markdown ? thinkingMarkdown(text) : stripAnsi(text);
  const normalized = normalizeTailRows(wrapTextWithAnsi(source, Math.max(1, width)));
  if (full) return normalized;
  // A playing body starts its next row when the line break arrives, so a
  // paragraph's blank row and its first words never arrive in the same frame.
  if (normalized.length && /\n[^\S\n]*$/u.test(text)) normalized.push("");
  return normalized.slice(-BODY_ROWS);
}

/** A disposable gap is unpainted whitespace. Box padding and OSC markers stay. */
export function isGapRow(row: string): boolean {
  return row.trim() === "";
}

/** OSC133-only / blank native rows are not a visible successor. */
export function isVisibleNativeRows(rows: readonly string[]): boolean {
  return rows.some((row) => stripTerminalSequences(row).trim() !== "");
}

/** `pulse`: the breathing step of an active item's marker. */
export type ItemOptions = { width: number; theme?: TreeTheme | false; expanded: boolean; pulse: number };

/**
 * Rows of a Thinking item: one title row that never changes once written, then
 * while it plays the newest rows of the rest. Folding rolls those rows up into
 * the title. `text` is the shown prefix of the source; `paced` locates the rows
 * the playback receipt covers.
 */
export function renderThinking(
  card: TreeCard, options: ItemOptions & { text: string; window: boolean },
): { rows: string[]; paced?: { from: number; to: number } } {
  const { width, theme, expanded, text, window } = options;
  const room = contentWidth(width);
  const source = card.detail ?? "";
  const { start, end, rest, cut } = thinkingTitle(source);
  // A title cut at the word limit carries its "…" once written out, open and folded alike.
  const head = text.slice(start, end).replace(/\*\*/gu, "") + (cut && text.length >= end ? "…" : "");
  const marker = theme ? window ? pulse256(options.pulse, "●") : fg256("dim", "●") : "●";
  const rows = [truncateToWidth(` ${marker}${head ? ` ${theme ? theme.bold(head) : head}` : ""}`, room, "…")];
  if (expanded || window) {
    const open = expanded && !window;
    const body = text.length > rest ? detailRows(text.slice(rest), room - BODY_INDENT, true, open) : [];
    const shown = open ? clipped(body.map(row => ({ text: row })), BODY_ROWS, "head").map(line => paintLine(line, theme)) : body;
    rows.push(...shown.map(row => truncateToWidth(" ".repeat(BODY_INDENT) + row, room, "")));
  }
  return { rows, ...(window ? { paced: { from: 0, to: rows.length } } : {}) };
}

/** Running output shows its newest rows; a finished one its first rows. */
export const TAIL_ROWS = 4;
export const HEAD_ROWS = 3;
export const DIFF_ROWS = 20;

type Line = { text: string; color?: "dim" | "error" | "success" | "warning" };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function outputLines(text: string): string[] {
  const lines = normalizeTailRows(stripAnsi(text).replace(/\t/gu, "   ").split("\n"));
  return lines.length === 1 && lines[0] === "" ? [] : lines;
}

/** At most `limit` lines, the omitted rest as a count. */
function clipped(lines: readonly Line[], limit: number, from: "head" | "tail"): Line[] {
  if (lines.length <= limit + 1) return [...lines];
  const more: Line = { text: `… +${lines.length - limit} lines`, color: "dim" };
  return from === "head" ? [...lines.slice(0, limit), more] : [more, ...lines.slice(-limit)];
}

/** Lines as the screen rows they wrap into, each keeping its color. */
function wrapped(lines: readonly Line[], width: number): Line[] {
  return lines.flatMap(line => wrapTextWithAnsi(line.text, width).map(text => ({ ...line, text })));
}

/** Context kept around each change; Pi's diff carries more. */
export const DIFF_CONTEXT = 2;

/** Pi's numbered diff with DIFF_CONTEXT lines of context; each skipped stretch becomes one dim `⋯`. */
function diffLines(diff: string): Line[] {
  const lines = diff.split("\n");
  const changed = lines.map(line => line.startsWith("+") || line.startsWith("-"));
  const near = (index: number) => changed.some((change, other) => change && Math.abs(other - index) <= DIFF_CONTEXT);
  const out: Line[] = [];
  let skipped = false;
  lines.forEach((text, index) => {
    if (!changed[index] && (!near(index) || /^\s*\.\.\.$/u.test(text))) { skipped = out.length > 0; return; }
    if (skipped) out.push({ text: "     ⋯", color: "dim" });
    skipped = false;
    out.push({ text, color: text.startsWith("+") ? "success" : text.startsWith("-") ? "error" : "dim" });
  });
  return out;
}

const innerFailed = (call: InnerCall) => call.status === "error" || call.status === "cancelled";

/** A codemode call as `Name(short args)`: Pi previews its arguments as JSON, cut when long. */
function innerCall(call: InnerCall): string {
  let args: unknown;
  try { args = JSON.parse(call.args); } catch { args = undefined; }
  const preview = args && typeof args === "object" ? toolPreview(call.name, args as Record<string, unknown>, 60) : collapseWs(call.args);
  return `${toolLabel(call.name)}(${preview})`;
}

function callLines(calls: readonly InnerCall[]): Line[] {
  return calls.flatMap(call => {
    const failed = innerFailed(call);
    const line: Line = { text: innerCall(call), ...(failed ? { color: "error" as const } : {}) };
    return failed ? [line, { text: `  ${call.status === "cancelled" ? "Cancelled" : `Error: ${collapseWs(call.error ?? "")}`}`, color: "error" as const }] : [line];
  });
}

/** Compact result block: Claude Code's one-line summaries, output and diffs clipped. */
function resultLines(card: TreeCard): Line[] {
  const output = outputLines(card.output ?? "");
  const calls = card.calls?.length ? callLines(card.calls) : [];
  if (card.status === "running") {
    const tail = clipped(output.map(text => ({ text, color: "dim" as const })), TAIL_ROWS, "tail");
    return [...calls, ...(tail.length || calls.length ? tail : [{ text: "Running…", color: "dim" as const }])];
  }
  if (card.status === "errored") {
    const tail = clipped(output.map(text => ({ text, color: "error" as const })), HEAD_ROWS, "tail");
    if (tail[0] && !/^error\b/iu.test(tail[0].text) && !tail[0].text.startsWith("…")) tail[0] = { ...tail[0], text: `Error: ${tail[0].text}` };
    return [...calls, ...tail];
  }
  const path = asString(card.args.path);
  if (card.toolName === "read") return [{ text: `Read ${plural(output.length, "line")}` }];
  if (card.toolName === "write") return [{ text: `Wrote ${plural(asString(card.args.content).split("\n").length, "line")} to ${path}` }];
  if (card.toolName === "edit" && card.diff) {
    const diff = diffLines(card.diff);
    const added = diff.filter(line => line.color === "success").length;
    const removed = diff.filter(line => line.color === "error").length;
    return [{ text: `Updated ${path} with ${plural(added, "addition")} and ${plural(removed, "removal")}` }, ...clipped(diff, DIFF_ROWS, "head")];
  }
  const head = clipped(output.map(text => ({ text })), HEAD_ROWS, "head");
  return [...calls, ...(head.length || calls.length ? head : [{ text: "(No output)", color: "dim" as const }])];
}

function paintLine(line: Line, theme: TreeTheme | false | undefined): string {
  return theme && line.color ? fg256(line.color, line.text) : line.text;
}

/** `Name(short args)` within `columns`. */
function callText(card: TreeCard, columns: number, theme: TreeTheme | false | undefined): string {
  const label = toolLabel(card.toolName);
  const preview = toolPreview(card.toolName, card.args, Math.max(0, columns - visibleWidth(label) - 2));
  return preview ? `${theme ? theme.bold(label) : label}(${preview})` : theme ? theme.bold(label) : label;
}

const resultPrefix = (theme: TreeTheme | false | undefined) => " ".repeat(BODY_INDENT) + (theme ? fg256("dim", "⎿") : "⎿") + "  ";

/** Rows of a tool, notice or provider error item: the call line, then its result block. */
export function renderTool(card: TreeCard, options: ItemOptions): string[] {
  const { width, theme, expanded } = options;
  const room = contentWidth(width);
  const marker = theme ? paintMarker(card.status, options.pulse) : statusMarker(card.status);
  if (isNoticeCard(card) || isProviderErrorCard(card)) {
    const text = asString(card.args.text);
    const color = isNoticeCard(card) ? "warning" : "error";
    return [truncateToWidth(` ${marker} ${theme ? fg256(color, text) : text}`, room, "…")];
  }
  const rows = [truncateToWidth(` ${marker} ${callText(card, room - BODY_INDENT, theme)}`, room, "…)")];
  const result = resultPrefix(theme);
  const indent = " ".repeat(RESULT_INDENT);
  const textRoom = Math.max(1, room - RESULT_INDENT);
  if (expanded) {
    // Ctrl+O: the call input and what the tool returned, BODY_ROWS screen rows of it (the
    // newest while it runs); a diff keeps its DIFF_ROWS.
    const input = callRows(toolCallText(card), textRoom).map(text => ({ text, color: "dim" as const }));
    const body = wrapped([...input, ...(card.calls?.length ? callLines(card.calls) : []),
      ...(card.diff ? [] : outputLines(card.output ?? "").map(text => ({ text })))], textRoom);
    const lines = [...clipped(body, BODY_ROWS, card.status === "running" ? "tail" : "head"),
      ...(card.diff ? clipped(wrapped(diffLines(card.diff), textRoom), DIFF_ROWS, "head") : [])];
    rows.push(...lines.map((line, index) => truncateToWidth((index ? indent : result) + paintLine(line, theme), room, "")));
    return rows;
  }
  resultLines(card).forEach((line, index) => {
    rows.push(truncateToWidth((index ? indent : result) + paintLine(line, theme), room, "…"));
  });
  return rows;
}

/** Tools that fold into their run's one-line summary; changes (edit, write) keep their diff open. */
export function isRunTool(card: Pick<TreeCard, "toolName">): boolean {
  return card.toolName !== "thinking" && card.toolName !== "edit" && card.toolName !== "write" &&
    !isNoticeCard(card) && !isProviderErrorCard(card);
}

/** Claude Code's wording for a finished run: verb and counted noun per kind of call. */
const RUN_PHRASES: Record<string, readonly [verb: string, noun: string, plural?: string]> = {
  read: ["read", "file"],
  bash: ["ran", "shell command"],
  powershell: ["ran", "shell command"],
  grep: ["searched for", "pattern"],
  find: ["searched for", "file pattern"],
  ls: ["listed", "directory", "directories"],
  codemode: ["ran", "script"],
  web_search: ["searched the web for", "query", "queries"],
};

export function runSummary(cards: readonly TreeCard[]): string {
  const counts = new Map<string, { phrase: readonly [string, string, string?]; count: number }>();
  for (const card of cards) {
    const phrase = RUN_PHRASES[card.toolName] ?? [`called ${toolLabel(card.toolName)}`, "time"];
    const key = phrase.join("|");
    const entry = counts.get(key) ?? { phrase, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const text = [...counts.values()].map(({ phrase: [verb, noun, plural], count }) =>
    `${verb} ${count} ${count === 1 ? noun : plural ?? `${noun}s`}`).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A run of calls stays a few rows high however long it gets: the summary of
 * the calls shown so far, a row per failure, and (`current`) the newest call
 * with its result block. Ctrl+O lists every call, each as renderTool shows it.
 */
export function renderRun(cards: readonly TreeCard[], options: ItemOptions & { current: boolean }): string[] {
  const { width, theme, expanded } = options;
  if (expanded) return cards.flatMap((card, index) => [...(index ? [""] : []), ...renderTool(card, options)]);
  const room = contentWidth(width);
  const current = options.current ? cards.at(-1) : undefined;
  // A codemode script can succeed while calls inside it failed: those count as failures too.
  const failure = (card: TreeCard) => card.status === "errored" || !!card.calls?.some(innerFailed);
  const failed = cards.filter(card => failure(card) && card !== current);
  const marker = !theme ? "●" : cards.some(card => card.status === "running") ? pulse256(options.pulse, "●")
    : fg256(cards.some(failure) ? "error" : "success", "●");
  const rows = [truncateToWidth(` ${marker} ${runSummary(cards)}`, room, "…")];
  const result = resultPrefix(theme), indent = " ".repeat(RESULT_INDENT);
  // A failure row names the call that failed and leaves room for its error: a script gets a row
  // per failed inner call, and a row of its own only when none of them failed.
  const failures = failed.flatMap(card => card.calls?.some(innerFailed)
    ? card.calls.filter(innerFailed).map(inner => ({ call: innerCall(inner),
      error: inner.status === "cancelled" ? "Cancelled" : collapseWs(inner.error ?? "") }))
    : [{ call: callText(card, Math.min(40, room - RESULT_INDENT), false), error: outputLines(card.output ?? "").at(-1) ?? "" }]);
  for (const { call, error } of failures) {
    const text = ` · ${/^(error|cancelled)\b/iu.test(error) ? error : `Error: ${error}`}`;
    rows.push(truncateToWidth(result + call + (theme ? fg256("error", text) : text), room, "…"));
  }
  if (current) {
    rows.push(truncateToWidth(result + callText(current, room - RESULT_INDENT, theme), room, "…)"));
    for (const line of resultLines(current)) rows.push(truncateToWidth(indent + paintLine(line, theme), room, "…"));
  }
  return rows;
}
