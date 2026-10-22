import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import compactUi2Tree from "../extensions/compact-ui2tree.ts";

import { piRoot } from "./pi-host.mjs";
import { renderProcessChildren } from "./support/reference-tree.mjs";

const host = (path) => import(pathToFileURL(join(piRoot, "dist", path)).href);
const theme = await host("modes/interactive/theme/theme.js");
const { AssistantMessageComponent } = await host("modes/interactive/components/assistant-message.js");
const { UserMessageComponent } = await host("modes/interactive/components/user-message.js");
const { ToolExecutionComponent } = await host("modes/interactive/components/tool-execution.js");
theme.initTheme("dark", false);

const message = (content) => ({ role: "assistant", stopReason: "stop", content });
const prose = (text) => ({ type: "text", text });
const thinking = { type: "thinking", thinking: "private plan" };
const rows = (component, width) => component.render(width).map(stripTerminalSequences);
function boot(t) {
  let expanded = false;
  const handlers = new Map();
  const ctx = { mode: "tui", ui: {
    get theme() { return theme.theme; },
    getToolsExpanded() { return expanded; },
    setWorkingIndicator() {}, setWorkingMessage() {}, setWidget() {}, setFooter() {},
  } };
  const start = () => {
    compactUi2Tree({ registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
    handlers.get("session_start")({}, ctx);
  };
  const stop = () => handlers.get("session_shutdown")({}, ctx);
  start();
  t.after(stop);
  return { expand() { expanded = true; }, reload() { stop(); start(); }, ctx };
}

test("user-to-assistant boundary keeps one unpainted native spacer at every width", (t) => {
  const session = boot(t);
  for (const width of [40, 80, 120]) {
    for (const content of [[prose("Visible reply")], [thinking, prose("Visible reply")]]) {
      const chat = new Container();
      const user = new UserMessageComponent("Please continue");
      const assistant = new AssistantMessageComponent(message(content));
      chat.addChild(user);
      chat.addChild(assistant);
      const check = () => {
        const raw = chat.render(width).slice(user.render(width).length);
        assert.equal(stripTerminalSequences(raw[0]), "");
        // OSC133 zone markers are native metadata; the spacer must have no SGR background.
        assert.doesNotMatch(raw[0], /\x1b\[[0-9;]*m/u);
        const plain = raw.map(stripTerminalSequences);
        const reply = plain.findIndex(row => row.includes("Visible reply"));
        assert.ok(reply >= 1);
        assert.equal(plain[reply - 1], "", "native prose keeps one unpainted separator");
        assert.equal(plain.filter(row => row.includes("Visible reply")).length, 1);
        assert.equal(plain.filter(row => row.includes("private plan")).length, content.includes(thinking) ? 1 : 0);

      };
      check();
      check();
      assistant.setHideThinkingBlock(false);
      check();
      session.reload();
      check();
    }
  }
});

test("empty streaming assistants reserve no height and first prose gains one spacer", (t) => {
  boot(t);
  const assistant = new AssistantMessageComponent();
  for (const content of [[], [prose("   ")]]) {
    assistant.updateContent(message(content), true);
    assert.deepEqual(rows(assistant, 40), []);
  }
  for (const text of ["First", "First reply", "First reply\n\nSecond paragraph"]) {
    assistant.updateContent(message([prose(text)]), true);
    const rendered = rows(assistant, 40);
    assert.equal(rendered.findIndex((row) => row.trim()), 1);
    assert.ok(rendered.at(-1).trim());
  }
  assistant.updateContent(message([prose("First"), thinking, prose("Second"), thinking]), false);
  assert.deepEqual(rows(assistant, 40).map((row) => row.trim()), ["", "First", "", "Second"]);
});

test("native user messages after the process tree keep one unpainted separator", (t) => {
  const session = boot(t);
  const chat = new Container();
  chat.addChild(new UserMessageComponent("Before"));
  const tool = new ToolExecutionComponent("bash", "one", { command: "printf one" }, {}, undefined, { requestRender() {} }, process.cwd());
  tool.markExecutionStarted();
  tool.updateResult({ isError: false, content: [{ type: "text", text: "done" }] });
  chat.addChild(tool);
  chat.addChild(new UserMessageComponent("After"));
  const check = (width) => {
    const raw = chat.render(width);
    const after = raw.findIndex((row) => stripTerminalSequences(row).includes("After"));
    assert.ok(after > 1);
    assert.match(raw[after - 1], /\x1b\[[0-9;]*m/u, "user box top padding stays painted");
    assert.equal(stripTerminalSequences(raw[after - 2]), "");
    assert.match(raw.at(-1), /\x1b\[[0-9;]*m/u, "user box bottom padding stays painted");
    assert.equal(stripTerminalSequences(raw.at(-1)).includes("After"), false);
  };
  for (const width of [40, 80, 120]) check(width);
  session.reload();
  check(80);
});

test("process boundaries keep one separator with prose, expansion and rerender", (t) => {
  const session = boot(t);
  const chat = new Container();
  chat.addChild(new AssistantMessageComponent(message([prose("Before")])));
  for (const id of ["one", "two"]) {
    const tool = new ToolExecutionComponent("bash", id, { command: `printf ${id}` }, {}, undefined, { requestRender() {} }, process.cwd());
    tool.updateResult({ isError: false, content: [{ type: "text", text: `result ${id}` }] });
    chat.addChild(tool);
  }
  chat.addChild(new AssistantMessageComponent(message([prose("After")])));
  const check = () => {
    for (const width of [40, 80, 120]) {
      const raw = chat.render(width);
      const uncached = renderProcessChildren(
        chat.children,
        (child) => child instanceof ToolExecutionComponent ? child : undefined,
        (child) => child.render(width),
        theme.theme,
        width,
        session.ctx.ui.getToolsExpanded(),
      );
      assert.deepEqual(raw, uncached);
      const nativeZones = chat.children
        .filter((child) => child instanceof AssistantMessageComponent)
        .flatMap((child) => child.render(width).join("").match(/\x1b\]133;[ABC]\x07/gu) ?? []);
      assert.deepEqual(raw.join("").match(/\x1b\]133;[ABC]\x07/gu), nativeZones);
      const rendered = raw.map(stripTerminalSequences);
      const before = rendered.findIndex((row) => row.includes("Before"));
      const firstTool = rendered.findIndex((row) => /● (Ran|Bash)/.test(row));
      const after = rendered.findIndex((row) => row.includes("After"));
      assert.equal(firstTool - before, 2);
      assert.equal(rendered[after - 1].trim(), "");
      assert.ok(rendered[after - 2].trim());
      const processRows = rendered.slice(firstTool, after - 1);
      assert.equal(processRows.some((row, i) => !row.trim() && !processRows[i + 1]?.trim()), false, "one separator between expanded items");
    }
  };
  check();
  check();
  session.expand();
  check();
  session.reload();
  check();
});
