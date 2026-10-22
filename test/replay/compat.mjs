import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import "../register.mjs";
import { piRoot } from "../pi-host.mjs";
import { recordedTimeline, summary } from "./timeline.mjs";

import {configure, reportPath, writeReport} from "./source.mjs";
const fixturePath = fileURLToPath(new URL("../fixtures/session-slice.json", import.meta.url));
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const args = new Map(process.argv.slice(2).map((arg) => {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/u);
  assert.ok(match, `expected --option[=value], received ${arg}`);
  return [match[1], match[2] ?? true];
}));
if (args.has("help")) {
  console.log("Production Pi replay: --out-dir=DIR --sources=MANIFEST --plain --quiet --width=80 --speed=1 --scenario=fixed|continuous-tools --history=1000\nTTY uses Pi TuiMainScreen + ProcessTerminal; q/Ctrl+C exits.\nText is recorded; source timing is synthetic and never waits for display drain. Commands are never executed.\nCurrent production plays directly; output JSON cannot overwrite an existing report.");
  process.exit(0);
}
const requestedWidth = Number(args.get("width") ?? 80);
const speed = Number(args.get("speed") ?? 1);
const historyCount = Number(args.get("history") ?? 0);
const scenario = String(args.get("scenario") ?? "fixed");
assert.ok(Number.isInteger(requestedWidth) && requestedWidth >= 24, "--width must be an integer >=24");
assert.ok(Number.isFinite(speed) && speed > 0, "--speed must be positive");
assert.ok(Number.isInteger(historyCount) && historyCount >= 0, "--history must be a nonnegative integer");
const plain = args.has("plain") || !process.stdin.isTTY || !process.stdout.isTTY;
const width = plain ? requestedWidth : Math.min(requestedWidth, process.stdout.columns || requestedWidth);
const timeline = recordedTimeline(fixture, scenario);
assert.equal(args.get("variant"), undefined, "this verification entry runs current production only");
assert.ok(args.get("sources"), "compat measurements require independent --sources=manifest.json");
const output = reportPath(`compat-${scenario}-${width}-h${historyCount}${plain ? "" : "-tty"}.json`);
const boundSource = configure();
const sourceHashes = () => Object.fromEntries(Object.entries(boundSource.info.original).map(([path]) => [path.split("/").at(-1), createHash("sha256").update(readFileSync(path)).digest("hex")]));
const executedSourceHashes = sourceHashes();
const piSourceHashes = () => Object.fromEntries(Object.keys(boundSource.info.pi).map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const executedPiSourceHashes = piSourceHashes();
let previousHostState;
let frozenPrefixChecks = 0;
let clearScrollbackWrites = 0;
const motionSource = readFileSync(new URL("../../extensions/motion.ts", import.meta.url), "utf8");
const elapsedProduction = /export function motionNow\(/u.test(motionSource);
const { Container, Text, TuiMainScreen, ProcessTerminal, stripTerminalSequences } = await import("@earendil-works/pi-tui");
const host = (path) => import(pathToFileURL(join(piRoot, "dist", path)).href);
const theme = await host("modes/interactive/theme/theme.js");
const { AssistantMessageComponent } = await host("modes/interactive/components/assistant-message.js");
const { ToolExecutionComponent } = await host("modes/interactive/components/tool-execution.js");
const { default: compactUi2Tree } = await import("../../extensions/compact-ui2tree.ts");
const { MOTION_TICK_MS, attachMotionScheduler } = await import("../../extensions/motion.ts");
theme.initTheme("dark", false);

// The production scheduler receives an injected monotonic clock. Plain mode
// jumps to the next absolute deadline; TTY mode uses actual elapsed wall time
// scaled by --speed, including delayed wakes. No tick count represents time.
const intervals = new Map();
let now = 0;
const clock = {
  now: () => now,
  setInterval(callback, delay) {
    const token = {};
    intervals.set(token, { callback, delay, due: now + delay });
    return token;
  },
  clearInterval(token) { intervals.delete(token); },
};
const terminal = new ProcessTerminal();
Object.defineProperty(terminal, "columns", { get: () => width });
if (plain) Object.defineProperty(terminal, "rows", { get: () => 24 });
const tui = new TuiMainScreen(terminal, false);
if (plain) tui.requestRender = () => {};
const handlers = new Map();
const patchKey = Symbol.for("pi-compact-ui2tree/container-render-v1");
let footer;
let running = true;
let started = false;
let completed = false;
let shutdownTimers;
let drainAtMs = null;
let motionCallbacks = 0;
let bytes = 0;
let writes = 0;
let wallOrigin = 0;
let previousTerminalWriteAt;
let previousFrameWallAt;
const frameWallGaps = [];
const terminalWriteGaps = [];
const motionWallGaps = [];
let previousMotionWallAt;
const frames = [];
const terminalFrames = [];
let previousRows = [];
const piDoRender = tui.doRender.bind(tui);
if (!plain) tui.doRender = () => {
  const start = performance.now();
  const before = bytes;
  const cpu = process.cpuUsage();
  const result = piDoRender();
  const used = process.cpuUsage(cpu);
  terminalFrames.push({ wallAtMs: start - wallOrigin, logicalAtMs: now, durationMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, bytes: bytes - before });
  const state = tui.captureRenderState();
  if (previousHostState && previousHostState.previousWidth === state.previousWidth && previousHostState.previousHeight === state.previousHeight) {
    assert.deepEqual(state.previousLines.slice(0, previousHostState.previousViewportTop), previousHostState.previousLines.slice(0, previousHostState.previousViewportTop), "normalized frozen prefix changed");
    frozenPrefixChecks += 1;
  }
  previousHostState = state;
  return result;
};
const realStdoutWrite = process.stdout.write;
const terminalWrite = function(chunk, ...rest) {
  bytes += Buffer.byteLength(chunk);
  if (String(chunk).includes("\x1b[3J")) clearScrollbackWrites += 1;
  writes += 1;
  const wall = performance.now();
  if (previousTerminalWriteAt !== undefined) terminalWriteGaps.push(wall - previousTerminalWriteAt);
  previousTerminalWriteAt = wall;
  return realStdoutWrite.call(this, chunk, ...rest);
};
compactUi2Tree({ on(name, handler) { handlers.set(name, handler); } });
const ctx = { mode: "tui", ui: {
  get theme() { return theme.theme; },
  setWorkingMessage() {}, setWorkingIndicator() {}, getToolsExpanded: () => false,
  setFooter(factory) { footer = factory(tui, theme.theme, {}); },
} };
const stop = () => { running = false; };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
tui.addInputListener((data) => {
  if (["q", "\u0003", "\u001b"].includes(data)) { stop(); return { consume: true }; }
  return undefined;
});
const header = new Text("Pi production · recorded text / fixed synthetic arrivals", 0, 0);
const chat = new Container();
tui.addChild(header);
tui.addChild(chat);
const thinking = (text, toolCount = 0) => ({ role: "assistant", stopReason: "toolUse", content: [
  { type: "thinking", thinking: text },
  ...Array.from({ length: toolCount }, (_, index) => ({ type: "toolCall", id: `recorded-bash-${index}`, name: "bash", arguments: { command: fixture.command } })),
] });
// Historical load is actual native AssistantMessageComponent instances. A native
// boundary per 20 messages prevents a single artificial all-history scope.
const setupStarted = performance.now();
for (let index = 0; index < historyCount; index += 1) {
  if (index % 20 === 0) chat.addChild(new Text(`Historical request ${index / 20 + 1}`, 0, 0));
  chat.addChild(new AssistantMessageComponent(thinking(fixture.thinking), true));
}
const first = new AssistantMessageComponent(undefined, true);
chat.addChild(first);
const setupMs = performance.now() - setupStarted;
let next;
const tools = new Map();

function snapshot() {
  const root = Container.prototype[patchKey]?.rootFrames?.get(tui);
  assert.ok(root, "production root coordinator must own the TUI root");
  return root.coordinator.render();
}
function capture(event, tickPreparationMs = 0, sourceEvents = [], sourceUpdateMs = 0, tickCpuMs = 0) {
  const wallAt = performance.now();
  if (previousFrameWallAt !== undefined) frameWallGaps.push(wallAt - previousFrameWallAt);
  previousFrameWallAt = wallAt;
  const renderStarted = performance.now();
  const renderCpu = process.cpuUsage();
  const rows = tui.render(width);
  const renderMs = performance.now() - renderStarted;
  const renderCpuUsage = process.cpuUsage(renderCpu);
  const renderCpuMs = (renderCpuUsage.user + renderCpuUsage.system) / 1000;
  const firstSnapshot = snapshot();
  const readStarted = performance.now();
  const again = tui.render(width);
  const repeatedReadMs = performance.now() - readStarted;
  const repeated = snapshot();
  assert.deepEqual(again, rows, `${event}: repeated render changed rows without input or tick`);
  assert.equal(repeated.rootRevision, firstSnapshot.rootRevision, `${event}: repeated render published a revision`);
  const root = firstSnapshot.owners[0];
  assert.equal(firstSnapshot.owners.length, 1, "nested components must publish through one root transaction");
  const plainRows = rows.map((row) => stripTerminalSequences(row).trimEnd());
  const previous = frames.at(-1);
  // Request a host render and let Pi coalesce it using its own frame limit.
  // Calling renderNow here would fabricate two terminal frames when source
  // arrival and motion service share one instant.
  if (!plain) tui.requestRender();
  frames.push({
    event, sourceEvents: sourceEvents.map(({ kind, id, atMs }) => ({ kind, id, scheduledAtMs: atMs, appliedAtMs: now, latenessMs: now - atMs })),
    tick: motionCallbacks, atMs: now, wallAtMs: wallAt - wallOrigin,
    rootRevision: firstSnapshot.rootRevision,
    phase: root.phase, progress: root.progress ?? null,
    height: rows.length, heightDelta: rows.length - (previous?.height ?? 0),
    changedRows: Array.from({ length: Math.max(rows.length, previousRows.length) }, (_, i) => plainRows[i] !== previousRows[i]).filter(Boolean).length,
    preparationMs: tickPreparationMs + renderMs, preparationCpuMs: tickCpuMs + renderCpuMs, tickPreparationMs, renderMs, repeatedReadMs, sourceUpdateMs,
    // Keep evidence bounded with history=1000; complete rows still participate
    // in repeated-render assertions and height measurements above.
    rows: historyCount ? plainRows.slice(-40) : plainRows,
    rowsSha256: createHash("sha256").update(JSON.stringify(plainRows)).digest("hex"),
    rowsOmitted: historyCount ? Math.max(0, plainRows.length - 40) : 0,
  });
  previousRows = plainRows;
}
function apply(event) {
  switch (event.kind) {
    case "thinking-arrival": first.updateContent(thinking(event.text), true); break;
    case "thinking-complete-tool-call": first.updateContent(thinking(fixture.thinking, event.toolCount), false); break;
    case "tool-start": {
      const tool = new ToolExecutionComponent("bash", event.id, { command: fixture.command }, {}, undefined, tui, process.cwd());
      tools.set(event.id, tool); chat.addChild(tool); tool.setArgsComplete(); tool.markExecutionStarted(); break;
    }
    case "tool-output-arrival": case "tool-complete":
      tools.get(event.id).updateResult({ content: [{ type: "text", text: event.text }], isError: false }, event.kind !== "tool-complete"); break;
    case "next-assistant-created": next = new AssistantMessageComponent(undefined, true); chat.addChild(next); break;
    case "next-thinking-arrival": next.updateContent(thinking(event.text), true); break;
    case "source-complete": break;
    default: assert.fail(`unknown source event: ${event.kind}`);
  }
}
async function reach(target) {
  if (plain) { now = target; return; }
  const remaining = target / speed - (performance.now() - wallOrigin);
  // Yield even after a late frame: Pi's own render timer and input handlers
  // must run before another catch-up iteration. No microtask-only busy loop.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining)));
  now = Math.max(now, (performance.now() - wallOrigin) * speed);
}

try {
  handlers.get("session_start")({}, ctx);
  attachMotionScheduler(() => tui.requestRender(), clock);
  if (!plain) { process.stdout.write = terminalWrite; tui.start(); started = true; }
  wallOrigin = performance.now();
  capture("initial-empty-assistant");
  let sourceIndex = 0;
  while (running) {
    if (sourceIndex === timeline.events.length && !intervals.size) {
      drainAtMs ??= now;
      if (now >= drainAtMs + 500) { completed = true; break; }
    }
    const nextSource = timeline.events[sourceIndex]?.atMs ?? Infinity;
    const nextTick = Math.min(...[...intervals.values()].map((timer) => timer.due));
    const idleEnd = drainAtMs === null ? Infinity : drainAtMs + 500;
    const target = Math.min(nextSource, nextTick, idleEnd);
    assert.ok(Number.isFinite(target), "source complete without a bounded settle target");
    assert.ok(target <= timeline.sourceEndAtMs + 150_000, "motion failed to settle within 150 seconds after source completion");
    await reach(target);
    if (!running) break;
    const dueSources = [];
    while (timeline.events[sourceIndex]?.atMs <= now + 1e-7) dueSources.push(timeline.events[sourceIndex++]);
    const sourceStarted = performance.now();
    for (const event of dueSources) apply(event);
    const sourceUpdateMs = performance.now() - sourceStarted;
    if (dueSources.length) capture(dueSources.map(({ kind }) => kind).join("+"), 0, dueSources, sourceUpdateMs);
    let tickPreparationMs = 0;
    let tickCpuMs = 0;
    let ticked = false;
    for (const timer of [...intervals.values()]) {
      if (timer.due > now + 1e-7) continue;
      // Wake once at the current monotonic time. Missed intervals do not create
      // a queue of old frames or backdate arrivals from the source schedule.
      timer.due = now + timer.delay;
      const startedAt = performance.now();
      if (previousMotionWallAt !== undefined) motionWallGaps.push(startedAt - previousMotionWallAt);
      previousMotionWallAt = startedAt;
      const callbackCpu = process.cpuUsage();
      timer.callback();
      const callbackCpuUsage = process.cpuUsage(callbackCpu);
      tickCpuMs += (callbackCpuUsage.user + callbackCpuUsage.system) / 1000;
      tickPreparationMs += performance.now() - startedAt;
      motionCallbacks += 1;
      ticked = true;
    }
    if (ticked) capture("motion-tick", tickPreparationMs, [], 0, tickCpuMs);
    else if (!dueSources.length) capture("idle-timer-check");
  }
} finally {
  if (started) tui.stop();
  footer?.dispose();
  handlers.get("session_shutdown")({}, ctx);
  shutdownTimers = intervals.size;
  process.stdout.write = realStdoutWrite;
  process.off("SIGINT", stop); process.off("SIGTERM", stop);
  assert.equal(shutdownTimers, 0, "session shutdown must stop every injected motion timer");
  if (started) process.stdin.pause();
}

assert.deepEqual(sourceHashes(), executedSourceHashes, "production source changed during replay");
assert.deepEqual(piSourceHashes(), executedPiSourceHashes, "Pi source changed during replay");
if (!plain) {
  assert.ok(completed, "actual PTY replay completed");
  assert.equal(tui.fullRedraws, 1, "no extra full redraw");
  assert.equal(clearScrollbackWrites, 0, "no scrollback clear");
  assert.ok(frozenPrefixChecks > 0, "actual host prefix checked");
}
const transitions = frames.filter((frame) => frame.phase === "transition");
const contractions = frames.filter((frame) => frame.heightDelta < 0 && !["transition", "committed"].includes(frame.phase));
const warm = frames.slice(1);
const retainedBoundaries = ["thinking-complete-tool-call", "next-thinking-arrival"].map((kind) => {
  const index = frames.findIndex((frame) => frame.sourceEvents.some((event) => event.kind === kind));
  return { kind, atMs: frames[index]?.atMs, beforeHeight: frames[index - 1]?.height, afterHeight: frames[index]?.height };
});
if (completed && scenario === "fixed") for (const boundary of retainedBoundaries) {
  assert.ok(boundary.afterHeight >= boundary.beforeHeight, `${boundary.kind}: body disappeared at source admission before a structural tick`);
}
const sourceApplications = frames.flatMap((frame) => frame.sourceEvents);
const metrics = {
  framePreparationMs: summary(warm.map((frame) => frame.preparationMs)),
  framePreparationCpuMs: summary(warm.map((frame) => frame.preparationCpuMs)),
  motionPreparationMs: summary(warm.filter((frame) => frame.event === "motion-tick").map((frame) => frame.tickPreparationMs)),
  sourceUpdateMs: summary(warm.filter((frame) => frame.sourceEvents.length).map((frame) => frame.sourceUpdateMs)),
  repeatedReadMs: summary(warm.map((frame) => frame.repeatedReadMs)),
  coldInitialFrameMs: frames[0]?.preparationMs ?? null, historyConstructionMs: setupMs,
  terminalRenderMs: plain ? null : summary(terminalFrames.map((frame) => frame.durationMs)),
  terminalRenderCpuMs: plain ? null : summary(terminalFrames.map((frame) => frame.cpuMs)),
  wallFrameGapsMs: plain ? null : summary(terminalFrames.slice(1).map((frame, index) => frame.wallAtMs - terminalFrames[index].wallAtMs)),
  wallCaptureGapsMs: plain ? null : summary(frameWallGaps),
  wallMotionGapsMs: plain ? null : summary(motionWallGaps),
  wallTerminalWriteGapsMs: plain ? null : summary(terminalWriteGaps),
  terminalBytes: plain ? null : bytes, terminalWrites: plain ? null : writes,
  sourceLatenessMs: summary(sourceApplications.map((event) => event.latenessMs)),
  preparationWithin25msAtP95: summary(warm.map((frame) => frame.preparationMs)).p95 <= 25,
  note: "Preparation measures actual callback/root-read elapsed and process CPU (including any runtime workers); duplicate assertion reads are reported separately. Plain mode measures CPU only, not real frame gaps or terminal bytes. Terminal byte count includes Pi setup/cleanup writes. TTY time includes harness assertion/trace overhead, so it is not a profiler of uninstrumented Pi.",
};
const evidence = {
  source: boundSource.info,
  fixture: { path: "test/fixtures/session-slice.json", sha256: createHash("sha256").update(fixtureBytes).digest("hex"), session: fixture.session, originalFields: ["thinking", "command", "output", "nextThinking"], outputNote: "Recorded excerpt; outputBytes/outputLines describe the longer original result." },
  timing: { ...timeline.metadata, clock: plain ? "injected monotonic absolute virtual time" : "injected scaled performance.now elapsed", samplingMs: MOTION_TICK_MS, speed, sourceWaitsForDrain: false },
  implementation: { elapsedProduction,
    loadedProjectionSha256: executedSourceHashes["projection.ts"],
    sourceSha256: executedSourceHashes, piSourceSha256: executedPiSourceHashes,
    entrySha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), sourceUnchangedDuringReplay: JSON.stringify(executedSourceHashes) === JSON.stringify(sourceHashes()) },
  environment: { node: process.version, pi: JSON.parse(readFileSync(join(piRoot, "package.json"))).version, width, rows: terminal.rows, historyNodes: historyCount, historyNativeBoundaries: Math.ceil(historyCount / 20), mode: plain ? "native-component-trace" : "Pi-TuiMainScreen-ProcessTerminal" },
  validation: { completed, repeatRenderUnchanged: true, retainedBoundaries, shutdownTimers, idleTimerCount: drainAtMs === null ? null : 0, frameCount: frames.length, logicalDurationMs: now, displayDrainedAtMs: drainAtMs, sourceEndAtMs: timeline.sourceEndAtMs, remainingAfterSourceMs: drainAtMs === null ? null : drainAtMs - timeline.sourceEndAtMs, transitionFrames: transitions.length, nonTransactionContractions: contractions.map(({ atMs, event, heightDelta, phase }) => ({ atMs, event, heightDelta, phase })), fullRedraws: tui.fullRedraws, clearScrollbackWrites, frozenPrefixChecks },
  metrics, terminalFrames, frames,
};
boundSource.verify();
writeReport(output, evidence);
console.log(`Production replay ${completed ? "completed" : "interrupted"}: ${frames.length} frames; ${now.toFixed(1)} ms logical elapsed; ${transitions.length} transition frames; shutdown timers ${shutdownTimers}.`);
console.log(`Preparation p50/p95 ${metrics.framePreparationMs.p50?.toFixed(3)}/${metrics.framePreparationMs.p95?.toFixed(3)} ms; history ${historyCount}; source is fixed, drain ${drainAtMs?.toFixed(1)} ms.`);
console.log(output);
if (plain && !args.has("quiet")) for (const frame of frames) console.log(`\n[${frame.atMs}ms ${frame.event} r${frame.rootRevision} ${frame.phase}${frame.progress === null ? "" : ` ${frame.progress}`} h=${frame.height}]\n${frame.rows.join("\n")}`);
