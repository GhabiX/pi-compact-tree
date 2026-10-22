/**
 * Claude Code-style process transcript for Pi regular mode,
 * plus a borderless input panel, working line and compact footer.
 *
 * Constraints:
 * - items lie flat in source order: Thinking, edit/write with its diff, provider
 *   errors and notices, and runs of other calls folded into one summary sentence
 * - one live item moves at a time, on the pulse defined in snapshot.ts
 * - Thinking streams at most eight rows and folds into its title row
 * - assistant prose, user messages and other chat reports stay native; live prose plays at its source's rate
 * - Pi owns the editor and working loader; the plugin supplies working styles
 * - Ctrl+O remains Pi's native shortcut; expanded, Thinking and each call show BODY_ROWS rows (an edit's diff DIFF_ROWS)
 * - spine_spawn keeps its own renderer
 * - regular mode keeps Pi's viewport/input; one root layout anchors the native bottom regions
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  CURSOR_MARKER,
  MouseRegion,
  Spacer,
  Text,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { showThoughts } from "./thoughts.ts";
import { type FooterSnapshot, renderFooter } from "./footer.ts";
import { type InputStyle, installInputStyle, inputStatusRows } from "./editor.ts";
import { BODY_ROWS, type TreeTheme, isSpawnTool, stripAnsi } from "./format.ts";
import {
  type AssistantDuck,
  type DuckTool,
  hasVisibleText,
  isAssistantCard,
  isDuckTool,
  hasThinking,
  thinkingSummary,
  toolLifecycle,
} from "./group.ts";
import {
  attachMotionScheduler,
  addMotionTick,
  armMotion,
  clearMotion,
  hasMotionScheduler,
  motionNow,
  type MotionSample,
  detachMotionScheduler,
  elapsedCompact,
  stopMotion,
  workingIndicatorFrames,
  WORKING_INDICATOR_INTERVAL_MS,
} from "./motion.ts";
import { fg256, spineSuccess } from "./colors.ts";
import { ProjectionCache, type ProjectionItem } from "./projection.ts";
import { FrameCoordinator, materialize, type SnapshotBlock, type SnapshotTarget } from "./snapshot.ts";
import { resetPaintQueue } from "./queue.ts";
import { fitBottom, type BottomSlice } from "./bottom-layout.ts";
const PATCH_STATE_KEY = Symbol.for("pi-compact-ui2tree/container-render-v1");

type Child = Container["children"][number];

function publishedBlocks(coordinator: FrameCoordinator) {
  return coordinator.readBlocks();
}

type RootFrame = {
  container: WeakRef<Container>;
  coordinator: FrameCoordinator;
  width: number;
  geometry: string;
  viewportTop: number;
  host: boolean;
  hostHasFrame: boolean;
  target: SnapshotTarget;
  adopted?: { history: SnapshotBlock; covered: ReadonlySet<string>; sources: ReadonlySet<string>; components?: ReadonlySet<Child>; nativeComponents?: ReadonlySet<Child> };
  overlayHeld?: boolean;
  interruptPending?: boolean;
  bottom?: { documentHeight: number };
  /** Latest clock sample, consumed by the next host draw. */
  sample?: MotionSample;
  /** Tools-expanded state last drawn, and the blocks moving in the toggle's frame that have not reached their target yet. */
  drawnExpanded: boolean;
  toggled: readonly string[];
  /** Part of a Ctrl+O result cannot be drawn in place: the paint observer asks Pi to reprint once. */
  reprint: boolean;
};

type PatchState = {
  assistantContents: WeakSet<Container>;
  originalRender: typeof Container.prototype.render;
  /** The prototype render installed here: a component inheriting it composes frames. */
  wrapper: typeof Container.prototype.render;
  active: boolean;
  render: (container: Container, width: number, tick?: MotionSample) => string[] | undefined;
  caches: Set<WeakRef<ProjectionCache<Child>>>;
  cacheFinalizer: FinalizationRegistry<WeakRef<ProjectionCache<Child>>>;
  cacheByContainer: WeakMap<Container, ProjectionCache<Child>>;
  rootFrames: WeakMap<Container, RootFrame>;
  roots: Set<WeakRef<RootFrame>>;
  detachRootClock?: () => void;
  styleEpoch: number;
  frameBlocks: WeakMap<object, readonly SnapshotBlock[]>;
  layoutIds: WeakMap<object, string>;
  nextLayoutId: number;
};

type PatchedContainerPrototype = typeof Container.prototype & Record<symbol, PatchState | undefined>;

let liveMessages = new WeakSet<object>();
let steeringSubmissions = 0;
let liveToolCalls = new Map<string, boolean>();
/** False from agent_start until agent_settled: while the agent runs, more calls may join the newest run. */
let agentSettled = true;
let readTheme: (() => TreeTheme) | undefined;
let readToolsExpanded: (() => boolean) | undefined;
type HostBoundary = {
  viewportTop: number; rows: number; host: boolean; hasFrame: boolean;
  previousLines?: readonly string[];
  overlay: boolean;
  bottom?: { document: Container; regions: readonly Container[] };
  heightReflow?: boolean;
};
let readRegularAnchor: ((container?: Container) => HostBoundary | undefined) | undefined;
let frameDepth = 0;
let confirmPaint = false;
let excludedComponents: ReadonlySet<Child> | undefined;
let nativeComponents: ReadonlySet<Child> | undefined;
function snapshotFooter(ctx: ExtensionContext): FooterSnapshot {
  const model = ctx.model
    ? {
        id: ctx.model.id,
        reasoning: ctx.model.reasoning,
      }
    : undefined;
  return {
    cwd: ctx.sessionManager.getCwd(),
    home: process.env.HOME || process.env.USERPROFILE,
    model,
    thinkingLevel: ctx.thinkingLevel,
    context: ctx.getContextUsage(),
  };
}

const SESSION_REPLACEMENTS = new Set(["reload", "new", "resume", "fork"]);

function interruptPlayback(state: PatchState): void {
  for (const ref of state.caches) ref.deref()?.interrupt();
  for (const ref of state.roots) {
    const frame = ref.deref();
    if (frame) frame.interruptPending = true;
  }
}

/** `redraw` asks the host for one cleared full redraw once the footer is mounted. */
function installFooter(ctx: ExtensionContext, state: PatchState, redraw: boolean): () => void {
  let dispose: (() => void) | undefined;
  ctx.ui.setFooter((tui) => {
    dispose?.();
    let input: { component: Child; style?: InputStyle } | undefined;
    let paintRoot: Container | undefined;
    let disposePaint: (() => void) | undefined;
    const syncInput = (component: Child | undefined) => {
      if (input?.component === component) return;
      input?.style?.dispose();
      input = component ? { component, style: installInputStyle(component, () => ctx.ui.theme) } : undefined;
    };
    const read = (container?: Container): HostBoundary | undefined => {
      const live = tui as { mode?: string; children?: Child[]; terminal?: { rows?: number; columns?: number }; previousViewportTop?: number;
        hasOverlay?: () => boolean;
        captureRenderState?: () => { previousViewportTop: number; previousLines: string[]; previousWidth: number; previousHeight: number } };
      // The real host's history belongs only to its root. Plain injected footer
      // anchors keep the existing harness usable without pretending to draw Pi.
      if (live.captureRenderState && container !== tui && container?.children !== live.children) return undefined;
      if (live.mode !== "regular") {
        syncInput(undefined);
        return undefined;
      }
      const rows = live.terminal?.rows;
      if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) return undefined;
      if (container && container !== paintRoot && typeof (container as any).doRender === "function") {
        disposePaint?.();
        paintRoot = container;
        disposePaint = observePaint(container, state);
      }
      const captured = live.captureRenderState?.();
      const top = captured?.previousViewportTop ?? live.previousViewportTop;
      let viewportTop = typeof top === "number" && Number.isFinite(top) ? Math.max(0, top) : 0;
      const children = container?.children;
      // This is Pi 1.1's regular root, including the actual mounted footer.
      // Footer factories receive a Proxy; its children identity survives it.
      const bottom = captured && children?.length === 7 && children.every((child) => child instanceof Container) &&
        (children[6] as Container).children.includes(footer)
        ? { document: children[0] as Container, regions: children.slice(1) as Container[] } : undefined;
      // Style the mounted native editor, never replace its input state. A
      // temporary reload component or another custom editor keeps its renderer.
      const editorChildren = bottom?.regions[3].children;
      syncInput(editorChildren?.length === 1 ? editorChildren[0] : undefined);
      const widthChanged = Boolean(captured?.previousWidth && captured.previousWidth !== live.terminal?.columns);
      const heightChanged = Boolean(captured?.previousHeight && captured.previousHeight !== rows);
      const geometryReset = Boolean(bottom && (widthChanged || (heightChanged && !process.env.TERMUX_VERSION)));
      if (geometryReset) viewportTop = 0;
      else if (bottom && heightChanged) viewportTop = Math.max(0, viewportTop + captured!.previousHeight - rows);
      return { viewportTop, rows: Math.floor(rows), host: captured !== undefined,
        hasFrame: Boolean(captured?.previousLines.length), previousLines: captured?.previousLines,
        overlay: live.hasOverlay?.() === true, bottom,
        heightReflow: Boolean(bottom && heightChanged && !geometryReset) };
    };
    readRegularAnchor = read;
    if (redraw) {
      redraw = false;
      tui.requestRender(true);
    }
    const requestRender = () => tui.requestRender();
    attachMotionScheduler(requestRender);
    let inputActive = true;
    let restoreInputObservation: (() => void) | undefined;
    const disposeInput = ctx.ui.onTerminalInput(() => {
      restoreInputObservation?.();
      const root = paintRoot as any;
      const editor = input?.component as any;
      if (!root || root.hasOverlay?.() || !editor || editor.constructor.name !== "CustomEditor" || root.getFocusedComponent?.() !== editor) return;
      const restores: Array<() => void> = [];
      const observe = (key: "onEscape" | "onSubmit", after: (args: unknown[], result: unknown, before: number) => void) => {
        const original = editor[key];
        if (typeof original !== "function") return;
        const descriptor = Object.getOwnPropertyDescriptor(editor, key);
        const wrapped = function (this: unknown, ...args: unknown[]) {
          const before = steeringSubmissions;
          const result = original.apply(this, args);
          after(args, result, before);
          return result;
        };
        editor[key] = wrapped;
        restores.push(() => {
          if (editor[key] !== wrapped) return;
          if (descriptor) Object.defineProperty(editor, key, descriptor);
          else Reflect.deleteProperty(editor, key);
        });
      };
      const interrupt = () => { if (inputActive) { interruptPlayback(state); requestRender(); } };
      // Native CustomEditor decides whether Esc cancels completion, a dialog,
      // or invokes its actual interruption callback. Never consume the key.
      observe("onEscape", () => { if (!root.hasOverlay?.()) interrupt(); });
      observe("onSubmit", (args, result, before) => {
        const text = String(args[0] ?? "").trim();
        if (!text || text.startsWith("/") || text.startsWith("!")) return;
        // Streaming submit awaits the native prompt/steer acceptance. Normal
        // runs also reach the user message_start boundary below.
        Promise.resolve(result).then(() => { if (steeringSubmissions !== before) interrupt(); }, () => {});
      });
      const restore = () => { for (const apply of restores) apply(); };
      restoreInputObservation = restore;
      queueMicrotask(restore);
    });
    const footer = {
      render(width: number) {
        return renderFooter(snapshotFooter(ctx), width, ctx.ui.theme);
      },
      invalidate() {},
      dispose() {
        if (readRegularAnchor === read) readRegularAnchor = undefined;
        detachMotionScheduler(requestRender);
        inputActive = false;
        disposeInput();
        restoreInputObservation?.();
        syncInput(undefined);
        disposePaint?.();
      },
    };
    dispose = () => footer.dispose();
    return footer;
  });
  return () => dispose?.();
}

/** Pi 1.1 regular renderer (TuiMainScreen): successful doRender returns after terminal flush. */
function observePaint(container: Container, state: PatchState): () => void {
  const root = container as any;
  const prior = Object.getOwnPropertyDescriptor(root, "doRender");
  const original = root.doRender;
  const priorInvalidate = Object.getOwnPropertyDescriptor(root, "invalidate");
  const invalidate = root.invalidate;
  let active = true;
  function invalidated(this: any, ...args: unknown[]) {
    // Pi's theme is a stable Proxy. Its native invalidation, including theme
    // preview/reload, is the cache boundary rather than Proxy identity.
    if (active) state.styleEpoch += 1;
    return invalidate.apply(this, args);
  }
  function wrapped(this: any, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (!active || this.stopped || this.hasOverlay?.()) return result;
    const frame = state.rootFrames.get(container);
    const painted = this.captureRenderState();
    if (!frame || painted.previousWidth !== frame.width || painted.previousHeight !== this.terminal.rows) return result;
    let at = 0;
    let resume = false;
    for (const block of publishedBlocks(frame.coordinator)) {
      for (const span of block.paint ?? []) {
        if (span.settled && block.phase !== "stable") continue;
        if (span.to <= span.from || span.to > block.rows.length || at + span.from < painted.previousViewportTop ||
          at + span.to > painted.previousViewportTop + painted.previousHeight) continue;
        const matches = block.rows.slice(span.from, span.to).every((row, index) =>
          hostText(row) === hostText(painted.previousLines[at + span.from + index] ?? ""));
        if (matches) for (const ref of state.caches) resume = ref.deref()?.acknowledge(span.id, span.text) === true || resume;
      }
      at += block.rows.length;
    }
    for (const id of frame.coordinator.readFrozen()) for (const ref of state.caches) resume = ref.deref()?.release(id) === true || resume;
    if (frame.reprint) {
      frame.reprint = false;
      this.requestRender(true);
      return result;
    }
    if (resume) this.requestRender();
    return result;
  }
  Object.defineProperty(root, "doRender", { configurable: true, writable: true, value: wrapped });
  Object.defineProperty(root, "invalidate", { configurable: true, writable: true, value: invalidated });
  return () => {
    active = false;
    if (root.invalidate === invalidated) {
      if (priorInvalidate) Object.defineProperty(root, "invalidate", priorInvalidate);
      else Reflect.deleteProperty(root, "invalidate");
    }
    if (root.doRender !== wrapped) return;
    if (prior) Object.defineProperty(root, "doRender", prior);
    else Reflect.deleteProperty(root, "doRender");
  };
}

function hasToolCall(message: { content?: Array<{ type: string }> } | undefined): boolean {
  return Boolean(message?.content?.some((block) => block.type === "toolCall" || block.type === "tool_use"));
}

function providerErrorDuck(text: string): DuckTool {
  return {
    toolName: "provider_error",
    args: { text },
    result: { isError: true, content: [] },
  };
}

/** Provider failures remain process children even when that turn had tool calls. */
function assistantErrorLine(message: AssistantDuck["lastMessage"]): string | undefined {
  if (message?.stopReason !== "error") return undefined;
  const detail = message.errorMessage?.trim() || "Unknown error";
  return detail.startsWith("Error:") ? detail : `Error: ${detail}`;
}

function assistantThinkingCard(card: AssistantDuck): DuckTool | "hidden" | undefined {
  const errorText = assistantErrorLine(card.lastMessage);
  // Keep Pi's terminal diagnostics under native ownership while the Thinking
  // body completes its own playback and fold before native content is admitted.
  const stopReason = card.lastMessage?.stopReason;
  const nativeDiagnostic = stopReason === "length" || stopReason === "aborted" && !hasToolCall(card.lastMessage);
  const nativeContent = hasVisibleText(card.lastMessage) || nativeDiagnostic;
  const firstContent = card.lastMessage?.content?.find((block) =>
    block.type === "thinking" && String(block.thinking ?? "").trim() ||
    block.type === "text" && String(block.text ?? "").trim());
  // Keep Pi's prose native, with its position determined by source order.
  const nativePlacement = firstContent?.type === "text" ? "before" as const : "after" as const;
  if (!hasThinking(card.lastMessage)) {
    // Pi omits the diagnostic of a message with tool calls; the transcript keeps it.
    if (errorText && hasToolCall(card.lastMessage)) {
      return { ...providerErrorDuck(errorText), ...(hasVisibleText(card.lastMessage) ? { nativePlacement } : {}) };
    }
    if (errorText && !hasVisibleText(card.lastMessage)) return providerErrorDuck(errorText);
    return !hasVisibleText(card.lastMessage) && hasToolCall(card.lastMessage) ? "hidden" : undefined;
  }
  // Assistant streaming also includes tool arguments; only an active thinking
  // block means this node is still thinking. Ctrl+T must not reintroduce raw
  // thinking prose outside the compact transcript.
  const isThinking = card.isStreaming && card.lastMessage?.content?.at(-1)?.type === "thinking";
  const thinking: DuckTool = {
    toolName: "thinking",
    playbackSource: !!card.lastMessage && liveMessages.has(card.lastMessage),
    playbackEnded: card.isStreaming === false,
    ...(nativeContent ? { nativePlacement } : {}),
    args: isThinking ? {} : { thinking: thinkingSummary(card.lastMessage) },
    isStreaming: isThinking,
    lastMessage: card.lastMessage,
  };
  // The diagnostic follows its Thinking as a companion item.
  // Pi keeps mixed-message errors native except when tool calls suppress its diagnostic.
  if (errorText && (!nativeContent || hasToolCall(card.lastMessage))) thinking.companions = [providerErrorDuck(errorText)];
  return thinking;
}

function renderNative(component: Component, width: number, state: PatchState): string[] {
  if (!nativeComponents?.has(component)) return component.render(width);
  const active = state.active;
  state.active = false;
  try { return component.render(width); }
  finally { state.active = active; }
}

// Thinking regions live in the assistant content container.
// Keep prose, diagnostics and outer OSC133 rendering under native ownership.
function renderAssistantContent(children: Container["children"], width: number): string[] {
  const lines: string[] = [];
  let spaced = false;
  for (const child of children) {
    if (child instanceof MouseRegion) continue;
    if (child instanceof Spacer) {
      spaced = true;
      continue;
    }
    const rows = child.render(width);
    if (!rows.length) continue;
    if (spaced) lines.push("");
    for (const row of rows) lines.push(row);
    spaced = false;
  }
  return lines;
}

function textOf(value: unknown): string | undefined {
  if (!(value instanceof Text)) return undefined;
  const raw = (value as unknown as { text?: unknown }).text;
  if (typeof raw !== "string") return undefined;
  return stripAnsi(raw).replace(/\s+/gu, " ").trim();
}

function cacheMissCard(value: unknown): DuckTool | undefined {
  const text = textOf(value);
  if (!text || !text.startsWith("Cache miss") || !text.includes("tokens re-billed")) return undefined;
  return {
    toolName: "cache_miss",
    args: { text },
    // The notice text is the row itself; it has no expandable tool output.
    result: { isError: false, content: [] },
  };
}

function chatErrorCard(value: unknown): DuckTool | undefined {
  const text = textOf(value);
  if (!text || !/^Error: \S/u.test(text)) return undefined;
  return providerErrorDuck(text);
}

function manualBashCard(value: unknown): DuckTool | undefined {
  const bash = value as {
    getCommand?: unknown;
    appendOutput?: unknown;
    setComplete?: unknown;
    setExpanded?: unknown;
    status?: unknown;
    truncationResult?: unknown;
    fullOutputPath?: unknown;
  };
  if (
    typeof bash.getCommand !== "function" ||
    typeof bash.appendOutput !== "function" ||
    typeof bash.setComplete !== "function" ||
    typeof bash.setExpanded !== "function"
  ) return undefined;
  const status = bash.status;
  // Pi's native bash card carries exit/cancel/truncation diagnostics in its
  // renderer. Keep that boundary native instead of silently dropping the
  // exit code or the full-output path from the compact projection.
  if (
    status === "error" ||
    status === "cancelled" ||
    bash.truncationResult !== undefined ||
    bash.fullOutputPath !== undefined
  ) return undefined;
  const output = typeof (bash as { getOutput?: unknown }).getOutput === "function"
    ? String((bash as { getOutput: () => unknown }).getOutput())
    : undefined;
  return {
    toolName: "bash",
    args: { command: String(bash.getCommand()) },
    isPartial: status === "running",
    result: { isError: false, content: output === undefined ? [] : [{ type: "text", text: output }] },
  };
}

function projectComponent(component: Child): ProjectionItem {
  if (nativeComponents?.has(component)) return undefined;
  if (component instanceof Spacer) return "spacer";
  const cacheMiss = cacheMissCard(component);
  if (cacheMiss) return cacheMiss;
  const chatError = chatErrorCard(component);
  if (chatError) return chatError;
  if (isAssistantCard(component)) return assistantThinkingCard(component);
  const bash = manualBashCard(component);
  if (bash) return bash;
  // Match Pi tool components, not arbitrary extension objects carrying a name.
  if (isDuckTool(component) && !isSpawnTool(component.toolName) &&
      typeof component.setExpanded === "function" &&
      typeof (component as unknown as { updateResult?: unknown }).updateResult === "function") {
    // Pi creates these while arguments stream, before tool_execution_start.
    // Keep pre-execution failures, but do not label queued calls as running.
    if (toolLifecycle(component) === "queued") return "hidden";
    const tool = component as DuckTool & { toolCallId: string; argsComplete: boolean };
    return { ...component, playbackSource: liveToolCalls.has(tool.toolCallId),
      playbackEnded: tool.argsComplete === true || tool.executionStarted === true || liveToolCalls.get(tool.toolCallId) === true };
  }
  return undefined;
}

function layoutId(state: PatchState, component: object): string {
  let id = state.layoutIds.get(component);
  if (!id) {
    id = `component:${++state.nextLayoutId}`;
    state.layoutIds.set(component, id);
  }
  return id;
}

function nativeBlocks(state: PatchState, component: object, rows: readonly string[]): readonly SnapshotBlock[] {
  const nested = state.frameBlocks.get(component);
  if (nested) {
    // A projected document has already reconciled these rows and carries an
    // immutable sealed prefix. Rechecking every prefix byte here would put the
    // native adapter back on the O(S) path we just removed.
    if (nested.some((block) => block.sealed)) return nested;
    let cursor = 0;
    const same = nested.every((block) => block.rows.every((row) => row === rows[cursor++]));
    if (same && cursor === rows.length) return nested;
  }
  const id = layoutId(state, component);
  return [{ id, kind: "native", rows, shape: id }];
}

function blockTarget(blocks: readonly SnapshotBlock[]): SnapshotTarget {
  return {
    blocks,
    structureKey: JSON.stringify(blocks.map((block) => [block.id, block.kind, block.shape])),
  };
}

/** Preserve already printed history when activating over Pi's native transcript. */
function adoptHostHistory(blocks: readonly SnapshotBlock[], hostRows: readonly string[], id: string) {
  // Pi appends this reset after normalizing each text row. Remove just that
  // final reset so the same public render path appends it exactly once again.
  const rows = hostRows.map(unresetHostRow);
  let end = rows.length;
  let firstTail = blocks.length;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind !== "native" || block.rows.length > end ||
      block.rows.some((row, offset) => hostRow(row) !== rows[end - block.rows.length + offset])) break;
    end -= block.rows.length;
    firstTail = index;
  }
  const initial = blocks.slice(0, firstTail);
  const covered = new Set(initial.map((block) => block.id));
  const sources = new Set(initial.flatMap((block) => block.sources ?? []));
  const history: SnapshotBlock = { id: `${id}/adopted-history`, kind: "native", rows: rows.slice(0, end),
    shape: "adopted-history", sources: [...sources] };
  return { history, covered, sources };
}

/**
 * A row as Pi writes it, before its line reset. Pi's normalizeTerminalOutput (pi-tui
 * utils, not exported) expands tabs to three spaces and decomposes the Thai/Lao AM
 * vowels; it is idempotent on rows Pi already wrote.
 */
export function hostRow(row: string): string {
  return row.replace(/[\u0e33\u0eb3]/gu, (char) => char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2").replaceAll("\t", "   ");
}

/**
 * The text of a row as Pi writes it: a receipt compares what the plugin handed Pi
 * with what Pi wrote in this form. test/host-text.test.mjs checks it against Pi.
 */
export function hostText(row: string): string {
  return stripTerminalSequences(hostRow(row)).trimEnd();
}

function unresetHostRow(row: string): string {
  const reset = "\x1b[0m\x1b]8;;\x07";
  return row.endsWith(reset) ? row.slice(0, -reset.length) : row;
}

function adoptedBlocks(adopted: NonNullable<RootFrame["adopted"]>, blocks: readonly SnapshotBlock[]): readonly SnapshotBlock[] {
  // Existing projected IDs represent content already printed in native form.
  // New semantic boundaries can still append before the live native footer.
  return [adopted.history, ...blocks.filter((block) => adopted.components
    ? block.kind !== "native" || !adopted.covered.has(block.id)
    : !adopted.covered.has(block.id) && !block.sources?.some((source) => adopted.sources.has(source)))];
}

/** Capture ownership before normal preparation replaces native layout/caches. */
function printedDocument(state: PatchState, document: Container, hostRows: readonly string[], height: number, boundary: number, width: number) {
  let rows = hostRows.slice(0, height).map(unresetHostRow);
  const covered = new Set<string>();
  const components = new Set<Child>();
  // Native layout is preparation metadata, not proof that Pi drew its current
  // children. Verify it against the actual host rows. If a writable source
  // changed, let that suffix resume normal projection instead of preserving
  // old tail rows and accidentally excluding their replacements.
  let nativeRows: readonly string[];
  const active = state.active;
  state.active = false;
  try { nativeRows = state.originalRender.call(document, width); }
  finally { state.active = active; }
  let retained = rows.length;
  // Keep only the prefix before the first fully addressable native source.
  // The remaining already-printed sources retain their native renderer, not
  // their old bytes, so interleaved Thinking/tool rows are not reprojected.
  let liveStart = rows.length;
  const live = new Set<Child>();
  const visit = (parent: Container, start: number, collect: boolean) => {
    const layout = (parent as unknown as { mouseLayout?: { children: { component: Child; height: number }[] } }).mouseLayout;
    let at = start;
    for (const entry of layout?.children ?? []) {
      const end = at + entry.height;
      const same = entry.height > 0 && end <= retained && end <= nativeRows.length &&
        nativeRows.slice(at, end).every((row, index) => hostRow(row) === rows[at + index]);
      if (same && collect) {
        if (at >= liveStart && entry.component.constructor !== Container) live.add(entry.component);
        else if (end <= liveStart) {
          components.add(entry.component);
          covered.add(layoutId(state, entry.component));
        }
      }
      if (!collect && same && at >= boundary && entry.component.constructor !== Container &&
        projectComponent(entry.component) === undefined) liveStart = Math.min(liveStart, at);
      // Only a plain Container concatenates children without adding its own
      // padding. Other native components are indivisible source ranges here.
      if (!collect && entry.height && !same && at >= boundary && at < retained) {
        retained = at;
      } else if (entry.component.constructor === Container && at < retained) {
        visit(entry.component as Container, at, collect);
      }
      at = end;
    }
  };
  visit(document, 0, false);
  rows = rows.slice(0, retained);
  liveStart = Math.min(liveStart, retained);
  visit(document, 0, true);
  rows = rows.slice(0, liveStart);
  return { rows, covered, components, nativeComponents: live.size ? live : undefined };
}

function adoptPrintedDocument(printed: ReturnType<typeof printedDocument>, id: string) {
  const history: SnapshotBlock = { id: `${id}/adopted-history`, kind: "native", rows: printed.rows,
    shape: "adopted-history" };
  return { history, covered: printed.covered, sources: new Set<string>(), components: printed.components,
    nativeComponents: printed.nativeComponents };
}

type BottomFrame = { blocks: readonly SnapshotBlock[]; slices: BottomSlice[]; document: Container; regions: readonly Container[] };

function previousDocumentHeight(container: Container, boundary: NonNullable<HostBoundary["bottom"]>, hostRows?: readonly string[]): number | undefined {
  const nativeLayout = (container as unknown as { mouseLayout?: { children: { component: Child; height: number }[] } }).mouseLayout;
  const nativeBottom = boundary.regions.map((region) => nativeLayout?.children.find((entry) => entry.component === region));
  if (hostRows?.length && nativeBottom.every((entry) => entry !== undefined)) {
    // A motion tick may prepare a taller document without Pi drawing it yet.
    // The unchanged native suffix locates the actual printed document end.
    return hostRows.length - nativeBottom.reduce((height, entry) => height + entry!.height, 0);
  }
  return nativeLayout?.children.find((entry) => entry.component === boundary.document)?.height;
}

function prepareBottom(state: PatchState, boundary: NonNullable<HostBoundary["bottom"]>, width: number, height: number, held: readonly SnapshotBlock[] = [], heldViewportTop?: number): BottomFrame {
  const documentBlocks = frameOf(boundary.document, width, state);
  // Pending playback needs an addressable window before auxiliary native
  // regions spend the rest of the screen. Otherwise a tall widget can freeze
  // the unseen prefix permanently, even after that widget is dismissed.
  const playback = confirmPaint ? documentBlocks.find((block) => block.playback || block.paint?.length) : undefined;
  const activePlayback = confirmPaint && [...state.caches].some((ref) => ref.deref()?.hasActivePlayback?.() === true);
  const nativeRows = boundary.regions.map((region) => state.originalRender.call(region, width));
  const statusRows = inputStatusRows(boundary.regions[3].children[0]);
  // An overlay keeps the previous document, even when its new semantic
  // target changes intent. Budget that actually held visible document so a
  // widget cannot scroll unfinished playback into immutable history.
  const heldBoundary = held.findIndex(block => block.id === layoutId(state, boundary.regions[0]));
  const heldHeight = heldViewportTop === undefined ? 0 : Math.max(0,
    held.slice(0, heldBoundary).reduce((sum, block) => sum + block.rows.length, 0) - heldViewportTop);
  const activePlaybackHeight = activePlayback && height >= BODY_ROWS + 4 ? BODY_ROWS + 2 : 0;
  const playbackHeight = playback
    ? Math.max(playback.paintReserve ?? playback.rows.length, held.find(block => block.id === playback.id)?.rows.length ?? 0)
    : activePlaybackHeight;
  const reserve = Math.min(Math.max(playbackHeight, heldHeight), Math.max(0, height - (statusRows ? 3 : 2)));
  // fitBottom keeps the native caret/footer first and retains mouse offsets.
  const slices = fitBottom(nativeRows, height - reserve, CURSOR_MARKER, statusRows);
  // One publication budget for the entire viewport, never one budget per item.
  let admitted = documentBlocks;
  if (confirmPaint && playback) {
    const front = documentBlocks.indexOf(playback);
    const budget = height - slices.reduce((sum, slice) => sum + slice.rows.length, 0);
    let used = 0, end = front;
    for (; end < documentBlocks.length; end++) {
      const block = documentBlocks[end];
      const cost = Math.max(block.paintReserve ?? block.rows.length, held.find(old => old.id === block.id)?.rows.length ?? 0);
      if (end > front && used + cost > budget) break;
      used += cost;
    }
    admitted = documentBlocks.slice(0, end);
  }
  const blocks = [...admitted, ...boundary.regions.map((region, index) => {
    const id = layoutId(state, region);
    return { id, kind: "native" as const, rows: slices[index].rows, shape: id };
  })];
  return { ...boundary, blocks, slices };
}

/** A Termux keyboard resize preserves the old screen instead of clearing it. */
function retainHeightReflow(container: Container, state: PatchState, frame: RootFrame, bottom: BottomFrame, viewport: HostBoundary, now: number): void {
  const held = publishedBlocks(frame.coordinator);
  const firstBottom = held.findIndex((block) => block.id === layoutId(state, bottom.regions[0]));
  let cursor = 0;
  const document = held.slice(0, firstBottom).map((block) => {
    // Sealed rows are what the host printed (it only normalizes them again);
    // a copy would break the identity that keeps them sealed.
    if (block.sealed) { cursor += block.rows.length; return block; }
    // Frozen rows take the printed bytes unless the host printed exactly this row:
    // the printed form is normalized, and the block is later compared by its rendered rows.
    return { ...block, rows: block.rows.map((row) => {
      const index = cursor++;
      const printed = index < viewport.viewportTop ? viewport.previousLines?.[index] : undefined;
      if (printed === undefined) return row;
      const retained = unresetHostRow(printed);
      return hostRow(row) === retained ? row : retained;
    }) };
  });
  if (cursor < viewport.viewportTop) {
    // A smaller physical screen can freeze part of the former gap. Preserve
    // those actual bytes as history; never mistake them for the live editor.
    const id = `${layoutId(state, container)}/frozen-layout`;
    const tail = document.at(-1)?.id === id ? document.pop()!.rows : [];
    document.push({ id, kind: "native", shape: id, rows: [...tail,
      ...viewport.previousLines!.slice(cursor, viewport.viewportTop).map(unresetHostRow)] });
  }
  frame.coordinator.onGeometryChange();
  frame.coordinator.stage(blockTarget([...document, ...bottom.blocks.slice(-bottom.regions.length)]), now);
  frame.coordinator.commit();
  frame.coordinator.observeAvailableBoundary(viewport.viewportTop);
}

/** The root alone places the already-published document and the live input area. */
function placeBottom(container: Container, state: PatchState, frame: RootFrame, bottom: BottomFrame, viewport: HostBoundary, width: number): string[] {
  const blocks = publishedBlocks(frame.coordinator);
  const firstBottom = blocks.findIndex((block) => block.id === layoutId(state, bottom.regions[0]));
  const documentHeight = blocks.slice(0, firstBottom).reduce((sum, block) => sum + block.rows.length, 0);
  const native = blocks.slice(firstBottom);
  // The stable native region IDs are retained even when their height is zero.
  const rows = bottom.regions.map((region) => native.find((block) => block.id === layoutId(state, region))!.rows);
  const bottomHeight = rows.reduce((sum, part) => sum + part.length, 0);
  const padding = Math.max(0, viewport.viewportTop + viewport.rows - documentHeight - bottomHeight);
  const mouseChildren: { component: Component; height: number }[] = [{ component: bottom.document, height: documentHeight }];
  if (padding) mouseChildren.push({ component: { render: () => [], invalidate() {} }, height: padding });
  for (let index = 0; index < bottom.regions.length; index += 1) {
    const region = bottom.regions[index];
    const slice = bottom.slices[index];
    mouseChildren.push({ component: slice.rows.length === slice.sourceHeight ? region : {
      render: () => [...rows[index]], invalidate() {},
      handleMouse: (event) => region.handleMouse({ ...event,
        y: event.y < (slice.prefix ?? 0) ? event.y : event.y - (slice.prefix ?? 0) + slice.start,
        height: slice.sourceHeight }),
    }, height: rows[index].length });
  }
  (container as unknown as { mouseLayout: { width: number; children: typeof mouseChildren } }).mouseLayout = { width, children: mouseChildren };
  frame.bottom = { documentHeight: documentHeight };
  return materialize(blocks, padding ? { at: firstBottom, rows: Array<string>(padding).fill("") } : undefined);
}

function disposeProjectionCaches(state: PatchState): void {
  for (const ref of state.caches) {
    ref.deref()?.dispose();
    state.cacheFinalizer.unregister(ref);
  }
  state.caches.clear();
  state.cacheByContainer = new WeakMap();
  // A session boundary ends the document. Every replacement reprints it, so
  // no publication outlives the session (see SESSION_REPLACEMENTS).
  for (const ref of state.roots) {
    const frame = ref.deref();
    if (!frame) continue;
    frame.coordinator.dispose();
    clearMotion(frame);
  }
  state.roots = new Set();
  state.rootFrames = new WeakMap();
}

function renderChildren(container: Container, width: number, state: PatchState): readonly SnapshotBlock[] {
  const children = container.children;
  const expanded = readToolsExpanded?.() === true;
  let cache = state.cacheByContainer.get(container);
  if (!cache || cache.isDisposed) {
    // The host identity survives semantic-cache recreation. Allocation order
    // must not rename requests already printed before a reload or bottom mount.
    cache = new ProjectionCache<Child>(confirmPaint ? (source) => layoutId(state, source) : undefined);
    state.cacheByContainer.set(container, cache);
    const ref = new WeakRef(cache);
    state.caches.add(ref);
    state.cacheFinalizer.register(cache, ref, ref);
  }
  const projected = cache.prepare(children, width, {
      classify: projectComponent,
      prose: (component) => isAssistantCard(component) && component.lastMessage && liveMessages.has(component.lastMessage)
        ? { ended: component.isStreaming === false } : undefined,
      agentSettled,
      renderNative: (component, currentWidth) => renderNative(component, currentWidth, state),
      renderFallback: (_children, currentWidth, reason) => {
        if (reason === "native-boundary") {
          // Pi's own Container.render over child frames: hidden children take
          // no rows, and the same mouse layout routes events to each child.
          const frames = container.children.map((component) =>
            projectComponent(component) === "hidden" ? [] : frameOf(component, currentWidth, state));
          (container as unknown as { mouseLayout: unknown }).mouseLayout = { width: currentWidth,
            children: container.children.map((component, index) => ({ component, height: frames[index].reduce((sum, block) => sum + block.rows.length, 0) })) };
          return frames.flat();
        }
        // A failed projection renders the whole subtree natively, Thinking included.
        const active = state.active;
        state.active = false;
        let rows: string[];
        try { rows = state.originalRender.call(container, currentWidth); }
        finally { state.active = active; }
        // Native Container supplies the exact child heights, including native wrappers and headers.
        const children = (container as unknown as { mouseLayout: { children: { component: Child; height: number }[] } }).mouseLayout.children;
        let cursor = 0;
        return children.map(({ component, height }) => {
          const id = layoutId(state, component);
          cursor += height;
          return { id, kind: "native" as const, rows: rows.slice(cursor - height, cursor), shape: id };
        });
      },
      layoutId: layoutId(state, container),
      nativeBlocks: (component, rows) => nativeBlocks(state, component, rows),
      excludedComponents,
      confirmPaint,
      theme: readTheme?.(),
      expanded,
      styleEpoch: state.styleEpoch,
    });
  return projected.blocks ?? [];
}

// One adapter owns dispatch; the two projection policies own no patch lifecycle.
/** Rows of a Container the projection leaves native; undefined when its children are projected. */
function nativeContainerRows(container: Container, width: number, state: PatchState): string[] | undefined {
  // A user message has no process sources; it and adopted native owners render
  // natively without a projection cache of their own.
  if (container instanceof UserMessageComponent || nativeComponents?.has(container)) {
    const active = state.active;
    state.active = false;
    try { return state.originalRender.call(container, width); }
    finally { state.active = active; }
  }
  if (state.assistantContents.has(container)) {
    return renderAssistantContent(container.children, width);
  }
  if (isAssistantCard(container)) {
    const content = (container as unknown as { contentContainer: Container }).contentContainer;
    state.assistantContents.add(content);
    return state.originalRender.call(container, width);
  }
  return undefined;
}

/**
 * A component's frame. A component inheriting the patched Container render
 * composes its children's frames, as Pi's Container.render composes their
 * rows; any other component is one native block of its own rows.
 */
function frameOf(component: Child, width: number, state: PatchState): readonly SnapshotBlock[] {
  if (component.render === state.wrapper) return containerFrame(component as Container, width, state);
  const id = layoutId(state, component);
  return [{ id, kind: "native", rows: renderNative(component, width, state), shape: id }];
}

/** The frame of a Container whose patched render is running, or would run. */
function containerFrame(container: Container, width: number, state: PatchState): readonly SnapshotBlock[] {
  const rows = nativeContainerRows(container, width, state);
  if (rows) {
    const id = layoutId(state, container);
    return [{ id, kind: "native", rows, shape: id }];
  }
  const blocks = renderChildren(container, width, state);
  state.frameBlocks.set(container, blocks);
  return blocks;
}

function renderPatched(container: Container, width: number, state: PatchState, tick?: MotionSample): string[] {
  const rootFrame = frameDepth === 0;
  // The clock only records its sample; the host draw prepares once at that time.
  if (rootFrame && tick === undefined) {
    const pending = state.rootFrames.get(container);
    if (pending?.sample) { tick = pending.sample; pending.sample = undefined; }
  }
  // Sample before any root publication. Pi's pull/write/state update is
  // synchronous; nested preparation cannot draw or mutate this boundary.
  const viewport = rootFrame ? readRegularAnchor?.(container) : undefined;
  if (rootFrame) {
    const previous = state.rootFrames.get(container);
    confirmPaint = viewport?.host === true;
    const resets = previous && !viewport?.heightReflow && (previous.geometry !== JSON.stringify([width, viewport?.rows]) ||
      (viewport?.host && (!viewport.hasFrame || viewport.viewportTop < previous.viewportTop)));
    // The host redraws everything after a reset, so the seal must end before
    // this frame's chat target is prepared, not after it is published.
    if (resets || viewport?.heightReflow && [...state.caches].some(ref => ref.deref()?.read().blocks?.some(block => block.playback || block.paint?.length))) for (const ref of state.caches) ref.deref()?.unseal();
    if (resets && previous.adopted?.nativeComponents) {
      // Ending native ownership changes classification even for components
      // without a semantic mutation. Rebuild that cached classification once.
      for (const cache of state.caches) cache.deref()?.invalidate();
    }
    excludedComponents = resets ? undefined : previous?.adopted?.components;
    nativeComponents = resets ? undefined : previous?.adopted?.nativeComponents;
  }
  // Capture the last native layout before rendering replaces its child heights.
  const priorFrame = state.rootFrames.get(container);
  const priorDocumentHeight = !priorFrame && viewport?.bottom && previousDocumentHeight(container, viewport.bottom, viewport.previousLines);
  const printed = viewport?.bottom && viewport.host && viewport.viewportTop > 0 && viewport.previousLines?.length &&
    !priorFrame && priorDocumentHeight !== undefined
    ? printedDocument(state, viewport.bottom.document, viewport.previousLines,
      Math.max(viewport.viewportTop, priorDocumentHeight), viewport.viewportTop, width) : undefined;
  if (printed) {
    excludedComponents = printed.components;
    nativeComponents = printed.nativeComponents;
    if (nativeComponents) for (const cache of state.caches) cache.deref()?.invalidate();
  }
  frameDepth += 1;
  try {
    if (rootFrame) {
      state.frameBlocks = new WeakMap();
    }
    // A nested draw reached through a native component's own render.
    if (!rootFrame) return materialize(containerFrame(container, width, state));
    const bottom = viewport?.bottom && prepareBottom(state, viewport.bottom, width, viewport.rows, priorFrame && publishedBlocks(priorFrame.coordinator), viewport.overlay ? viewport.viewportTop : undefined);
    const blocks = bottom?.blocks ?? containerFrame(container, width, state);
    // Ordinary render ingress only stages at the scheduler's current sample.
    const now = tick?.now ?? motionNow();
    const viewportTop = viewport?.viewportTop ?? 0;
    // Ctrl+O and theme are presentation changes, not physical host reflow.
    const geometry = JSON.stringify([width, viewport?.rows]);
    let frame = state.rootFrames.get(container);
    const hostReset = frame && viewport?.host &&
      ((frame.hostHasFrame && !viewport.hasFrame) || viewportTop < frame.viewportTop);
    const geometryChanged = frame && (frame.geometry !== geometry || hostReset);
    let target = blockTarget(blocks);
    if (!frame) {
      const coordinator = new FrameCoordinator();
      const adopted = viewport?.host && viewportTop > 0 && viewport.previousLines?.length
        ? printed
          ? adoptPrintedDocument(printed, layoutId(state, container))
          : adoptHostHistory(blocks, viewport.previousLines, layoutId(state, container)) : undefined;
      if (adopted) target = blockTarget(adoptedBlocks(adopted, blocks));
      coordinator.register(target);
      coordinator.publish();
      coordinator.observeAvailableBoundary(viewportTop);
      frame = { container: new WeakRef(container), coordinator, width, geometry, viewportTop,
        host: viewport?.host === true, hostHasFrame: viewport?.hasFrame === true, target, adopted,
        overlayHeld: viewport?.overlay === true, drawnExpanded: readToolsExpanded?.() === true, toggled: [], reprint: false };
      state.rootFrames.set(container, frame);
      state.roots.add(new WeakRef(frame));
    } else {
      const coordinator = frame.coordinator;
      if (geometryChanged) {
        if (bottom && viewport?.heightReflow && frame.bottom) {
          retainHeightReflow(container, state, frame, bottom, viewport, now);
        } else {
          coordinator.onGeometryChange();
          frame.adopted = undefined;
        }
      } else if (!viewport?.overlay) coordinator.observeAvailableBoundary(viewportTop);
      if (frame.adopted) target = blockTarget(adoptedBlocks(frame.adopted, blocks));
      if (viewport?.overlay && !geometryChanged) {
        // Pi composites overlays after pulling these rows. Their placement
        // depends on total height, so even a locally safe fold could move the
        // overlay into history. Hold the main publication until dismissal.
        if (!frame.overlayHeld) {
          coordinator.cancel();
          coordinator.publish();
        }
        // A previous fold can leave the main buffer shorter than the host's
        // working area. Pi positions overlays from buffer height, so retain
        // blank addressable tail rows while it composites the overlay.
        const heldBlocks = publishedBlocks(coordinator);
        const padding = viewportTop + viewport.rows - heldBlocks.reduce((sum, block) => sum + block.rows.length, 0);
        if (bottom) {
          // Hold chat geometry, while native editing/status stays live. The
          // root gap keeps the same physical working area for the overlay.
          const boundary = heldBlocks.findIndex((block) => block.id === layoutId(state, bottom.regions[0]));
          const live = blockTarget([...heldBlocks.slice(0, boundary), ...bottom.blocks.slice(-bottom.regions.length)]);
          if (coordinator.stage(live, now) !== "unchanged") coordinator.publish();
        } else if (padding > 0) {
          const tailId = `${layoutId(state, container)}/overlay-tail`;
          const padded = [...heldBlocks];
          const priorTail = padded.at(-1);
          const tailRows = priorTail?.id === tailId ? padded.pop()!.rows : [];
          padded.push({ id: tailId, kind: "native", rows: [...tailRows, ...Array<string>(padding).fill("")], shape: "overlay-tail" });
          coordinator.stage(blockTarget(padded), now);
          coordinator.commit();
        }
        frame.overlayHeld = true;
      } else {
        frame.overlayHeld = viewport?.overlay === true;
        const changed = coordinator.stage(target, now) !== "unchanged";
        if (geometryChanged || frame.interruptPending || !hasMotionScheduler()) {
          if (changed || coordinator.hasPending) coordinator.commit();
        } else if (changed) coordinator.publish();
        // Reading a new semantic target may stage it, but only the shared clock
        // advances elapsed structural time. Deferred targets do not arm motion.
        if (tick && coordinator.hasPending) coordinator.advanceTo(now);
        // Ctrl+O is a change the user asked to see. When part of it cannot be drawn in place, Pi
        // reprints the document once, as it does for its own changes above the viewport. This is
        // decided before the seal grows, since the seal takes held-back blocks in as drawn.
        const expanded = readToolsExpanded?.() === true, toggle = expanded !== frame.drawnExpanded;
        if (toggle || frame.toggled.length) {
          if (coordinator.hasDeferred) frame.reprint = true;
          frame.toggled = frame.reprint ? [] : publishedBlocks(coordinator)
            .filter(block => (block.phase === "pending" || block.phase === "transition") && (toggle || frame.toggled.includes(block.id)))
            .map(block => block.id);
        }
        frame.drawnExpanded = expanded;
      }
      if (!geometryChanged && bottom && viewport?.host && !viewport.overlay && !frame.adopted && !nativeComponents && !coordinator.hasPending) {
        sealHistory(state, frame, bottom, viewportTop);
      }
      frame.interruptPending = false;
      frame.width = width;
      frame.geometry = geometry;
      frame.viewportTop = viewportTop;
      frame.host = viewport?.host === true;
      frame.hostHasFrame = viewport?.hasFrame === true;
      frame.target = target;
    }
    if (frame.coordinator.hasPending) armMotion(frame);
    else clearMotion(frame);
    // The host boundary makes the one mutable copy Pi's applyLineResets needs.
    return bottom ? placeBottom(container, state, frame, bottom, viewport!, width) : materialize(publishedBlocks(frame.coordinator));
  } finally {
    frameDepth -= 1;
    if (rootFrame) { excludedComponents = undefined; nativeComponents = undefined; confirmPaint = false; }
  }
}

/** Rows above the host viewport are final. Seal each projected document child before its last frozen boundary. */
function sealHistory(state: PatchState, frame: RootFrame, bottom: BottomFrame, viewportTop: number): void {
  const published = publishedBlocks(frame.coordinator);
  for (const container of bottom.document.children) {
    const cache = container instanceof Container ? state.cacheByContainer.get(container) : undefined;
    const own = cache && state.frameBlocks.get(container);
    if (!cache || !own?.length) continue;
    const index = published.findIndex((block) => block.id === own[0].id);
    if (index < 0) continue;
    let top = 0;
    for (let i = 0; i < index; i++) top += published[i].rows.length;
    const proposal = cache.proposeSeal(viewportTop - top, published.slice(index));
    if (proposal && frame.coordinator.relabel(proposal.replaced, proposal.block)) cache.commitSeal(proposal);
  }
}

function attachRootClock(state: PatchState): void {
  // The retained state outlives its module namespace. Move its subscription
  // to this module's clock, and replace it when only the host is reloaded.
  state.detachRootClock?.();
  state.detachRootClock = addMotionTick((sample) => {
    if (!state.active) return;
    // Queue hooks run first. Each live root only records the sample; its next
    // host draw prepares and advances once at that time.
    for (const ref of state.roots) {
      const frame = ref.deref();
      const container = frame?.container.deref();
      if (frame && container) frame.sample = sample;
      else {
        if (frame) {
          clearMotion(frame);
          frame.coordinator.dispose();
        }
        state.roots.delete(ref);
      }
    }
  });
}

function patchContainer(): PatchState {
  const proto = Container.prototype as PatchedContainerPrototype;
  const existing = proto[PATCH_STATE_KEY];
  if (existing) {
    // /reload keeps the first module's wrapper, and any wrappers other plugins
    // added around it; only the renderer moves to this module.
    existing.wrapper ??= proto.render;
    existing.render = (container, width, tick) => renderPatched(container, width, existing, tick);
    attachRootClock(existing);
    return existing;
  }
  const caches = new Set<WeakRef<ProjectionCache<Child>>>();
  const state: PatchState = {
    assistantContents: new WeakSet(),
    originalRender: proto.render,
    wrapper: proto.render,
    active: false,
    render: (container, width, tick) => renderPatched(container, width, state, tick),
    caches,
    cacheFinalizer: new FinalizationRegistry((ref) => caches.delete(ref)),
    cacheByContainer: new WeakMap(),
    rootFrames: new WeakMap(),
    roots: new Set(),
    styleEpoch: 0,
    frameBlocks: new WeakMap(),
    layoutIds: new WeakMap(),
    nextLayoutId: 0,
  };
  attachRootClock(state);
  proto.render = state.wrapper = function (width: number): string[] {
    if (!state.active) return state.originalRender.call(this, width);
    return state.render(this, width) ?? state.originalRender.call(this, width);
  };
  Object.defineProperty(proto, PATCH_STATE_KEY, { value: state });
  return state;
}


export default function compactUi2Tree(pi: ExtensionAPI): void {
  pi.registerCommand("thoughts", {
    description: "Read saved Thinking in the current session branch",
    handler: async (_args, ctx) => showThoughts(ctx),
  });
  let disposeFooter: (() => void) | undefined;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  function stopWorking(ctx: ExtensionContext): void {
    if (workingTimer !== undefined) clearInterval(workingTimer);
    workingTimer = undefined;
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
  }

  // Install the inert adapter before Pi rebuilds history. It becomes active
  // only for a TUI session; other modes continue native rendering.
  const patchState = patchContainer();
  pi.on("input", event => {
    if (event.source === "interactive" && event.streamingBehavior === "steer") steeringSubmissions += 1;
  });
  for (const type of ["message_start", "message_update", "message_end"] as const) {
    pi.on(type, (event) => {
      if (type === "message_start" && event.message.role === "user") interruptPlayback(patchState);
      if (event.message.role === "assistant") {
        liveMessages.add(event.message);
        for (const part of event.message.content) if (part.type === "toolCall") liveToolCalls.set(part.id, type === "message_end");
        // Pi completes every pending call when this assistant stream ends, even
        // when an aborted/error final message omits its earlier toolCall blocks.
        if (type === "message_end") for (const [id, ended] of liveToolCalls) if (!ended) liveToolCalls.set(id, true);
      }
    });
  }
  pi.on("tool_execution_start", event => { liveToolCalls.set(event.toolCallId, true); });
  pi.on("session_start", (event, ctx) => {
    liveMessages = new WeakSet();
    liveToolCalls = new Map();
    disposeFooter?.();
    disposeFooter = undefined;
    stopMotion();
    resetPaintQueue();
    disposeProjectionCaches(patchState);
    patchState.assistantContents = new WeakSet();
    readRegularAnchor = undefined;
    frameDepth = 0;
    patchState.styleEpoch += 1;
    patchState.active = ctx.mode === "tui";
    if (!patchState.active) return;
    readToolsExpanded = typeof ctx.ui.getToolsExpanded === "function"
      ? () => ctx.ui.getToolsExpanded()
      : undefined;
    readTheme = () => ctx.ui.theme;
    stopWorking(ctx);
    // Every session replacement (/reload, /new, /resume, /fork) rebuilds the
    // chat; the rows still on screen belong to the previous document or module.
    // Reprint from this module: adopting them as history would keep the old
    // session or print the tree twice. Startup keeps the shell above Pi.
    disposeFooter = installFooter(ctx, patchState, SESSION_REPLACEMENTS.has(event.reason));
  });
  pi.on("agent_start", (_event, ctx) => {
    agentSettled = false;
    if (ctx.mode !== "tui" || workingTimer !== undefined) return;
    const startedAt = Date.now();
    const theme = ctx.ui.theme;
    ctx.ui.setWorkingIndicator({
      frames: workingIndicatorFrames(theme),
      intervalMs: WORKING_INDICATOR_INTERVAL_MS,
    });
    const refresh = () => {
      const word = spineSuccess(ctx.ui.theme.bold("Resonating"));
      ctx.ui.setWorkingMessage(word +
        fg256("dim", ` (${elapsedCompact(Date.now() - startedAt)} • esc to interrupt)`));
    };
    refresh();
    workingTimer = setInterval(refresh, 1_000);
  });
  pi.on("agent_settled", (_event, ctx) => {
    agentSettled = true;
    if (ctx.mode === "tui") stopWorking(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    liveMessages = new WeakSet();
    agentSettled = true;
    liveToolCalls = new Map();
    if (ctx.mode === "tui") stopWorking(ctx);
    disposeFooter?.();
    disposeFooter = undefined;
    stopMotion();
    resetPaintQueue();
    disposeProjectionCaches(patchState);
    patchState.assistantContents = new WeakSet();
    readTheme = undefined;
    readToolsExpanded = undefined;
    readRegularAnchor = undefined;
    frameDepth = 0;
    patchState.active = false;
  });
}
