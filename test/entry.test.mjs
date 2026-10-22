import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Container, Text } from "@earendil-works/pi-tui";
import compactUi2Tree from "../extensions/compact-ui2tree.ts";
import { fg256, spineSuccess } from "../extensions/colors.ts";
import { piRoot } from "./pi-host.mjs";

const host = (path) => import(pathToFileURL(join(piRoot, "dist", path)).href);
const themeModule = await host("modes/interactive/theme/theme.js");
themeModule.initTheme("dark", false);

function loadPlugin() {
  const handlers = new Map();
  compactUi2Tree({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} });
  return handlers;
}

function startTui(handlers, overrides = {}) {
  let toolsExpanded = false;
  const messages = [];
  const indicators = [];
  const ui = {
    get theme() { return themeModule.theme; },
    setWorkingVisible() { assert.fail("visibility belongs to Pi"); },
    setWorkingIndicator(options) { indicators.push(options); },
    setWorkingMessage(message) { messages.push(message); },
    setEditorComponent() { assert.fail("editor belongs to Pi"); },
    setWidget() {},
    setFooter() {},
    getToolsExpanded() { return toolsExpanded; },
    ...overrides,
  };
  const ctx = { mode: "tui", ui };
  handlers.get("session_start")({}, ctx);
  return {
    ctx, messages, indicators,
    setToolsExpanded(value) { toolsExpanded = value; },
  };
}

const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function tool(name, result = "output") {
  return {
    toolName: name,
    args: { command: "printf ok" },
    expanded: false,
    isPartial: false,
    result: { isError: false, content: [{ type: "text", text: result }] },
    updateResult(value) { this.result = value; },
    setExpanded(value) { this.expanded = value; },
    render() { return ["native renderer"]; },
  };
}

test("card-local expansion does not rewrite the folded process tree", () => {
  const handlers = loadPlugin();
  const { ctx } = startTui(handlers);
  const parent = new Container();
  const card = tool("bash", "line one");
  parent.addChild(card);

  const collapsed = parent.render(80).map((line) => line.replace(ANSI_SGR, ""));
  assert.deepEqual(collapsed, [" ● Ran 1 shell command"]);
  card.setExpanded(true);
  const expanded = parent.render(80).map((line) => line.replace(ANSI_SGR, ""));
  assert.deepEqual(expanded, collapsed);
  handlers.get("session_shutdown")({}, ctx);
});

test("Ctrl+O expands complete call arguments and retained result detail", () => {
  const handlers = loadPlugin();
  const started = startTui(handlers);
  const parent = new Container();
  parent.addChild(tool("bash", "line one\nline two"));
  parent.addChild(tool("read", "last line"));
  const collapsed = parent.render(80).map((line) => line.replace(ANSI_SGR, ""));
  started.setToolsExpanded(true);
  const detailed = parent.render(80).map((line) => line.replace(ANSI_SGR, ""));
  assert.deepEqual(collapsed, [" ● Ran 1 shell command, read 1 file"]);
  assert.equal(detailed.length, 10);
  assert.equal(detailed[0], " ● Bash(printf ok)", "expansion replaces the run summary with full tool items");
  assert.match(detailed[1], /printf ok/);
  assert.match(detailed.join("\n"), /line one/);
  assert.match(detailed.join("\n"), /line two/);
  assert.match(detailed.join("\n"), /"command": "printf ok"/);
  assert.match(detailed.at(-1), /last line/);
  handlers.get("session_shutdown")({}, started.ctx);
});

test("compact long commands remain a single bounded child title", () => {
  const handlers = loadPlugin();
  const { ctx } = startTui(handlers);
  const parent = new Container();
  const command = "x".repeat(100);
  const card = tool("bash", "done");
  card.args = { command };
  parent.addChild(card);
  card.setExpanded(true);
  const rows = parent.render(24).map((line) => line.replace(ANSI_SGR, ""));
  assert.ok(rows.every((line) => line.length <= 24));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /Ran 1 shell command/);
  handlers.get("session_shutdown")({}, ctx);
});

test("multiline session output remains a native Text component", () => {
  const handlers = loadPlugin();
  const { ctx } = startTui(handlers);
  const parent = new Container();
  parent.addChild(tool("bash", "ok"));
  const report = new Text("Session Info\n\nFile: /tmp/session.jsonl\nID: abc", 1, 0);
  parent.addChild(report);
  assert.equal(parent.children[1], report);
  assert.match(parent.render(80).join("\n"), /Session Info/);
  assert.match(parent.render(80).join("\n"), /File: \/tmp\/session\.jsonl/);
  handlers.get("session_shutdown")({}, ctx);
});

test("non-TUI sessions keep native Container behavior", () => {
  const handlers = loadPlugin();
  const ui = { setWorkingVisible() {}, setWidget() {}, setFooter() {} };
  const ctx = { mode: "rpc", ui };
  handlers.get("session_start")({}, ctx);
  const parent = new Container();
  parent.addChild(tool("bash", "native output"));
  assert.deepEqual(parent.render(80), ["native renderer"]);
  handlers.get("session_shutdown")({}, ctx);
});

test("Ctrl+O input ownership remains with Pi", () => {
  const handlers = loadPlugin();
  let intercepted = false;
  const { ctx } = startTui(handlers, {
    onTerminalInput() { intercepted = true; return () => {}; },
  });
  assert.equal(intercepted, false);
  handlers.get("session_shutdown")({}, ctx);
});

test("history built before session_start is projected after reload", () => {
  const handlers = loadPlugin();
  const parent = new Container();
  const history = tool("bash", "history output");
  parent.addChild(history);
  const { ctx } = startTui(handlers);
  const rendered = parent.render(80).map((line) => line.replace(ANSI_SGR, ""));
  assert.deepEqual(rendered, [" ● Ran 1 shell command"]);
  history.setExpanded(true);
  assert.deepEqual(parent.render(80).map((line) => line.replace(ANSI_SGR, "")), rendered);
  handlers.get("session_shutdown")({}, ctx);
});

test("history rebuilt between shutdown and the next session_start is projected", () => {
  const handlers = loadPlugin();
  const first = startTui(handlers);
  handlers.get("session_shutdown")({}, first.ctx);
  const parent = new Container();
  parent.addChild(tool("bash", "reloaded history"));
  const second = startTui(handlers);
  const rendered = parent.render(80).map((line) => line.replace(ANSI_SGR, ""));
  assert.deepEqual(rendered, [" ● Ran 1 shell command"]);
  handlers.get("session_shutdown")({}, second.ctx);
});

test("native loader gets themed spans and one elapsed timer, then restores defaults", (t) => {
  let now = 0;
  const intervals = [];
  const cleared = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    intervals.push({ callback, delay });
    return intervals.length;
  });
  t.mock.method(globalThis, "clearInterval", (id) => cleared.push(id));
  const handlers = loadPlugin();
  const { ctx, messages, indicators } = startTui(handlers);
  handlers.get("agent_start")({}, ctx);
  handlers.get("agent_start")({}, ctx);
  assert.deepEqual(intervals.map(({ delay }) => delay), [1000]);
  assert.equal(indicators.at(-1).intervalMs, 25);
  assert.equal(indicators.at(-1).frames.length, 108);
  assert.ok(indicators.at(-1).frames.includes(spineSuccess(ctx.ui.theme.bold("ϒ"))));
  assert.ok(messages.at(-1).includes(spineSuccess(ctx.ui.theme.bold("Resonating"))));
  assert.ok(messages.at(-1).includes(fg256("dim", " (0s • esc to interrupt)")));
  const before = indicators.length;
  now = 160_000;
  intervals[0].callback();
  assert.match(messages.at(-1), /2m 40s/);
  assert.equal(indicators.length, before, "elapsed tick must not restart native animation");
  themeModule.initTheme("light", false);
  intervals[0].callback();
  assert.equal(indicators.length, before, "fixed indexed colors do not restart on theme changes");
  assert.ok(messages.at(-1).includes(spineSuccess(ctx.ui.theme.bold("Resonating"))));
  handlers.get("agent_settled")({}, ctx);
  assert.deepEqual(cleared, [1]);
  assert.equal(messages.at(-1), undefined);
  assert.equal(indicators.at(-1), undefined);
  handlers.get("agent_start")({}, ctx);
  assert.match(messages.at(-1), /0s/);
  handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(messages.at(-1), undefined);
  assert.equal(indicators.at(-1), undefined);
  themeModule.initTheme("dark", false);
});

test("working indicator does not claim an above-editor widget slot", () => {
  const handlers = loadPlugin();
  const order = [];
  const { ctx } = startTui(handlers, { setWidget(key) { order.push(key); } });
  ctx.ui.setWidget("spine-tree", ["• Spine Tree"]);
  handlers.get("agent_start")({}, ctx);
  assert.deepEqual(order, ["spine-tree"]);
  handlers.get("session_shutdown")({}, ctx);
});

test("cache miss Text is projected as a yellow tree notice", () => {
  const handlers = loadPlugin();
  const { ctx } = startTui(handlers);
  const parent = new Container();
  parent.addChild(new Text("\x1b[33mCache miss: 59k tokens re-billed\x1b[39m", 1, 0));
  const rendered = parent.render(80);
  assert.match(rendered.join("\n").replace(ANSI_SGR, ""), /! Cache miss: 59k tokens re-billed/);
  assert.ok(rendered.join("\n").includes(fg256("warning", "Cache miss: 59k tokens re-billed")));
  handlers.get("session_shutdown")({}, ctx);
});

for (const mode of ["rpc", "json", "print"]) {
  test(`${mode} lifecycle never invokes UI methods or creates timers`, (t) => {
    const handlers = loadPlugin();
    const ctx = { mode, ui: new Proxy({}, { get() { return () => assert.fail("non-TUI UI mutation"); } }) };
    t.mock.method(globalThis, "setInterval", () => assert.fail("non-TUI timer"));
    for (const name of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) handlers.get(name)({}, ctx);
  });
}

test("projection sees direct insertion and leaves card methods untouched", () => {
  const handlers = loadPlugin();
  const { ctx } = startTui(handlers);
  try {
    const parent = new Container();
    const card = tool("bash");
    const original = card.render;
    parent.children.splice(0, 0, card);
    assert.match(parent.render(80).join("\n"), /Ran 1 shell command/);
    assert.equal(card.render, original);
    parent.clear();
    assert.deepEqual(parent.render(80), []);
    assert.deepEqual(card.render(80), ["native renderer"]);
  } finally { handlers.get("session_shutdown")({}, ctx); }
});

test("native nested containers keep their private layout", () => {
  const handlers = loadPlugin();
  const { ctx } = startTui(handlers);
  class NativeContainer extends Container {
    render() { return ["private native layout"]; }
  }
  const parent = new Container();
  const nested = new NativeContainer();
  const nestedPlain = new Container();
  nestedPlain.addChild(tool("bash", "nested output"));
  parent.addChild(nested);
  parent.addChild(nestedPlain);
  assert.deepEqual(parent.render(80).map((line) => line.replace(ANSI_SGR, "")), [
    "private native layout",
    " ● Ran 1 shell command",
  ]);
  handlers.get("session_shutdown")({}, ctx);
});

test("objects with only a toolName remain native", () => {
  const handlers = loadPlugin();
  const { ctx } = startTui(handlers);
  const parent = new Container();
  parent.addChild({ toolName: "unrelated", render: () => ["custom view"] });
  assert.deepEqual(parent.render(80), ["custom view"]);
  handlers.get("session_shutdown")({}, ctx);
});
