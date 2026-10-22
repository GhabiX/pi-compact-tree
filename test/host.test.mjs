import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Container, Text, TuiMainScreen, stripTerminalSequences } from "@earendil-works/pi-tui";

/** The host answers each clock request with a frame. Tests drive paints explicitly,
 * so a request is modelled as a render pull: it prepares roots but is never a receipt. */
function pullRoots() {
  for (const ref of Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")]?.roots ?? []) {
    const frame = ref.deref(), root = frame?.container.deref();
    if (frame && root) root.render(frame.width);
  }
}
import compactUi2Tree from "../extensions/compact-ui2tree.ts";
import { fg256 } from "../extensions/colors.ts";

import { armMotion, clearMotion, MOTION_TICK_MS } from "../extensions/motion.ts";
import { piRoot } from "./pi-host.mjs";
import { renderProcessChildren } from "./support/reference-tree.mjs";

const host = (path) => import(pathToFileURL(join(piRoot, "dist", path)).href);
const themeModule = await host("modes/interactive/theme/theme.js");
const { initTheme } = themeModule;
const { AssistantMessageComponent } = await host("modes/interactive/components/assistant-message.js");
const { ToolExecutionComponent } = await host("modes/interactive/components/tool-execution.js");
const { BashExecutionComponent } = await host("modes/interactive/components/bash-execution.js");
initTheme("dark", false);
const plain = (component) => component.render(80).map(stripTerminalSequences).join("\n");
function boot(t, mode = "tui", ui = {}) {
  const handlers = new Map();
  compactUi2Tree({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} });
  const ctx = { mode, ui: { get theme() { return themeModule.theme; }, setEditorComponent() { assert.fail("editor belongs to Pi"); }, onTerminalInput() { return () => {}; }, setWorkingIndicator() {}, setWorkingMessage() {}, setWidget() {}, setFooter() {}, ...ui } };
  handlers.get("session_start")({}, ctx);
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  return { handlers, ctx, live(message) { handlers.get("message_update")({ message }, ctx); return message; },
    liveTool(tool) { handlers.get("tool_execution_start")({ toolCallId: tool.toolCallId }, ctx); return tool; } };
}
function nativeTool(text = "result", definition = undefined) {
  const tool = new ToolExecutionComponent("bash", "call-1", { command: "printf ok" }, {}, definition, { requestRender() {} }, process.cwd());
  tool.updateResult({ isError: false, content: [{ type: "text", text }] });
  return tool;
}
test('reload preserves card methods and one Container wrapper while current terminal result keeps its bounded preview',async t=>{
  const first=boot(t),chat=new Container(),tool=nativeTool('persisted output'),render=tool.render;
  chat.addChild(tool);const containerRender=Container.prototype.render;
  first.handlers.get('session_shutdown')({},first.ctx);
  const next=(await import(`../extensions/compact-ui2tree.ts?reload=${Date.now()}`)).default,handlers=new Map();
  next({on(name,handler){handlers.set(name,handler);},registerCommand(){}});handlers.get('session_start')({},first.ctx);
  t.after(()=>handlers.get('session_shutdown')({},first.ctx));
  assert.equal(Container.prototype.render,containerRender);assert.equal(tool.render,render);
  const rows=plain(chat);assert.match(rows,/Ran 1 shell command/);assert.doesNotMatch(rows,/Bash\(printf ok\)|persisted output/);
  tool.setExpanded(true);assert.equal(plain(chat),rows);
});
test('sequential native tools admit only execution starts and keep the same run',t=>{
  const h=boot(t),chat=new Container();
  const tools=['one','two'].map(id=>new ToolExecutionComponent('bash',id,{command:`COMMAND_${id}`},{},undefined,{requestRender(){}},process.cwd()));
  tools.forEach(c=>chat.addChild(c));assert.equal(plain(chat),'');
  h.liveTool(tools[0]);tools[0].markExecutionStarted();assert.match(plain(chat),/COMMAND_one/);assert.doesNotMatch(plain(chat),/COMMAND_two/);
  tools[0].updateResult({isError:false,content:[]});h.liveTool(tools[1]);tools[1].markExecutionStarted();const rows=plain(chat);
  assert.match(rows,/Ran 2 shell commands/);assert.equal(rows.split('\n').filter(row=>/^ ● Ran 2 shell commands$/.test(row)).length,1);
  assert.doesNotMatch(rows,/COMMAND_one/);assert.match(rows,/Bash\(COMMAND_two\)/);
});
test('cache warnings remain separate visible items and expand every source independently',t=>{
  let expanded=false;boot(t,'tui',{getToolsExpanded:()=>expanded});const chat=new Container();
  chat.addChild(new AssistantMessageComponent(thinkingMessage,true));chat.addChild(nativeTool());
  for(const tokens of [45,55,62])chat.addChild(new Text(`\x1b[33mCache miss: ${tokens}k tokens re-billed\x1b[39m`,1,0));
  chat.addChild(new Text('answer',0,0));const compact=plain(chat);
  assert.equal((compact.match(/! Cache miss:/g)??[]).length,3);assert.match(compact,/Ran 1 shell command/);
  expanded=true;const rows=plain(chat);assert.equal((rows.match(/! Cache miss:/g)??[]).length,3);
  for(const tokens of [45,55,62])assert.match(rows,new RegExp(`${tokens}k tokens re-billed`));
  expanded=false;assert.equal(plain(chat),compact);
});
test("native fallback prepares a leaf once regardless of container depth", (t) => {
  boot(t);
  for (let depth = 1; depth <= 5; depth += 1) {
    let calls = 0;
    let child = { render() { calls += 1; return ["native leaf"]; }, invalidate() {} };
    for (let level = 0; level < depth; level += 1) {
      const parent = new Container();
      parent.addChild(child);
      child = parent;
    }
    assert.equal(plain(child), "native leaf");
    assert.equal(calls, 1, `native depth ${depth} must delegate exactly once`);
  }
});
const thinkingMessage = { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "consider the result" }] };

test("provider errors from tool-call turns stay inside the process tree", (t) => {
  boot(t);
  const chat = new Container();
  chat.addChild(new AssistantMessageComponent({
    role: "assistant",
    stopReason: "error",
    errorMessage: "Codex error: overloaded",
    content: [{ type: "toolCall", name: "bash", arguments: { command: "pwd" } }],
  }, true));
  const rendered = plain(chat);
  assert.match(rendered, /● Error: Codex error: overloaded/);
  assert.doesNotMatch(rendered, /^Error: Codex error: overloaded/m);
});

test("a tool-call turn with prose keeps the prose native and its provider error in the process tree", (t) => {
  boot(t);
  const chat = new Container();
  chat.addChild(new AssistantMessageComponent({
    role: "assistant",
    stopReason: "error",
    errorMessage: "Codex error: overloaded",
    content: [{ type: "text", text: "PROSE before the call" }, { type: "toolCall", name: "bash", arguments: { command: "pwd" } }],
  }, true));
  const rendered = plain(chat);
  assert.match(rendered, /PROSE before the call/);
  assert.match(rendered, /● Error: Codex error: overloaded/);
  assert.ok(rendered.indexOf("PROSE before the call") < rendered.indexOf("Error: Codex error"), "prose keeps its source position");
});

test("unstarted tools stay hidden without an assistant and pre-execution errors remain visible", (t) => {
  boot(t);
  const chat = new Container();
  const tool = new ToolExecutionComponent("write", "write-1", { path: "worklog.md" }, {}, undefined, { requestRender() {} }, process.cwd());
  chat.addChild(tool);
  assert.equal(plain(chat), "");
  const report = new Text("native report", 0, 0);
  chat.addChild(report);
  assert.equal(plain(chat), plain(report));
  // The host finalizes pending tools when argument generation errors/aborts.
  tool.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true });
  assert.match(plain(chat), /● Write\(/);
  assert.match(plain(chat), /worklog.md/);
  assert.match(plain(chat), /native report/);
});

test("real thinking-led tree remains folded after native expansion", (t) => {
  boot(t);
  const chat = new Container();
  chat.addChild(new AssistantMessageComponent(thinkingMessage, true));
  const oldTool = nativeTool("old deep result");
  const tool = nativeTool("deep result");
  chat.addChild(oldTool);
  chat.addChild(tool);
  const folded = plain(chat);
  assert.doesNotMatch(folded, /old deep result/);
  assert.doesNotMatch(folded, /⎿  Bash\(printf ok\)/);
  assert.doesNotMatch(folded, /deep result/);
  assert.match(folded, /Ran 2 shell commands/);
  for (const child of chat.children) child.setExpanded?.(true);
  assert.equal(plain(chat), folded);
});

test("thinking stays in the compact tree and provider errors become tree rows", (t) => {
  boot(t);
  const chat = new Container();
  const assistant = new AssistantMessageComponent(thinkingMessage, true);
  chat.addChild(assistant);
  assistant.updateContent({ ...thinkingMessage, stopReason: "error", errorMessage: "provider failed" });
  assert.match(plain(chat), /● Error: provider failed/);
  assert.doesNotMatch(plain(chat), /^ Error: provider failed/m);
  assistant.updateContent(thinkingMessage);
  assistant.setHideThinkingBlock(false);
  assert.doesNotMatch(plain(chat), /Thinking/);
  assert.match(plain(chat), /consider the result/);
  assistant.updateContent({ ...thinkingMessage, stopReason: "error", errorMessage: "provider failed" });
  assert.match(plain(chat), /● Error: provider failed/);
});

test("assistant prose and the following tree have one separator row", (t) => {
  boot(t);
  const chat = new Container();
  chat.addChild(new AssistantMessageComponent({
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "private plan" },
      { type: "text", text: "visible explanation" },
    ],
  }, false));
  chat.addChild(nativeTool("tool result"));
  const rows = plain(chat).split("\n");
  assert.equal(rows.some((row, index) => row.trim() === "" && rows[index + 1]?.trim() === ""), false);
  assert.doesNotMatch(plain(chat), /Thinking\.\.\./);
  assert.match(plain(chat), /private plan/);
  assert.match(plain(chat), /Ran 1 shell command/);
});

test("manual bash commands join the folded tree", (t) => {
  boot(t);
  const chat = new Container();
  const bash = new BashExecutionComponent("printf manual", { requestRender() {} });
  bash.appendOutput("line one\nline two");
  bash.setComplete(0, false);
  chat.addChild(bash);
  const folded = plain(chat);
  assert.doesNotMatch(folded, /line one/);
  bash.setExpanded(true);
  assert.equal(plain(chat), folded);
});

test("real cache miss Text joins the tree as a yellow notice", (t) => {
  boot(t);
  const chat = new Container();
  chat.addChild(new Text("\x1b[33mCache miss: 59k tokens re-billed\x1b[39m", 1, 0));
  assert.match(plain(chat), /! Cache miss: 59k tokens re-billed/);
  assert.ok(chat.render(80).join("\n").includes(fg256("warning", "Cache miss: 59k tokens re-billed")));
});

test("manual bash failures and truncation keep Pi's native diagnostics", (t) => {
  boot(t);
  const chat = new Container();
  const failed = new BashExecutionComponent("sh -c 'exit 7'", { requestRender() {} });
  failed.appendOutput("failed output");
  failed.setComplete(7, false);
  const cancelled = new BashExecutionComponent("sleep 10", { requestRender() {} });
  cancelled.setComplete(undefined, true);
  const truncated = new BashExecutionComponent("generate", { requestRender() {} });
  truncated.appendOutput("partial output");
  truncated.setComplete(0, false, { truncated: true }, "/tmp/full-output.log");
  chat.addChild(failed);
  chat.addChild(cancelled);
  chat.addChild(truncated);
  const collapsed = plain(chat);
  assert.match(collapsed, /exit 7/);
  assert.match(collapsed, /cancelled/);
  assert.match(collapsed, /Output truncated\. Full output: \/tmp\/full-output\.log/);
});

test("shutdown makes existing wrapped components render natively", (t) => {
  const { handlers, ctx } = boot(t);
  const chat = new Container();
  const tool = nativeTool("native result");
  chat.addChild(tool);
  handlers.get("session_shutdown")({}, ctx);
  assert.match(plain(chat), /native result/);
});

test("hidden thinking length stops preserve Pi's truncation warning", (t) => {
  boot(t);
  const chat = new Container();
  chat.addChild(new AssistantMessageComponent({ ...thinkingMessage, stopReason: "length" }, true));
  assert.match(plain(chat), /truncated before completion/);
});

test("native working loader stops at agent_end and stays absent during a retry gap", async (t) => {
  const { InteractiveMode } = await host("modes/interactive/interactive-mode.js");
  const { CustomEditor } = await host("modes/interactive/components/custom-editor.js");
  const { KeybindingsManager } = await host("core/keybindings.js");
  const timers = new Map();
  let nextId = 0;
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (id) => timers.delete(id));
  const tui = { terminal: { rows: 24 }, requestRender() {}, getClearOnShrink: () => false };
  const editor = new CustomEditor(tui, themeModule.getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
  // Use the installed host's event handler, UI API and loader with inert I/O.
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    isInitialized: true,
    runtimeHost: { session: { thinkingLevel: "high", settingsManager: { getShowTerminalProgress: () => false } } },
    footer: { invalidate() {} },
    ui: tui,
    defaultEditor: editor,
    editor,
    pendingTools: new Map(),
    statusContainer: new Container(),
    workingVisible: true,
    defaultWorkingMessage: "Working",
    options: { tuiMode: "regular" },
    programStatus: { handleEvent() {}, report() {} },
  });
  const handlers = new Map();
  compactUi2Tree({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} });
  const ctx = { mode: "tui", ui: { ...mode.createExtensionUIContext(), setFooter() {} } };
  t.after(() => {
    mode.clearStatusIndicator();
    handlers.get("session_shutdown")({}, ctx);
  });
  handlers.get("session_start")({}, ctx);
  handlers.get("agent_start")({}, ctx);
  await mode.handleEvent({ type: "agent_start" });
  await mode.handleEvent({ type: "turn_start" });
  const firstLoader = mode.activeStatusIndicator;
  assert.equal(firstLoader.kind, "working");
  assert.match(plain(editor), /Resonating/);
  const elapsedTick = [...timers.values()].find(({ delay }) => delay === 1000).callback;
  assert.equal(timers.size, 2, "one native animation plus one elapsed timer");

  await mode.handleEvent({ type: "agent_end" });
  assert.equal(firstLoader.intervalId, null);
  assert.equal(mode.activeStatusIndicator, undefined);
  assert.doesNotMatch(plain(editor), /Resonating/);
  elapsedTick();
  assert.equal(mode.activeStatusIndicator, undefined, "elapsed updates cannot resurrect the loader");
  assert.equal(timers.size, 1);

  await mode.handleEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000 });
  const retryLoader = mode.activeStatusIndicator;
  elapsedTick();
  assert.equal(retryLoader.kind, "retry");
  assert.match(plain(editor), /Retrying/);
  assert.doesNotMatch(plain(editor), /Resonating/);
  handlers.get("agent_start")({}, ctx);
  await mode.handleEvent({ type: "agent_start" });
  await mode.handleEvent({ type: "turn_start" });
  assert.equal(retryLoader.intervalId, null);
  assert.equal(mode.activeStatusIndicator.kind, "working");
  assert.match(plain(editor), /Resonating/);

  await mode.handleEvent({ type: "agent_end" });
  handlers.get("agent_settled")({}, ctx);
  await mode.handleEvent({ type: "agent_settled" });
  assert.equal(timers.size, 0);
  assert.equal(mode.workingMessage, undefined);
  assert.equal(mode.workingIndicatorOptions, undefined);
  assert.doesNotMatch(plain(editor), /Resonating/);
});

test("session scheduler requests one render per tick and stops when nothing is armed", (t) => {
  const timers = new Map();
  let nextId = 0;
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback: () => { now += delay; callback(); }, delay });
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (id) => timers.delete(id));
  let renders = 0;
  const tui = { mode: "regular", terminal: { rows: 24 }, previousViewportTop: 0, requestRender() { renders += 1; } };
  const { handlers, ctx } = boot(t, "tui", {
    setFooter(factory) { factory(tui, themeModule.theme, {}); },
  });
  assert.equal(MOTION_TICK_MS, 25);
  assert.equal(timers.size, 0);
  const first = {};
  const second = {};
  armMotion(first);
  armMotion(second);
  armMotion(first);
  const motion = [...timers.values()].filter((timer) => timer.delay === MOTION_TICK_MS);
  assert.equal(motion.length, 1);
  motion[0].callback();
  motion[0].callback();
  assert.equal(renders, 2);
  clearMotion(first);
  motion[0].callback();
  assert.equal(renders, 3);
  clearMotion(second);
  assert.equal([...timers.values()].some((timer) => timer.delay === MOTION_TICK_MS), false);
  motion[0].callback();
  assert.equal(renders, 3);
  armMotion(first);
  handlers.get("session_shutdown")({}, ctx);
  assert.equal([...timers.values()].some((timer) => timer.delay === MOTION_TICK_MS), false);
  armMotion(second);
  assert.equal(timers.size, 0);
});

test("non-TUI sessions do not create a motion timer", (t) => {
  t.mock.method(globalThis, "setInterval", () => assert.fail("non-TUI timer"));
  for (const mode of ["rpc", "json", "print"]) boot(t, mode);
});

test("a scrolled fallback viewport admits a new Thinking structure", (t) => {
  const { tui, motion } = motionHarness(t);
  const chat = new Container();
  chat.addChild(new Text("history one\nhistory two\nhistory three", 0, 0));
  plain(chat);
  tui.previousViewportTop = 2;
  const assistant = new AssistantMessageComponent(undefined, true);
  assistant.updateContent({
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "thinking", thinking: "\u5b9a\u7a3f" }],
    streaming: true,
  }, true);
  chat.addChild(assistant);
  assert.doesNotMatch(plain(chat).split('\n').filter(row=>!/^  [├└]/.test(row)).join('\n'), /\u5b9a/);
  assert.equal(motion().length, 1);
  motion()[0].callback(100);
  assert.equal(rootFrameOf(chat).coordinator.hasPending, true, "the newly admitted scope starts its expansion");
  motion()[0].callback(400);
  const titled = plain(chat);
  assert.doesNotMatch(titled, /Thinking/);
  assert.match(titled, /\u5b9a\u7a3f/);
  assert.equal(titled.split('\n').filter(row=>row.includes('\u5b9a\u7a3f')).length,1,'source preview is confined to its summary; no body is fabricated');
});

function motionHarness(t, ui = {}, actualHost = false) {
  const timers = new Map();
  let nextId = 0;
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback: (elapsed = delay) => { now += elapsed; callback(); }, delay });
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (id) => timers.delete(id));
  const writes = [];
  const terminal = { columns: 80, rows: 24, write(value) { writes.push(value); }, hideCursor() {}, showCursor() {}, start() {}, stop() {} };
  const tui = actualHost ? new TuiMainScreen(terminal, false)
    : { mode: "regular", terminal, previousViewportTop: 0, requestRender: pullRoots };
  if (actualHost) {
    tui.setClearOnShrink(false);
    tui.requestRender = pullRoots;
    t.after(() => tui.stop());
  }
  const session = boot(t, "tui", { setFooter(factory) { factory(tui, themeModule.theme, {}); }, ...ui });
  const motion = () => [...timers.values()].filter((timer) => timer.delay === MOTION_TICK_MS);
  return { ...session, tui, motion, writes, now: () => now, elapse: (elapsed) => { now += elapsed; } };
}

/** Fake-host fallback: service admissions, natural text pace and structure; no paint receipts. */
function settle(motion, chat) {
  plain(chat);
  for (let tick = 0; tick < 2_000 && motion().length; tick += 1) motion()[0].callback();
  assert.equal(motion().length, 0, "motion must settle within its bounded replay budget");
  return plain(chat);
}

function settledWrite(path = "worklog.md") {
  const tool = new ToolExecutionComponent("write", `write-${path}`, { path }, {}, undefined, { requestRender() {} }, process.cwd());
  tool.setArgsComplete();
  tool.markExecutionStarted();
  tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
  return tool;
}

const rootFrameOf = (container) => Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")].rootFrames.get(container);

const mixedThought = { type: "thinking", thinking: "Inspect the request carefully." };
const mixedProse = { type: "text", text: "Visible explanation." };
const mixedToolCall = { type: "toolCall", id: "bash-one", name: "bash", arguments: { command: "echo ok" } };
const mixedMessage = (content, stopReason = "toolUse") => ({
  role: "assistant", content, stopReason,
  ...(stopReason === "error" ? { errorMessage: "recorded provider failure" } : {}),
});

function readMixed(root, width = 80) {
  const rows = root.render(width);
  const coordinator = rootFrameOf(root).coordinator;
  const revision = coordinator.currentRootRevision;
  assert.deepEqual(root.render(width), rows, "an unchanged mixed message has stable rows");
  assert.equal(coordinator.currentRootRevision, revision, "repeated mixed-message reads cannot publish");
  return rows.map(stripTerminalSequences).join("\n");
}

function settleMixed(motion, root, width = 80) {
  readMixed(root, width);
  for (let tick = 0; motion().length && tick < 2_000; tick += 1) {
    motion()[0].callback();
    readMixed(root, width);
  }
  assert.equal(motion().length, 0, "mixed messages must release the motion timer");
  return readMixed(root, width);
}

test("prose and tools without source Thinking never fabricate it", (t) => {
  const { motion } = motionHarness(t);
  for (const content of [[mixedProse], [mixedProse, mixedToolCall], [{ ...mixedThought, thinking: "   " }, mixedProse]]) {
    const chat = new Container();
    chat.addChild(new AssistantMessageComponent(mixedMessage(content), true));
    assert.doesNotMatch(settleMixed(motion, chat), /Thinking/);
  }
});

test("mixed abort and length keep native diagnostics and one prose copy", (t) => {
  boot(t);
  for (const reason of ["length", "aborted"]) {
    const chat = new Container();
    chat.addChild(new AssistantMessageComponent(mixedMessage([mixedThought, mixedProse], reason), true));
    const rendered = readMixed(chat);
    assert.equal((rendered.match(/Visible explanation\./g) ?? []).length, 1);
    assert.match(rendered, reason === "length" ? /truncated before completion/ : /Operation aborted/);
  }
});

test("replacement and resize prepare the new component once at the new width", (t) => {
  boot(t);
  const make = (command) => {
    const tool = new ToolExecutionComponent("bash", command, { command }, {}, undefined, { requestRender() {} }, process.cwd());
    tool.markExecutionStarted();
    return tool;
  };
  const chat = new Container();
  chat.addChild(make("OLD command with a much longer line than twelve columns"));
  assert.match(plain(chat), /OLD/);
  chat.children[0] = make("NEW target");
  const narrow = chat.render(12).map(stripTerminalSequences);
  assert.ok(narrow.every((row) => row.length <= 12));
  assert.doesNotMatch(narrow.join("\n"), /OLD/);
  const revision = rootFrameOf(chat).coordinator.currentRootRevision;
  assert.deepEqual(chat.render(12).map(stripTerminalSequences), narrow);
  assert.equal(rootFrameOf(chat).coordinator.currentRootRevision, revision);
});

test("Ctrl+O animates by row count without changing geometry", (t) => {
  let expanded = false;
  const { motion } = motionHarness(t, { getToolsExpanded: () => expanded });
  const chat = new Container();
  chat.addChild(new Text("user", 0, 0));
  chat.addChild(new AssistantMessageComponent(thinkingMessage, true));
  chat.addChild(settledWrite("detail.md"));
  chat.addChild(new Text("next", 0, 0));
  const folded = settle(motion, chat);
  assert.match(folded, /Write\(detail.md\)/);
  const coordinator = rootFrameOf(chat).coordinator;
  let geometryChanges = 0;
  const original = coordinator.onGeometryChange.bind(coordinator);
  coordinator.onGeometryChange = () => { geometryChanges++; return original(); };
  for (const value of [true, false]) {
    expanded = value;
    const before = coordinator.render().rows;
    assert.deepEqual(chat.render(80), before);
    assert.equal(coordinator.hasPending, true);
    const pending = coordinator.readBlocks().filter(b => b.deadlineAt !== undefined);
    assert.ok(pending.length > 0);
    for (const b of pending) {
      const duration = b.deadlineAt - b.startedAt;
      assert.equal(duration % 150, 0);
      assert.ok(duration >= 150 && duration <= 2400);
      assert.equal(b.startedAt % 150, 0);
    }
    const after = settle(motion, chat);
    assert.equal(coordinator.hasPending, false);
    assert.equal(geometryChanges, 0);
    if (value) assert.match(after, /done/);
    else assert.equal(after, folded);
  }
});

function threeRequestScope(tui) {
  const chat = new Container();
  chat.addChild(new Text("FIRST USER", 0, 0));
  for (let request = 0; request < 3; request += 1) {
    chat.addChild(new AssistantMessageComponent({ ...thinkingMessage, content: [
      { type: "thinking", thinking: `Consider request ${request + 1} carefully.` },
    ] }, true));
    for (const name of ["bash", "read"]) {
      const args = name === "bash" ? { command: `printf request-${request + 1}` } : { path: `source-${request + 1}.md` };
      const tool = new ToolExecutionComponent(name, `${name}-${request}`, args, {}, undefined, tui, process.cwd());
      tool.setArgsComplete();
      tool.markExecutionStarted();
      tool.updateResult({ content: [{ type: "text", text: `result ${request + 1} ${name}\nsecond result row` }], isError: false });
      chat.addChild(tool);
    }
  }
  return chat;
}

test("only session replacements end the root publication with one cleared redraw request", (t) => {
  const { tui, motion, handlers, ctx } = motionHarness(t, {}, true);
  const chat = threeRequestScope(tui);
  tui.addChild(chat);
  tui.addChild(new Text(Array.from({ length: 24 }, (_, i) => `footer ${i}`).join("\n"), 0, 0));
  const pull = tui.requestRender;
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    settle(motion, tui);
    tui.renderNow();
    assert.ok(tui.captureRenderState().previousViewportTop > 0);
    const previousCoordinator = rootFrameOf(tui).coordinator;
    const forced = [];
    tui.requestRender = (force) => { forced.push(force === true); pull(); };
    handlers.get("session_shutdown")({}, ctx);
    assert.equal(motion().length, 0);
    handlers.get("session_start")({ reason }, ctx);
    tui.requestRender = pull;
    assert.equal(rootFrameOf(tui)?.coordinator === previousCoordinator, false, `${reason}: no publication outlives the session`);
    assert.deepEqual(forced.filter(Boolean), reason === "startup" ? [] : [true], reason);
    tui.renderNow(reason !== "startup");
  }
  settle(motion, tui);
  assert.equal(motion().length, 0);
});

// Pi writes rows normalized (Thai/Lao AM decomposed); the live tail must still be
// recognized in that form, or it is frozen into the adopted history.
for (const [legacyCoordinator, glyphs] of [[false, ""], [true, ""], [false, " กำ"]]) {
  test(`first activation adopts actual Pi native history and admits new tail input, legacy=${legacyCoordinator}${glyphs ? ", glyphs" : ""}`, (t) => {
    const { tui, motion, writes, handlers, ctx } = motionHarness(t, {}, true);
    handlers.get("session_shutdown")({}, ctx);
    const chat = new Container();
    chat.addChild(new Text("NATIVE USER", 0, 0));
    for (let index = 0; index < 12; index += 1) {
      const tool = new ToolExecutionComponent("bash", `adopt-${index}`, { command: `printf adopt-${index}` }, {}, undefined, tui, process.cwd());
      tool.setArgsComplete();
      tool.markExecutionStarted();
      tool.updateResult({ content: [{ type: "text", text: `old result ${index}${glyphs}\nsecond row\nthird row` }], isError: false });
      chat.addChild(tool);
    }
    tui.addChild(chat);
    const footer = new Text(`LIVE FOOTER${glyphs}`, 0, 0);
    tui.addChild(footer);
    tui.renderNow();
    const before = tui.captureRenderState();
    assert.ok(before.previousViewportTop > 100);
    if (legacyCoordinator) {
      const state = Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")];
      const old = { container: new WeakRef(tui), coordinator: { dispose() {} } };
      state.rootFrames.set(tui, old);
      state.roots.add(new WeakRef(old));
    }
    handlers.get("session_start")({}, ctx);
    tui.renderNow();
    assert.deepEqual(tui.captureRenderState().previousLines, before.previousLines,
      "activation retains actual normalized text; it does not redraw a new compact history");
    assert.ok(rootFrameOf(tui).adopted);
    chat.addChild(new Text("NEW USER AFTER ADOPTION", 0, 0));
    chat.addChild(new AssistantMessageComponent({ ...thinkingMessage,
      content: [{ type: "thinking", thinking: "FRESH THINKING AFTER ADOPTION" }] }, true));
    footer.setText("UPDATED LIVE FOOTER");
    tui.renderNow();
    let previous = tui.captureRenderState();
    for (let tick = 0; motion().length && tick < 200; tick += 1) {
      motion()[0].callback();
      tui.renderNow();
      const current = tui.captureRenderState();
      assert.deepEqual(current.previousLines.slice(0, previous.previousViewportTop),
        previous.previousLines.slice(0, previous.previousViewportTop));
      previous = current;
    }
    assert.match(plain(tui), /NEW USER AFTER ADOPTION/);
    assert.match(plain(tui), /FRESH THINKING AFTER ADOPTION/);
    assert.match(plain(tui), /UPDATED LIVE FOOTER/);
    assert.equal(tui.fullRedraws, 1);
    assert.equal(writes.some((chunk) => chunk.includes("\x1b[3J")), false);
    assert.equal(motion().length, 0);
    tui.renderNow(true);
    assert.equal(rootFrameOf(tui).adopted, undefined, "a host reset permits rebuilding compact history");
  });
}
