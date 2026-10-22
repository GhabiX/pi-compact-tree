import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderTool, toolPreview } from "../extensions/format.ts";
import compactUi2Tree from "../extensions/compact-ui2tree.ts";
import { piRoot } from "./pi-host.mjs";

test("unknown tool arguments retain names, types, nesting and empty values", () => {
  assert.equal(toolPreview("plugin", {}), "");
  assert.equal(toolPreview("plugin", { enabled: false, count: 0, cursor: null, text: "" }), 'enabled=false count=0 cursor=null text=""');
  assert.equal(toolPreview("plugin", { items: ["a", "b"], options: { mode: "check" } }), 'items=["a", "b"] options={mode:"check"}');
  assert.equal(toolPreview("background_job", { action: "stop", name: "build" }), 'action="stop" name="build"');
  assert.notEqual(toolPreview("plugin", { action: "stop", name: "build" }), toolPreview("plugin", { action: "status", name: "build" }));
});

test("unknown arguments remain single-line terminal text at narrow and wide widths", () => {
  for (const width of [0, 1, 10, 40, 80, 120, 400]) {
    const args = { code: "中文😀\n\t".repeat(200), input: "\x1b]133;A\x07\x9b31m" };
    const line = renderTool({ toolName: "exec", args, status: "running" }, { width, expanded: false, theme: false, pulse: 0 })[0];
    assert.ok(visibleWidth(line) <= Math.max(0, width));
    assert.doesNotMatch(stripTerminalSequences(line), /[\x00-\x1f\x7f-\x9f]/u);
    assert.equal(line.isWellFormed(), true);
  }
  const escaped = toolPreview("plugin", { input: "\x1b]133;A\x07\x9b31m", "odd=key": "a b" });
  assert.doesNotMatch(escaped, /[\x00-\x1f\x7f-\x9f]/u);
  assert.match(escaped, /"odd=key"=/);
});

test("large strings and nested containers have explicit bounded previews", () => {
  for (const args of [
    { payload: "x".repeat(1_000_000) },
    { items: Array.from({ length: 1000 }, (_, n) => n) },
    { config: { a: { b: { c: "deep" } } } },
  ]) {
    const snapshot = structuredClone(args);
    const text = toolPreview("plugin", args, 60);
    assert.ok(visibleWidth(text) <= 60);
    assert.ok(text.includes("…"));
    assert.deepEqual(args, snapshot);
  }
});

test("real plugin tools retain complete call bodies through execution, updates and reload", async (t) => {
  const host = (path) => import(pathToFileURL(join(piRoot, "dist", path)).href);
  const theme = await host("modes/interactive/theme/theme.js");
  const { ToolExecutionComponent } = await host("modes/interactive/components/tool-execution.js");
  theme.initTheme("dark", false);
  const handlers = new Map();
  let expanded = false;
  const ctx = { mode: "tui", ui: {
    get theme() { return theme.theme; }, getToolsExpanded() { return expanded; },
    setWorkingIndicator() {}, setWorkingMessage() {}, setWidget() {}, setFooter() {},
  } };
  const start = () => {
    compactUi2Tree({ registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
    handlers.get("session_start")({}, ctx);
  };
  const stop = () => handlers.get("session_shutdown")({}, ctx);
  start();
  t.after(stop);
  for (const [name, args] of [
    ["exec", { code: "await tools.read({path: 'a.ts'})" }],
    ["background_job", { action: "stop", name: "build" }],
    ["custom_plugin", { target: "main", dryRun: false }],
  ]) {
    const definition = { name, label: name, description: "test plugin", parameters: {} };
    const tool = new ToolExecutionComponent(name, name, args, {}, definition, { requestRender() {} }, process.cwd());
    const chat = new Container();
    chat.addChild(tool);
    // This is a live call: the agent remains unsettled until the test's reload.
    handlers.get("agent_start")({}, ctx);
    handlers.get("tool_execution_start")({ toolCallId: name }, ctx);
    tool.markExecutionStarted();
    const check = () => {
      for (const width of [40, 80, 120]) {
        const lines = chat.render(width).map(stripTerminalSequences);
        if (expanded) {
          const body = lines.slice(1).map(line => line.slice(6)).join("").replace(/\s/gu, "");
          assert.ok(body.includes(JSON.stringify(args).replace(/\s/gu, "")), lines.join("\n"));
        } else {
          assert.ok(lines.filter(line => /⎿  (Exec|Background Job|Custom Plugin)\(/.test(line)).length <= 1);
          assert.match(lines.join("\n"), /●/);
          assert.ok(lines.length <= 4, "one summary, one child, at most two running result rows");
        }
        assert.equal(lines.filter(line => line.includes("●")).length, 1);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
      }
      assert.deepEqual(tool.args, args);
    };
    check();
    tool.updateResult({ content: [{ type: "text", text: "progress" }] }, true);
    check();
    tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
    check();
    expanded = true;
    check();
    stop(); start(); check();
  }
});
