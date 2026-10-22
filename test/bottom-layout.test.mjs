import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Container, CURSOR_MARKER, Editor, Spacer, Text, TuiMainScreen, stripTerminalSequences } from "@earendil-works/pi-tui";

/** The host answers each clock request with a frame. Tests drive paints explicitly,
 * so a request is modelled as a render pull: it prepares roots but is never a receipt. */
function pullRoots() {
  for (const ref of Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")]?.roots ?? []) {
    const frame = ref.deref(), root = frame?.container.deref();
    if (frame && root) root.render(frame.width);
  }
}
import install from "../extensions/compact-ui2tree.ts";
import { fitBottom } from "../extensions/bottom-layout.ts";
import { materialize } from "../extensions/snapshot.ts";
import { ProjectionCache } from "../extensions/projection.ts";
import { attachMotionScheduler } from "../extensions/motion.ts";
import { piRoot } from "./pi-host.mjs";

const host = (name) => import(pathToFileURL(join(piRoot, "dist", name)).href);
const theme = await host("modes/interactive/theme/theme.js");
const { createInteractiveTuiReference } = await host("modes/interactive/tui-renderer.js");
const { AssistantMessageComponent } = await host("modes/interactive/components/assistant-message.js");
const { ToolExecutionComponent } = await host("modes/interactive/components/tool-execution.js");
const { CustomEditor } = await host("modes/interactive/components/custom-editor.js");
const { KeybindingsManager } = await host("core/keybindings.js");
const { WorkingStatusIndicator } = await host("modes/interactive/components/status-indicator.js");
theme.initTheme("dark", false);

function fixture(t, { width = 80, history = 0, requests = 3, toolNames = ["bash", "read"], nativeFirst = false, glyphs = "", mountFooter = true, customEditor = false, beforeNative, beforeActivation } = {}) {
  const writes = [];
  const terminal = { columns: width, rows: 24, write: (text) => writes.push(text), hideCursor() {}, showCursor() {}, start() {}, stop() {} };
  const tui = new TuiMainScreen(terminal, false);
  tui.setClearOnShrink(false);
  // Like Pi, a forced request drops the previous frame and schedules an immediate
  // full redraw; draw() runs that redraw before it reads the frame.
  let forced = false;
  tui.requestRender = (force) => { if (force) { tui.resetRenderState(); forced = true; } pullRoots(); };
  const ui = createInteractiveTuiReference(() => tui);
  assert.notEqual(ui, tui);
  assert.equal(ui.children, tui.children);
  const regions = Array.from({ length: 7 }, () => new Container());
  const [document, pending, status, above, editorRegion, below, footerRegion] = regions;
  const editor = customEditor
    ? new CustomEditor(ui, theme.getEditorTheme(), new KeybindingsManager(), { paddingX: 3, embedWorkingStatus: true })
    : new Editor(ui, theme.getEditorTheme());
  editor.setText("INPUT marker");
  editorRegion.addChild(editor);
  tui.setFocus(editor);
  if (history) document.addChild(new Text(Array.from({ length: history }, (_, i) => `HISTORY ${i}${glyphs}`).join("\n"), 0, 0));
  const chat = new Container(); document.addChild(chat);
  chat.addChild(new Text("USER investigate", 0, 0));
  for (let index = 0; index < requests; index += 1) {
    chat.addChild(new AssistantMessageComponent({ role: "assistant", stopReason: "toolUse", content: [
      { type: "thinking", thinking: `Request ${index}${glyphs}\nreasoning detail` },
    ] }, true));
    for (const toolName of toolNames) {
      const tool = new ToolExecutionComponent(toolName, `${index}-${toolName}`,
        toolName === "bash" ? { command: "printf result" } : { path: "test.md" }, {}, undefined, ui, process.cwd());
      tool.setArgsComplete(); tool.markExecutionStarted();
      tool.updateResult({ content: [{ type: "text", text: "result\nsecond line\nthird line" }], isError: false });
      chat.addChild(tool);
    }
  }
  for (const region of regions) tui.addChild(region);
  footerRegion.addChild(new Text("NATIVE FOOTER", 0, 0));
  beforeNative?.({ chat, ui, tui });
  if (nativeFirst) tui.renderNow();
  const nativeState = tui.captureRenderState();
  beforeActivation?.({ chat, ui, tui });
  const handlers = new Map();
  install({ on: (name, handler) => handlers.set(name, handler), registerCommand() {} });
  let expanded = false;
  let footer;
  const ctx = { mode: "tui", sessionManager: { getCwd: () => process.cwd(), getBranch: () => [] },
    getContextUsage: () => undefined, model: { id: "model", reasoning: true }, thinkingLevel: "medium",
    ui: { get theme() { return theme.theme; }, getToolsExpanded: () => expanded,
      onTerminalInput() { return () => {}; }, setWorkingIndicator() {}, setWorkingMessage() {}, setFooter(factory) {
        footer?.dispose(); footer = factory(ui, theme.theme, {});
        if (mountFooter) { footerRegion.clear(); footerRegion.addChild(footer); }
      } } };
  let now = 0;
  const timers = new Map();
  function clock() {
    attachMotionScheduler(() => {}, { now: () => now,
      setInterval(callback) { const id = {}; timers.set(id, callback); return id; }, clearInterval: (id) => timers.delete(id) });
  }
  handlers.get("session_start")({}, ctx); clock();
  t.after(() => { footer.dispose(); handlers.get("session_shutdown")({}, ctx); tui.stop(); assert.equal(timers.size, 0); });
  let previous = nativeFirst ? nativeState : undefined;
  const samples = [];
  const frame = () => Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")].rootFrames.get(tui);
  function draw({ pinned = true, prefix = true } = {}) {
    tui.renderNow();
    for (let i = 0; forced && i < 3; i += 1) { forced = false; previous = undefined; tui.renderNow(); }
    assert.equal(forced, false, "a forced redraw settles");
    const state = tui.captureRenderState();
    const rows = state.previousLines.map(stripTerminalSequences);
    if (pinned) {
      const footerLast = stripTerminalSequences(footer.render(terminal.columns).at(-1));
      assert.equal(rows.findLastIndex((row) => row === footerLast) - state.previousViewportTop, terminal.rows - 1, "footer stays on terminal bottom");
    }
    assert.ok(state.hardwareCursorRow >= state.previousViewportTop && state.hardwareCursorRow < state.previousViewportTop + terminal.rows, "native caret remains visible");
    if (prefix && previous && previous.previousWidth === state.previousWidth) {
      const boundary = process.env.TERMUX_VERSION && previous.previousHeight !== terminal.rows
        ? Math.max(0, previous.previousViewportTop + previous.previousHeight - terminal.rows) : previous.previousViewportTop;
      assert.deepEqual(state.previousLines.slice(0, boundary), previous.previousLines.slice(0, boundary), "frozen host prefix");
    }
    const published = frame().coordinator.render();
    for (const block of published.owners[0].blocks) {
      if (block.deadlineAt !== undefined) { const duration = block.deadlineAt - block.startedAt; assert.equal(duration % 150, 0); assert.ok(duration >= 150 && duration <= 2400); assert.equal(block.startedAt % 150, 0); }
    }
    samples.push({ cursor: state.hardwareCursorRow - state.previousViewportTop, input: rows.findIndex((row) => row.includes("INPUT marker")) - state.previousViewportTop,
      moving: published.owners[0].blocks.some((block) => block.deadlineAt !== undefined) });
    previous = state;
    return state;
  }
  function tick() { now += 25; for (const callback of [...timers.values()]) callback(); }
  function settle(options) { for (let i = 0; timers.size && i < 1000; i += 1) { tick(); draw(options); } assert.equal(timers.size, 0); }
  return { tui, ui, terminal, writes, document, chat, pending, status, above, below, editor, editorRegion, footerRegion,
    ctx, handlers, frame, draw, tick, settle, samples, nativeState, setExpanded: (value) => { expanded = value; },
    shutdown: () => handlers.get("session_shutdown")({}, ctx),
    // Pi starts every later session with one of its replacement reasons; the
    // plugin then reprints the document, so the frozen prefix starts anew.
    restart: () => { handlers.get("session_start")({ reason: "resume" }, ctx); clock(); previous = undefined; },
    enableBottom: () => { mountFooter = true; handlers.get("session_start")({ reason: "reload" }, ctx); clock(); previous = undefined; },
    reload: (replacement) => { replacement({ on: (name, handler) => handlers.set(name, handler), registerCommand() {} }); handlers.get("session_start")({ reason: "reload" }, ctx); clock(); previous = undefined; },
    footer: () => footer };
}

for (const width of [40, 80]) test(`input style mounts once and preserves editing state through lifecycle at ${width} columns`, (t) => {
  const f = fixture(t, { width, requests: 0, customEditor: true });
  f.ctx.sessionManager.getBranch = () => assert.fail("simple footer does not collect branch usage");
  assert.ok(!f.handlers.has("turn_start"), "no footer speed tracking");
  f.handlers.get("message_update")({ message: { role: "assistant", content: [] } }, f.ctx);
  f.handlers.get("message_end")({ message: { role: "assistant", content: [] } }, f.ctx);
  const editor = f.editor, render = editor.render, input = editor.handleInput;
  editor.addToHistory("native HISTORY");
  editor.setText("");
  const payload = Array.from({ length: 12 }, (_, i) => `paste line ${i}`).join("\n");
  editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
  const state = { text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() };
  f.draw(); f.settle();
  assert.equal(f.editorRegion.children[0], editor);
  assert.equal(editor.handleInput, input);
  assert.equal(editor.getPaddingX(), 3);
  assert.notEqual(editor.render, render);
  const installed = editor.render;
  f.draw();
  assert.equal(editor.render, installed, "repeated root reads do not stack wrappers");
  assert.deepEqual({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() }, state);
  assert.match(stripTerminalSequences(f.footer().render(width)[0]), /^  model medium · /);
  f.restart(); f.draw(); f.settle();
  assert.equal(editor.getExpandedText(), payload);
  editor.insertTextAtCursor(" suffix"); editor.handleInput("\x1f");
  assert.equal(editor.getExpandedText(), payload);
  editor.handleInput("\x1f"); assert.equal(editor.getText(), "");
  editor.render(width); editor.handleInput("\x1b[A"); assert.equal(editor.getText(), "native HISTORY");
  f.footer().dispose();
  assert.equal(editor.render, render, "footer release restores the native renderer");
  f.restart(); f.draw();
  assert.notEqual(editor.render, render);
  f.shutdown();
  assert.equal(editor.render, render, "session shutdown releases its own adapter");
  assert.equal(editor.handleInput, input);
  assert.equal(editor.getText(), "native HISTORY");
});

test("input style follows the mounted editor and releases it when the root identity no longer matches", (t) => {
  const f = fixture(t, { requests: 0, customEditor: true });
  const original = f.editor.render;
  f.draw(); f.settle();
  const replacement = new CustomEditor(f.ui, theme.getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
  replacement.setText("replacement draft");
  const replacementRender = replacement.render;
  f.editorRegion.clear(); f.editorRegion.addChild(replacement); f.tui.setFocus(replacement);
  f.draw();
  assert.equal(f.editor.render, original);
  assert.notEqual(replacement.render, replacementRender);
  f.editorRegion.clear(); f.editorRegion.addChild(new Text("temporary reload display", 0, 0));
  f.tui.render(80);
  assert.equal(replacement.render, replacementRender);
  f.editorRegion.clear(); f.editorRegion.addChild(replacement);
  f.draw();
  assert.notEqual(replacement.render, replacementRender);
  f.footerRegion.clear(); f.footerRegion.addChild(new Text("other footer", 0, 0));
  f.tui.render(80);
  assert.equal(replacement.render, replacementRender, "unrecognized root releases the mounted editor");
  assert.equal(replacement.getText(), "replacement draft");
  f.restart(); f.draw();
  assert.notEqual(replacement.render, replacementRender);
});

test("styled input keeps bottom placement, native working ownership, root clicks and live theme changes", (t) => {
  const statusTimers = new Set();
  t.mock.method(globalThis, "setInterval", () => { const id = {}; statusTimers.add(id); return id; });
  t.mock.method(globalThis, "clearInterval", (id) => statusTimers.delete(id));
  const f = fixture(t, { width: 40, requests: 0, customEditor: true });
  const editor = f.editor;
  f.draw(); f.settle();
  const installed = editor.render;
  const indicator = new WorkingStatusIndicator(f.ui, "native working");
  editor.setWorkingStatusIndicator(indicator);
  t.after(() => { indicator.dispose(); theme.initTheme("dark", false); });
  const working = f.draw();
  assert.equal(statusTimers.size, 1, "styling creates no extra loader timer");
  assert.equal(editor.workingStatusIndicator, indicator);
  assert.equal(f.status.children.length, 0, "working is not duplicated in a separate region");
  assert.equal(working.previousLines.filter((row) => stripTerminalSequences(row).includes("native working")).length, 1);
  const caretY = working.hardwareCursorRow;
  assert.equal(caretY - working.previousViewportTop, 21);
  f.tui.handleMouse({ type: "click", button: "left", x: 2, y: caretY, width: 40, height: working.previousLines.length });
  assert.equal(editor.getCursor().col, 0);
  f.tui.handleMouse({ type: "click", button: "left", x: 5, y: caretY, width: 40, height: working.previousLines.length });
  assert.equal(editor.getCursor().col, 3);
  const text = editor.getText();
  theme.initTheme("light", false); f.draw();
  assert.equal(editor.render, installed, "theme changes do not reinstall the editor");
  assert.ok(editor.render(40)[3].startsWith(theme.theme.getBgAnsi("userMessageBg")));
  assert.equal(editor.getText(), text);
  editor.setText(Array.from({ length: 15 }, (_, i) => `row ${i} 界🙂`).join("\n"));
  f.draw();
  f.above.addChild(new Text(Array.from({ length: 30 }, (_, i) => `widget ${i}`).join("\n"), 0, 0));
  f.draw();
  assert.equal(editor.getPaddingX(), 3);
  indicator.dispose(); editor.setWorkingStatusIndicator(undefined);
  f.draw();
  assert.equal(statusTimers.size, 0);
});

for (const width of [80, 40]) test(`mounted Proxy root pins editor/footer through row-count animation at ${width} columns`, (t) => {
  const f = fixture(t, { width, history: 24 });
  f.draw(); f.settle();
  f.chat.addChild(new Text("NEXT USER", 0, 0)); f.draw(); f.settle();
  f.setExpanded(true); f.draw(); f.settle();
  f.setExpanded(false); f.draw(); f.settle();
  assert.equal(new Set(f.samples.map((sample) => sample.input)).size, 1, "editor position independent of chat animation");
  assert.ok(f.samples.some((sample) => sample.moving), "observe actual row-count intermediate publications");
  // Both Ctrl+O results reach rows already in scrollback, so each reprints once, as Pi does
  // for its own changes above the viewport.
  assert.equal(f.tui.fullRedraws, 3, "the first paint and one cleared redraw per Ctrl+O");
  assert.equal(f.writes.filter((write) => write.includes("\x1b[3J")).length, 2);
});

// The frame Pi shows equals a fresh full redraw of the same state, so nothing held back is left on screen.
function assertShowsState(f, message) {
  const shown = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  f.tui.resetRenderState(); f.tui.renderNow();
  assert.deepEqual(shown, f.tui.captureRenderState().previousLines.map(stripTerminalSequences), message);
}

test("Ctrl+O reprints once only when its result cannot be drawn in place", (t) => {
  const inPlace = fixture(t, { requests: 1, toolNames: ["read"] });
  inPlace.draw(); inPlace.settle();
  const redraws = inPlace.tui.fullRedraws;
  inPlace.setExpanded(true); inPlace.draw(); inPlace.settle();
  inPlace.setExpanded(false); inPlace.draw(); inPlace.settle();
  assert.equal(inPlace.tui.fullRedraws, redraws, "a result drawn in place needs no reprint");
  assertShowsState(inPlace, "collapsed in place");
  // As in the row-count animation test: the earlier request's rows reach scrollback.
  const held = fixture(t, { history: 24 });
  held.draw(); held.settle();
  held.chat.addChild(new Text("NEXT USER", 0, 0)); held.draw(); held.settle();
  for (const expanded of [true, false]) {
    const before = held.tui.fullRedraws;
    held.setExpanded(expanded); held.draw(); held.settle();
    assert.equal(held.tui.fullRedraws, before + 1, `${expanded ? "expand" : "collapse"} reprints once`);
    assertShowsState(held, `${expanded ? "expanded" : "collapsed"} result shown at once`);
  }
});

function appendRequest(chat, ui, name, mixed = false, newUser = true) {
  if (newUser) chat.addChild(new Text(`${name} USER`, 0, 0));
  chat.addChild(new AssistantMessageComponent({ role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: `${name} THINKING\nnew body` },
    ...(mixed ? [{ type: "text", text: `${name} PROSE` }] : []),
  ] }, true));
  const tool = new ToolExecutionComponent("bash", name, { command: `printf ${name}-TOOL` }, {}, undefined, ui, process.cwd());
  tool.setArgsComplete(); tool.markExecutionStarted();
  tool.updateResult({ content: [{ type: "text", text: `${name} result` }], isError: false });
  chat.addChild(tool);
}

// Entries keep arriving after a Ctrl+O; once the blocks it set moving have arrived, a later
// held-back entry is ordinary streaming, not a Ctrl+O result (independent review of 1ays327o).
for (const pressed of [false, true]) test(`entries held back after a Ctrl+O has arrived need no reprint (${pressed ? "pressed" : "already on"})`, (t) => {
  const f = fixture(t, { requests: 1, toolNames: ["read"] });
  if (!pressed) f.setExpanded(true);
  f.draw(); f.settle(); f.draw();
  if (pressed) f.setExpanded(true);
  f.draw();
  const before = f.tui.fullRedraws;
  let held = 0;
  for (let i = 0; i < 14; i++) {
    appendRequest(f.chat, f.ui, `LATER_${i}`); f.draw();
    for (let k = 0; k < 4; k++) { f.tick(); f.draw(); if (f.frame().coordinator.hasDeferred) held++; }
  }
  f.settle();
  assert.ok(held > 0, "a later entry is held back");
  assert.equal(f.tui.fullRedraws, before);
});

// Pi writes rows normalized (tabs expanded, Thai/Lao AM decomposed); adoption must
// compare in that form or it reprojects the printed history a second time.
for (const [prepare, glyphs] of [[false, ""], [true, ""], [false, "\tกำ"]]) test(`adoption covers printed native sources while admitting an unprinted request, prepared=${prepare}${glyphs ? ", glyphs" : ""}`, (t) => {
  const f = fixture(t, { history: 40, nativeFirst: true, glyphs, beforeActivation: ({ chat, ui, tui }) => {
    appendRequest(chat, ui, "QUEUED", prepare);
    // Native components already recorded their printed children. Merely adding
    // a new request must not make it part of the adopted historical coverage.
    if (prepare) chat.children.at(-1).render(80);
  } });
  const original = f.nativeState.previousLines.map(stripTerminalSequences);
  f.draw();
  assert.ok(!f.frame().coordinator.render().owners[0].blocks.some((block) => block.playback), "pre-activation source is restored history, not a live message");
  f.settle();
  const rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  for (let index = 0; index < 3; index++) assert.equal(rows.filter((row) => row.includes(`Request ${index}`)).length,
    original.filter((row) => row.includes(`Request ${index}`)).length, "already printed native Thinking is not replayed");
  assert.equal(rows.filter((row) => row.startsWith("HISTORY 0")).length, 1, "already printed native history is not drawn twice");
  for (const value of ["QUEUED USER", "Ran 1 shell command"]) assert.ok(rows.some((row) => row.includes(value)), value);
  assert.ok(rows.some((row) => row.includes("QUEUED THINKING")), "a request keeps Thinking when its later tool is present");
  if (prepare) assert.ok(rows.some((row) => row.includes("QUEUED PROSE")));
  appendRequest(f.chat, f.ui, "FRESH"); f.draw(); f.settle();
  assert.ok(f.tui.captureRenderState().previousLines.some((row) => row.includes("FRESH THINKING")));
  assert.equal(f.tui.fullRedraws, 1);
});

for (const mixed of [false, true]) test(`enabling the mounted bottom preserves old projected sources and pending new input, mixed=${mixed}`, (t) => {
  const f = fixture(t, { history: 40, mountFooter: false });
  f.setExpanded(true); f.draw({ pinned: false }); f.settle({ pinned: false });
  const old = f.frame().coordinator;
  const before = f.tui.captureRenderState();
  appendRequest(f.chat, f.ui, "QUEUED", mixed);
  f.tui.render(80); // Prepared by the existing host, but never written to Pi.
  if (!mixed) for (let tick = 0; tick < 12; tick++) f.tick();
  f.enableBottom(); f.draw(); f.settle();
  const rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  assert.notEqual(f.frame().coordinator, old, "the reload publishes with a new coordinator");
  for (let index = 0; index < 3; index++) assert.equal(rows.filter((row) => /^ ●/.test(row) && row.includes(`Request ${index}`)).length, 1, "adoption must not duplicate old source headings");
  for (const value of ["QUEUED USER", "QUEUED THINKING", "QUEUED-TOOL"]) assert.ok(rows.some((row) => row.includes(value)), value);
  if (mixed) assert.ok(rows.some((row) => row.includes("QUEUED PROSE")));
  assert.equal(rows.filter((row) => row.includes("INPUT marker")).length, 1, "unwritten preparation must not enlarge adopted history into the input");
  assert.equal(f.tui.fullRedraws, 2, "one cleared redraw for the session replacement");
});

for (const mixed of [false, true]) test(`native adoption continues same-user sources through cache recreation, mixed=${mixed}`, (t) => {
  const f = fixture(t, { history: 40, nativeFirst: true, beforeActivation: ({ chat, ui }) => {
    appendRequest(chat, ui, "SAME", mixed, false);
  } });
  const original = f.nativeState.previousLines.map(stripTerminalSequences);
  f.draw(); f.settle();
  let rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  assert.ok(rows.some((row) => row.includes("SAME THINKING")), "a request keeps Thinking when its tool is present");
  for (const value of ["Ran 1 shell command"]) assert.ok(rows.some((row) => row.includes(value)), value);
  if (mixed) assert.ok(rows.some((row) => row.includes("SAME PROSE")));
  for (let index = 0; index < 3; index++) assert.equal(rows.filter((row) => row.includes(`Request ${index}`)).length,
    original.filter((row) => row.includes(`Request ${index}`)).length);
  f.restart(); f.draw(); f.settle();
  appendRequest(f.chat, f.ui, "LATER", false, false); f.draw(); f.settle();
  rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  assert.ok(rows.some((row) => row.includes("LATER THINKING")));
  assert.ok(rows.some((row) => row.includes("Ran 1 shell command")));
  assert.equal(f.tui.fullRedraws, 2, "one cleared redraw for the session replacement");
});

test("native render-only preparation keeps earlier printed child ownership", (t) => {
  const f = fixture(t, { history: 40, nativeFirst: true, beforeActivation: ({ chat, ui, tui }) => {
    appendRequest(chat, ui, "UNWRITTEN", false, false);
    tui.render(80);
  } });
  const oldRows = f.nativeState.previousLines.map(stripTerminalSequences);
  f.draw(); f.settle();
  const rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  for (let index = 0; index < 3; index++) assert.equal(rows.filter((row) => row.includes(`Request ${index}`)).length,
    oldRows.filter((row) => row.includes(`Request ${index}`)).length);
  assert.ok(rows.some((row) => row.includes("UNWRITTEN THINKING")));
  assert.ok(rows.some((row) => row.includes("Ran 1 shell command")));
  assert.equal(f.tui.fullRedraws, 1);
});

for (const width of [80, 40]) for (const replace of [false, true])
test(`native adoption resumes a changed writable suffix after undrawn preparation, replace=${replace}, width=${width}`, async (t) => {
  const { InteractiveMode } = await host("modes/interactive/interactive-mode.js");
  const f = fixture(t, { width, history: 40, requests: 1, toolNames: ["bash"], nativeFirst: true, beforeActivation: ({ chat, ui, tui }) => {
    assert.ok(tui.captureRenderState().previousViewportTop <= 40, "changed source remains entirely addressable");
    if (replace) {
      chat.children.splice(1);
    } else {
      InteractiveMode.prototype.addCustomEntryToChat.call({ chatContainer: chat, streamingComponent: chat.children[1], toolOutputExpanded: true,
        session: { extensionRunner: { getEntryRenderer: () => () => new Text("NEW CUSTOM ENTRY", 0, 0) } } },
      { customType: "test", data: {} });
    }
    appendRequest(chat, ui, "UNPRINTED", false, false);
    tui.render(width);
    assert.ok(!tui.captureRenderState().previousLines.some((row) => row.includes("UNPRINTED")), "preparation is not a draw");
  } });
  f.draw(); f.settle();
  const rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  if (!replace) assert.ok(rows.some((row) => row.includes("NEW CUSTOM ENTRY")), "inserted native entry remains visible");
  for (const marker of ["UNPRINTED THINK", "Ran 1 shell command"]) assert.ok(rows.some((row) => row.includes(marker)), marker);
  assert.equal(rows.filter((row) => /^ ●/.test(row) && row.includes("UNPRINTED THINK")).length, 1);
  assert.equal(f.tui.fullRedraws, 1);
  assert.ok(!f.writes.some((write) => write.includes("\x1b[3J")));
});

for (const prepare of [false, true]) test(`a reload that mounts the bottom resumes an addressable projected scope with new members, prepared=${prepare}`, (t) => {
  const f = fixture(t, { history: 40, mountFooter: false });
  f.chat.children.splice(3); // one existing request, entirely in the writable tail
  f.setExpanded(true); f.draw({ pinned: false }); f.settle({ pinned: false });
  const before = f.tui.captureRenderState();
  const coordinator = f.frame().coordinator;
  appendRequest(f.chat, f.ui, "SAME", false, false);
  if (prepare) { f.tui.render(80); for (let i = 0; i < 12; i++) f.tick(); }
  f.enableBottom(); f.draw(); f.settle();
  let rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  assert.equal(rows.filter((row) => /^ ●/.test(row) && row.includes("Request 0")).length, 1);
  assert.equal(rows.filter((row) => /^ ●/.test(row) && row.includes("SAME THINKING")).length, 1);
  assert.ok(rows.some((row) => row.includes("SAME-TOOL")));
  assert.notEqual(f.frame().coordinator, coordinator);
  assert.deepEqual(f.tui.captureRenderState().previousLines.slice(0, before.previousViewportTop), before.previousLines.slice(0, before.previousViewportTop));
  appendRequest(f.chat, f.ui, "LATER", true, false); f.draw(); f.settle();
  rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  assert.ok(rows.some((row) => row.includes("LATER THINKING")));
  assert.ok(rows.some((row) => row.includes("LATER PROSE")));
  assert.equal(f.tui.fullRedraws, 2, "one cleared redraw for the session replacement");
});

test("native multi-line input and large widgets retain caret/footer and restore without history pollution", (t) => {
  const f = fixture(t);
  f.draw(); f.settle();
  f.editor.setText("INPUT marker\nsecond\nthird"); f.draw();
  f.above.addChild(new Text(Array.from({ length: 60 }, (_, i) => `widget ${i}`).join("\n"), 0, 0));
  f.pending.addChild(new Text("pending\n".repeat(30), 0, 0));
  f.draw(); f.settle();
  const crowded = f.tui.captureRenderState();
  assert.ok(crowded.previousViewportTop <= f.frame().bottom.documentHeight);
  assert.ok(!crowded.previousLines.slice(0, crowded.previousViewportTop).some((row) => /widget|pending|INPUT marker/.test(row)), "only the document may move into history");
  f.above.clear(); f.pending.clear(); f.editor.setText("INPUT marker"); f.draw();
  const rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  assert.ok(!rows.some((row) => row.includes("widget") || row.includes("pending")));
});

test("Termux height changes preserve the actual historical prefix and native input", (t) => {
  const original = process.env.TERMUX_VERSION;
  process.env.TERMUX_VERSION = "test";
  t.after(() => { if (original === undefined) delete process.env.TERMUX_VERSION; else process.env.TERMUX_VERSION = original; });
  const f = fixture(t);
  f.document.clear(); f.document.addChild(new Text("SHORT document", 0, 0));
  f.draw(); f.settle();
  const redraws = f.tui.fullRedraws;
  for (const rows of [12, 24, 4, 24]) {
    f.terminal.rows = rows; f.draw(); f.settle();
    f.editor.setText(`INPUT marker ${rows}`); f.draw();
    assert.ok(f.frame().bottom.documentHeight >= f.tui.captureRenderState().previousViewportTop);
    assert.ok(f.tui.captureRenderState().previousLines.some((line) => line.includes(`INPUT marker ${rows}`)));
    f.document.addChild(new Text(`NEW message ${rows}`, 0, 0)); f.draw();
    assert.ok(f.tui.captureRenderState().previousLines.some((line) => line.includes(`NEW message ${rows}`)));
  }
  assert.equal(f.tui.fullRedraws, redraws, "software keyboard height changes do not clear history");
});

test("one-row budget keeps the editor caret; two rows retain caret and footer", () => {
  const regions = [[], [], ["widget"], ["border", `${CURSOR_MARKER}input`, "border"], [], ["footer"]];
  assert.deepEqual(fitBottom(regions, 1, CURSOR_MARKER).flatMap((part) => part.rows), [`${CURSOR_MARKER}input`]);
  assert.deepEqual(fitBottom(regions, 2, CURSOR_MARKER).flatMap((part) => part.rows), [`${CURSOR_MARKER}input`, "footer"]);
  assert.equal(regions[3].length, 3, "native arrays unchanged");
});

test("native autocomplete and cropped widget mouse coordinates follow the final layout", async (t) => {
  const f = fixture(t);
  f.draw(); f.settle();
  f.editor.setAutocompleteProvider({ getSuggestions: () => ({ prefix: "", items: Array.from({ length: 20 }, (_, i) => ({ value: `choice-${i}`, label: `choice-${i}` })) }) });
  f.editor.tryTriggerAutocomplete();
  await f.editor.autocompleteRequestTask;
  f.draw();
  assert.ok(f.tui.captureRenderState().previousLines.some((row) => row.includes("choice-")), "native completion list remains rendered");
  f.editor.handleInput("\x1b"); f.draw();
  let clicked;
  f.above.addChild({ render: () => Array.from({ length: 40 }, (_, i) => `widget-row-${i}`), invalidate() {},
    handleMouse(event) { clicked = event.y; return { handled: true }; } });
  f.draw();
  const state = f.tui.captureRenderState();
  const index = state.previousLines.findIndex((row) => row.includes("widget-row-"));
  const expected = Number(stripTerminalSequences(state.previousLines[index]).match(/widget-row-(\d+)/)[1]);
  f.tui.handleMouse({ x: 0, y: index, width: 80, height: state.previousLines.length, kind: "press", button: "left" });
  assert.equal(clicked, expected, "root gap and cropped-prefix offsets reach the native widget");
});

test("resize, overlay and session restart retain one coherent native bottom region", (t) => {
  const f = fixture(t, { history: 24 });
  f.draw(); f.settle();
  for (const [width, height] of [[80, 40], [40, 24], [80, 24]]) {
    f.terminal.columns = width; f.terminal.rows = height;
    f.draw({ prefix: false }); f.settle();
  }
  const beforeOverlay = f.tui.fullRedraws;
  f.setExpanded(true); f.draw(); f.tick(); f.draw();
  const overlay = f.ui.showOverlay(new Text("OVERLAY", 0, 0), { width: 20, anchor: "center", nonCapturing: true });
  f.draw(); f.tick(); f.draw();
  f.editor.setText("INPUT marker overlay-edit"); f.draw();
  assert.ok(f.tui.captureRenderState().previousLines.some((row) => row.includes("overlay-edit")));
  overlay.hide(); f.draw(); f.settle();
  const coordinator = f.frame().coordinator;
  f.restart(); f.draw(); f.settle();
  assert.notEqual(f.frame().coordinator, coordinator);
  assert.equal(f.tui.fullRedraws, beforeOverlay + 2, "the held-back Ctrl+O and the restart one cleared redraw each; the overlay none");
  assert.equal(f.tui.captureRenderState().previousLines.map(stripTerminalSequences).filter((line) => line.includes("INPUT marker")).length, 1);
});

test("activation over native history replaces only the live native bottom", (t) => {
  const f = fixture(t, { history: 40, nativeFirst: true });
  assert.ok(f.nativeState.previousViewportTop > 0);
  f.draw(); f.settle();
  assert.equal(f.tui.fullRedraws, 1);
  const rows = f.tui.captureRenderState().previousLines.map(stripTerminalSequences);
  assert.equal(rows.filter((row) => row.includes("INPUT marker")).length, 1);
  assert.ok(!rows.some((row) => row.includes("NATIVE FOOTER")));
  f.chat.addChild(new Text("NEW USER AFTER ADOPTION", 0, 0)); f.draw(); f.settle();
  assert.ok(f.tui.captureRenderState().previousLines.some((row) => row.includes("NEW USER AFTER ADOPTION")));
});

test("host reload replaces its clock subscription without duplicate root preparation", async (t) => {
  const f = fixture(t, { history: 24 });
  f.draw(); f.settle();
  const coordinator = f.frame().coordinator;
  for (let index = 0; index < 3; index++) {
    const { default: replacement } = await import(`../extensions/compact-ui2tree.ts?clock-reload=${index}`);
    f.reload(replacement); f.draw(); f.settle();
    // Ctrl+O reprints the held-back document once; a reprint commits without motion, so it
    // settles before the new structure arrives.
    f.setExpanded(index % 2 === 0); f.draw(); f.settle();
    assert.notEqual(f.frame().coordinator, coordinator);
    const state = Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")];
    const render = state.render;
    const samples = new Set();
    state.render = (container, width, sample) => {
      // The draw consumes the clock sample recorded on its root frame.
      const consumed = sample ?? state.rootFrames.get(container)?.sample;
      if (container === f.tui && typeof consumed === "object") {
        assert.equal(samples.has(consumed), false, "one root preparation per shared sample");
        samples.add(consumed);
      }
      return render(container, width, sample);
    };
    try {
      appendRequest(f.chat, f.ui, `CLOCK_${index}`); f.draw(); f.settle();
      assert.ok(samples.size > 1, "new structure after reload uses multiple shared motion samples");
    } finally { state.render = render; }
  }
  assert.equal(f.tui.fullRedraws, 7, "the first paint, one cleared redraw per reload and per Ctrl+O");
  assert.equal(f.writes.filter((write) => write.includes("\x1b[3J")).length, 6);
});

test("module reload reprints the document from the new module", async (t) => {
  const f = fixture(t, { history: 40 });
  f.draw(); f.settle();
  const old = f.frame().coordinator;
  // A module from before the wrapper was recorded leaves it unset.
  delete Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")].wrapper;
  const { default: replacement } = await import("../extensions/compact-ui2tree.ts?bottom-layout-reload");
  f.reload(replacement); f.draw(); f.settle();
  assert.ok(f.frame().coordinator.readBlocks().some((block) => block.id.includes("/")), "the document still projects into child blocks");
  assert.notEqual(f.frame().coordinator, old, "the new module publishes with its own coordinator");
  f.chat.addChild(new Text("NEW USER AFTER RELOAD", 0, 0)); f.draw(); f.settle();
  assert.ok(f.tui.captureRenderState().previousLines.some((line) => line.includes("NEW USER AFTER RELOAD")));
  assert.equal(f.tui.fullRedraws, 2, "one cleared redraw for the reload");
});

for (const width of [80, 40]) test(`adopted native tail keeps same-source updates and neighboring ownership at ${width} columns`, (t) => {
  const first = new Text("OLD STATUS", 0, 0);
  const second = new Text("TAIL NEIGHBOR", 0, 0);
  const wrapper = new Container(); wrapper.addChild(first); wrapper.addChild(second);
  const f = fixture(t, { width, history: 40, requests: 1, toolNames: ["bash"], nativeFirst: true,
    beforeNative: ({ chat }) => chat.addChild(wrapper) });
  const original = f.nativeState.previousLines.map((row) => stripTerminalSequences(row).trimEnd());
  assert.ok(original.findIndex((row) => row.includes("OLD STATUS")) >= f.nativeState.previousViewportTop,
    "updated source is wholly addressable");
  f.draw(); f.settle();
  for (const text of ["NEW STATUS", "GROWN STATUS\nsecond detail\nthird detail", "FINAL STATUS"]) {
    first.setText(text); f.draw(); f.settle();
    const rows = f.tui.captureRenderState().previousLines.map((row) => stripTerminalSequences(row).trimEnd());
    for (const line of text.split("\n")) assert.equal(rows.filter((row) => row === line).length, 1, line);
    assert.ok(!rows.some((row) => row === "OLD STATUS"));
    assert.equal(rows.filter((row) => row === "TAIL NEIGHBOR").length, 1);
    assert.equal(rows.filter((row) => row.includes("Request 0")).length,
      original.filter((row) => row.includes("Request 0")).length, "preserve old semantic content once");
  }
  f.restart(); f.draw(); f.settle();
  first.setText("AFTER RELOAD"); f.draw(); f.settle();
  appendRequest(f.chat, f.ui, "FRESH", false, true); f.draw(); f.settle();
  const rows = f.tui.captureRenderState().previousLines.map((row) => stripTerminalSequences(row).trimEnd());
  for (const marker of ["AFTER RELOAD", "FRESH THINKING", "Ran 1 shell command"]) assert.ok(rows.some((row) => row.includes(marker)), marker);
  assert.equal(f.tui.fullRedraws, 2, "one cleared redraw for the session replacement");
});

for (const width of [80, 40]) test(`adopted native tail follows removal and same-text replacement at ${width} columns`, (t) => {
  const removed = new Text("SAME TEXT", 0, 0);
  const neighbor = new Text("NEIGHBOR", 0, 0);
  const wrapper = new Container(); wrapper.addChild(removed); wrapper.addChild(neighbor);
  const f = fixture(t, { width, history: 40, requests: 0, nativeFirst: true,
    beforeNative: ({ chat }) => chat.addChild(wrapper) });
  f.draw(); f.settle();
  const replacement = new Text("SAME TEXT", 0, 0);
  wrapper.children.splice(0, 1, replacement);
  f.tui.render(width); // Preparing a replacement does not itself publish it.
  replacement.setText("REPLACED TEXT"); f.draw(); f.settle();
  let rows = f.tui.captureRenderState().previousLines.map((row) => stripTerminalSequences(row).trimEnd());
  assert.equal(rows.filter((row) => row === "REPLACED TEXT").length, 1);
  assert.ok(!rows.some((row) => row === "SAME TEXT"));
  assert.ok(rows.indexOf("REPLACED TEXT") < rows.indexOf("NEIGHBOR"), "native source order follows the current tree");
  wrapper.children.splice(0, 1); f.draw(); f.settle();
  neighbor.setText("ONLY NEIGHBOR"); f.draw();
  rows = f.tui.captureRenderState().previousLines.map((row) => stripTerminalSequences(row).trimEnd());
  assert.ok(!rows.some((row) => row === "REPLACED TEXT"));
  assert.equal(rows.filter((row) => row === "ONLY NEIGHBOR").length, 1);
  assert.equal(f.tui.fullRedraws, 1);
});

for (const width of [80, 40]) test(`adopted native blocks hand later freezing to the existing coordinator at ${width} columns`, (t) => {
  const first = new Text("ADOPTED WRITABLE", 0, 0);
  const f = fixture(t, { width, history: 40, requests: 0, nativeFirst: true,
    beforeNative: ({ chat }) => chat.addChild(first) });
  f.draw(); f.settle();
  first.setText("UPDATED BEFORE FREEZE"); f.draw();
  f.chat.addChild(new Text(Array.from({ length: 30 }, (_, i) => `FOLLOWING ${i}`).join("\n"), 0, 0));
  const last = new Text("OTHER WRITABLE", 0, 0); f.chat.addChild(last);
  f.draw(); f.settle();
  const frozen = f.tui.captureRenderState();
  assert.ok(frozen.previousLines.findIndex((row) => row.includes("UPDATED BEFORE FREEZE")) < frozen.previousViewportTop);
  first.setText("INCOMPATIBLE FROZEN REPLACEMENT"); last.setText("OTHER UPDATED");
  f.draw(); f.settle();
  const rows = f.tui.captureRenderState().previousLines.map((row) => stripTerminalSequences(row).trimEnd());
  assert.equal(rows.filter((row) => row === "UPDATED BEFORE FREEZE").length, 1);
  assert.ok(!rows.some((row) => row === "INCOMPATIBLE FROZEN REPLACEMENT"));
  assert.equal(rows.filter((row) => row === "OTHER UPDATED").length, 1);
  assert.equal(f.tui.fullRedraws, 1);
});

for (const width of [80, 40]) test(`adoption keeps printed semantic rows between independently live native sources at ${width} columns`, (t) => {
  const first = new Text("INTERLEAVED START", 0, 0);
  const last = new Text("INTERLEAVED END", 0, 0);
  const f = fixture(t, { width, history: 40, requests: 1, toolNames: ["bash"], nativeFirst: true,
    beforeNative: ({ chat }) => { chat.children.splice(1, 0, first); chat.addChild(last); } });
  const native = f.nativeState.previousLines.map((row) => stripTerminalSequences(row).trimEnd());
  const start = native.indexOf("INTERLEAVED START");
  const end = native.indexOf("INTERLEAVED END");
  assert.ok(start >= f.nativeState.previousViewportTop, "both native sources and the old semantic segment remain addressable");
  const semanticRows = native.slice(start + 1, end);
  assert.ok(semanticRows.some((row) => row.includes("result")), "capture actual old tool output");
  f.draw(); f.settle();
  for (const label of ["FIRST UPDATE", "SECOND UPDATE"]) {
    first.setText(label); f.draw(); f.settle();
    const rows = f.tui.captureRenderState().previousLines.map((row) => stripTerminalSequences(row).trimEnd());
    assert.equal(rows.filter((row) => row === label).length, 1);
    assert.deepEqual(rows.slice(rows.indexOf(label) + 1, rows.indexOf("INTERLEAVED END")), semanticRows,
      "native interleaving must not replay or reformat already printed semantic history");
  }
  const replacement = new Text("REPLACEMENT BEFORE OLD TOOL", 0, 0);
  f.chat.children.splice(f.chat.children.indexOf(first), 1, replacement);
  f.tui.render(width); f.draw(); f.settle();
  let rows = f.tui.captureRenderState().previousLines.map((row) => stripTerminalSequences(row).trimEnd());
  assert.deepEqual(rows.slice(rows.indexOf("REPLACEMENT BEFORE OLD TOOL") + 1, rows.indexOf("INTERLEAVED END")), semanticRows);
  appendRequest(f.chat, f.ui, "NEW", false, false); f.draw(); f.settle();
  rows = f.tui.captureRenderState().previousLines.map((row) => stripTerminalSequences(row).trimEnd());
  for (const marker of ["NEW THINKING", "Ran 1 shell command"]) assert.ok(rows.some((row) => row.includes(marker)), marker);
  assert.deepEqual(rows.slice(rows.indexOf("REPLACEMENT BEFORE OLD TOOL") + 1, rows.indexOf("INTERLEAVED END")), semanticRows);
  assert.equal(f.tui.fullRedraws, 1);
  f.terminal.rows = 40; f.draw({ prefix: false }); f.settle();
  assert.equal(f.frame().adopted, undefined, "real geometry reset ends native-history adoption");
  rows = f.tui.captureRenderState().previousLines.map((row) => stripTerminalSequences(row).trimEnd());
  assert.ok(!rows.some((row) => row === " second line"), "ending adoption restores normal semantic classification");
  assert.ok(rows.some((row) => row.includes("NEW THINKING")));
});

test("typing in the editor after long history settles and seals updates every frame", (t) => {
  const f = fixture(t, { width: 80, history: 0, requests: 2, customEditor: true });
  for (let index = 0; index < 10; index += 1) appendRequest(f.chat, f.ui, `SEAL_${index}`);
  f.draw(); f.settle(); f.draw();
  const state = Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")];
  const caches = () => [...state.caches].map((ref) => ref.deref()).filter(Boolean);
  assert.ok(caches().some((cache) => cache.sealed !== undefined), "long history is sealed");
  f.editor.setText("");
  f.draw();
  let typed = "";
  for (const ch of ["a", "b", "c", "1", "2", "3"]) {
    typed += ch;
    f.editor.handleInput(ch);
    const rendered = f.draw();
    assert.ok(rendered.previousLines.some((row) => stripTerminalSequences(row).includes(typed)), `screen shows ${typed}`);
    assert.ok(materialize(f.frame().target.blocks).some((row) => stripTerminalSequences(row).includes(typed)), `target rows show ${typed}`);
    assert.ok(caches().some((cache) => cache.sealed !== undefined), "history stays sealed while typing");
  }
  // Same-height replacements keep the bottom layout and still show the new text.
  const directChildren = [...f.chat.children];
  f.document.clear();
  for (const child of directChildren) f.document.addChild(child);
  f.draw(); f.settle(); f.draw();
  for (const marker of ["SAME_HEIGHT_ONE", "SAME_HEIGHT_TWO", "SAME_HEIGHT_THREE"]) {
    f.editor.setText(marker);
    const rendered = f.draw();
    assert.ok(rendered.previousLines.some((row) => stripTerminalSequences(row).includes(marker)), `screen updates to ${marker}`);
    assert.ok(materialize(f.frame().target.blocks).some((row) => stripTerminalSequences(row).includes(marker)), `target rows update to ${marker}`);
  }
});

test("a steady frame reads the sealed rows only where the host materializes them", (t) => {
  // Each read of a sealed row is attributed to the innermost plugin function on
  // the stack. The fixture samples the public render(), a /debug copy; skip it.
  const reads = new Map();
  const counted = (rows) => new Proxy(rows, { get(target, key, receiver) {
    const stack = new Error().stack;
    if (typeof key === "string" && /^\d+$/.test(key) && !stack.includes("at FrameCoordinator.render ")) {
      const frame = stack.split("\n").slice(2).find((line) => line.includes("/extensions/")) ?? "outside";
      const name = frame.match(/at (?:\S+\.)?(\w+) \(/)?.[1] ?? frame.trim();
      reads.set(name, (reads.get(name) ?? 0) + 1);
    }
    return Reflect.get(target, key, receiver);
  } });
  const proposeSeal = ProjectionCache.prototype.proposeSeal;
  t.mock.method(ProjectionCache.prototype, "proposeSeal", function (...args) {
    const proposal = proposeSeal.apply(this, args);
    if (proposal) proposal.block = { ...proposal.block, rows: counted(proposal.block.rows) };
    return proposal;
  });
  const f = fixture(t, { width: 80, history: 0, requests: 2, customEditor: true });
  // Like Pi's header, a Spacer ahead of the chat renders a fresh array every frame.
  f.document.children.unshift(new Spacer(1));
  for (let index = 0; index < 10; index += 1) appendRequest(f.chat, f.ui, `STEADY_${index}`);
  f.draw(); f.settle(); f.draw();
  const state = Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")];
  const sealed = [...state.caches].map((ref) => ref.deref()?.sealed).find(Boolean);
  assert.ok(sealed, "long history is sealed");
  for (const step of [() => {}, () => f.editor.handleInput("x")]) {
    step();
    reads.clear();
    f.draw();
    const { materialize: copied, ...others } = Object.fromEntries(reads);
    assert.equal(copied, sealed.block.rows.length, "the host copy reads each sealed row once");
    // The assembler may look at the final sealed row to space new tail output.
    assert.ok(Object.values(others).reduce((sum, count) => sum + count, 0) <= 1, JSON.stringify(others));
  }
});

for (const glyph of ["", " \u0e01\u0e33"]) test(`Termux height shrink keeps a crossing block live${glyph ? " with host-normalized glyphs" : ""}`, (t) => {
  const original = process.env.TERMUX_VERSION;
  t.after(() => { if (original === undefined) delete process.env.TERMUX_VERSION; else process.env.TERMUX_VERSION = original; });
  process.env.TERMUX_VERSION = "test";
  const f = fixture(t, { width: 80, requests: 0 });
  f.terminal.rows = 14;
  const prose = (last) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text",
    text: [`line 0${glyph}`, ...Array.from({ length: 5 }, (_, i) => `line ${i + 1}`), last].join("\n") }] });
  const assistant = new AssistantMessageComponent(prose("line 6"), false);
  f.chat.addChild(assistant);
  f.draw(); f.settle();
  // The shrink puts the first prose row above the viewport; the host freezes it as printed.
  f.terminal.rows = 8;
  f.draw(); f.settle();
  assistant.updateContent(prose("line 6 TAIL_ADDED"));
  f.draw(); f.settle();
  const state = f.tui.captureRenderState();
  assert.ok(state.previousLines.map(stripTerminalSequences).some((row) => row.includes("TAIL_ADDED")), "the live tail below the frozen row is drawn");
  assert.deepEqual(f.frame().coordinator.render().owners[0].deferred ?? [], []);
});

test("normal height resize unseals static history while Termux heightReflow retains it", (t) => {
  const original = process.env.TERMUX_VERSION;
  t.after(() => { if (original === undefined) delete process.env.TERMUX_VERSION; else process.env.TERMUX_VERSION = original; });
  delete process.env.TERMUX_VERSION;
  const f = fixture(t, { width: 80, history: 0, requests: 2 });
  // U+0E33 is decomposed when the host prints it, so the printed rows differ from the sealed ones.
  for (let index = 0; index < 10; index += 1) appendRequest(f.chat, f.ui, `HEIGHT_\u0e33${index}`);
  f.draw(); f.settle(); f.draw();
  const state = Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")];
  const caches = [...state.caches].map((ref) => ref.deref()).filter(Boolean);
  assert.ok(caches.some((cache) => cache.sealed !== undefined));
  let unseals = 0;
  for (const cache of caches) {
    const orig = cache.unseal.bind(cache);
    cache.unseal = () => { if (cache.sealed) unseals += 1; return orig(); };
  }
  f.terminal.rows = 30;
  f.draw({ prefix: false }); f.settle({ prefix: false });
  assert.ok(unseals > 0, "normal height change resets geometry and unseals static history");
  // Reseal at the new height, then switch to Termux heightReflow.
  f.draw({ prefix: false }); f.settle({ prefix: false }); f.draw({ prefix: false });
  assert.ok(caches.some((cache) => cache.sealed !== undefined), "resealed after normal height change");
  unseals = 0;
  process.env.TERMUX_VERSION = "test";
  f.terminal.rows = 18;
  f.draw(); f.settle();
  assert.equal(unseals, 0, "Termux heightReflow retains static sealed history when no playback/paint is pending");
  const sealed = caches.find((cache) => cache.sealed !== undefined)?.sealed;
  assert.ok(sealed);
  assert.equal(f.frame().coordinator.readBlocks().find((block) => block.sealed)?.rows, sealed.block.rows,
    "the retained sealed block keeps its rows array, so it stays the same block");
  assert.ok(!f.frame().coordinator.render().owners[0].deferred?.some((entry) => entry.id.endsWith("/sealed")), "the sealed block is not deferred");
});
