import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@earendil-works/pi-tui";

/** The host answers each clock request with a frame. Tests drive paints explicitly,
 * so a request is modelled as a render pull: it prepares roots but is never a receipt. */
function pullRoots() {
  for (const ref of Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")]?.roots ?? []) {
    const frame = ref.deref(), root = frame?.container.deref();
    if (frame && root) root.render(frame.width);
  }
}
import { addressableBlockTail, allowsFrozenBlockChange, frozenBlockConstraint, preservesFrozenPrefix } from "../extensions/anchor.ts";
import { HostRowsCoordinator, rowOwners } from "./host-rows.mjs";
import compactUi2Tree from "../extensions/compact-ui2tree.ts";

const scope = (rows, shape = "open", id = "scope") => ({ id, kind: "structure", rows, shape });
const nativeBlock = (id, rows) => ({ id, kind: "native", rows, shape: "native" });

function publishChange(previous, target, viewportTop = 0) {
  const coordinator = new HostRowsCoordinator();
  coordinator.register({ blocks: previous });
  coordinator.publish();
  coordinator.observeBoundary(viewportTop);
  coordinator.stage({ blocks: target }, 100);
  coordinator.publish();
  return coordinator.commit()[0];
}

test("an addressable block shrink releases its old height", () => {
  const result = publishChange([scope(["A", "B", "C", "D"])], [scope(["A", "X"], "closed")]);
  assert.deepEqual(result.rows, ["A", "X"]);
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(publishChange([], [scope(["only"])]).rows, ["only"]);
});

test("root blocks retain conflicting frozen bytes and later history offsets", () => {
  const history = nativeBlock("history", ["h0", "h1", "h2", "h3"]);
  const successor = nativeBlock("next", ["later", "tail"]);
  for (const [oldRows, newRows, boundary] of [
    [["A", "B", "C"], ["X"], 5],
    [["A"], ["A", "B"], 6],
    [["A", "B", "C"], ["X", "Y", "Z"], 6],
    [["A", "B", "C", "D"], ["A"], 6],
  ]) {
    const original = [history, scope(oldRows), successor];
    const result = publishChange(original, [history, scope(newRows, "changed"), successor], boundary);
    assert.deepEqual(result.rows, original.flatMap((block) => block.rows));
    assert.ok(result.deferred.some((entry) => entry.id === "scope"));
    assert.deepEqual(result.rows.slice(0, boundary), original.flatMap((block) => block.rows).slice(0, boundary));
  }
});

test("a matching frozen prefix allows natural growth and shrink of its addressable tail", () => {
  const successor = nativeBlock("next", ["later"]);
  for (const [oldRows, newRows] of [
    [["A", "B"], ["A", "B", "C"]],
    [["A", "B", "C", "D"], ["A", "B", "X"]],
  ]) {
    const result = publishChange([scope(oldRows), successor], [scope(newRows, "changed"), successor], 2);
    assert.deepEqual(result.rows, [...newRows, "later"], "a writable tail needs no historical span padding");
    assert.deepEqual(result.rows.slice(0, 2), ["A", "B"]);
    assert.deepEqual(result.deferred, []);
  }
});

test("a folded root block releases height before its native successor", () => {
  const successor = nativeBlock("next", ["", "later"]);
  const result = publishChange([scope(["old-1", "old-2", "old-3", "old-4"]), successor], [scope(["summary"], "closed"), successor]);
  assert.deepEqual(result.rows, ["summary", "", "later"]);
  assert.deepEqual(rowOwners(result), ["scope", "next", "next"]);
});

test("root block growth retains its new tail without a top pad", () => {
  const result = publishChange([scope(["A"])], [scope(["A", "B", "C"], "expanded")]);
  assert.deepEqual(result.rows, ["A", "B", "C"]);
  assert.deepEqual(rowOwners(result), ["scope", "scope", "scope"]);
});

test("replacing an addressable block leaves its successor in target order", () => {
  const successor = nativeBlock("next", ["", "later"]);
  const result = publishChange([scope(["A", "B", "C"]), successor], [scope(["Z"], "new", "replacement"), successor]);
  assert.deepEqual(result.rows, ["Z", "", "later"]);
  assert.deepEqual(result.blocks.map((block) => block.id), ["replacement", "next"]);
  assert.equal(result.rows.indexOf("later"), 2);
});

test("block constraints freeze crossing and offscreen owners without freezing visible successors", () => {
  const old = [{ id: "history", rows: ["h0", "h1", "h2"] }, { id: "crossing", rows: ["c0", "c1", "c2"] }, { id: "visible", rows: ["v0"] }];
  const sameOrder = old.map((block) => ({ ...block, rows: ["target"] }));
  assert.deepEqual([...frozenBlockConstraint(old, sameOrder, 3).pinned], ["history"]);
  const crossed = frozenBlockConstraint(old, sameOrder, 4);
  assert.deepEqual([...crossed.pinned], ["history", "crossing"]);
  assert.equal(crossed.topologyCompatible, true);
  assert.equal(frozenBlockConstraint(old, [{ id: "new", rows: ["n"] }, ...sameOrder], 4).topologyCompatible, false);
  assert.equal(frozenBlockConstraint(old, [old[0], old[1], { id: "new", rows: ["n"] }, old[2]], 4).topologyCompatible, true);
  assert.equal(frozenBlockConstraint(old, [old[2], old[0], old[1]], 0).topologyCompatible, true);
});

test("an unchanged frozen prefix requires a surviving addressable tail", () => {
  const history = { id: "history", rows: ["h0", "h1"] };
  const tail = { id: "tail", rows: ["t0", "t1"] };
  const old = [history, tail];
  const retained = addressableBlockTail(old, [history], 2);
  assert.equal(retained.retained, "tail");
  assert.deepEqual(retained.blocks, old);
  assert.deepEqual(addressableBlockTail(old, [history, { ...tail, rows: [] }], 2).blocks, old);
  assert.equal(addressableBlockTail(old, [history, { ...tail, rows: ["new"] }], 2).retained, undefined);
  assert.equal(addressableBlockTail(old, [], 0).retained, undefined);
  assert.deepEqual(old, [history, tail], "pure constraint does not mutate prior blocks");
});

test("a frozen split merges only the independently owned target suffix", () => {
  const history = { id: "history", rows: ["h0", "h1"] };
  const oldScope = { id: "old", kind: "structure", sources: ["request1", "request2"], rows: ["t0", "t1", "t2"] };
  const footer = { id: "footer", kind: "native", rows: ["footer"] };
  const user = { id: "new-user", kind: "native", rows: ["NEW USER"] };
  const thinking = { id: "new-scope", kind: "structure", sources: ["request3"], rows: ["NEW THINKING"] };
  const split = [history, { ...oldScope, sources: ["request1"], rows: ["summary1"] },
    { id: "prose", kind: "native", sources: ["request2"], rows: ["prose"] },
    { id: "split", kind: "structure", sources: ["request2"], rows: ["summary2"] }, user, thinking, footer];
  for (const viewportTop of [3, 6]) {
    const result = frozenBlockConstraint([history, oldScope, footer], split, viewportTop);
    assert.equal(result.topologyCompatible, false, "same pinned IDs alone do not exclude duplicate represented Thinking");
    assert.deepEqual(result.order, viewportTop === 3
      ? ["history", "old", "new-user", "new-scope", "footer"]
      : ["history", "old", "footer", "new-user", "new-scope"]);
  }
});

test("a drawn block that shares a source with a frozen one keeps its place", () => {
  // A Thinking card scrolled into history; its prose, from the same message, is still drawn below the boundary.
  const history = { id: "history", rows: ["h0", "h1", "h2"] };
  const thinking = { id: "thinking", kind: "structure", sources: ["message"], rows: ["T0", "T1"] };
  const prose = { id: "prose", kind: "native", sources: ["message"], rows: ["p0", "p1"] };
  const edit = { id: "edit", kind: "structure", sources: ["edit"], rows: ["e0"] };
  const result = frozenBlockConstraint([history, thinking, prose, edit], [history, thinking, prose, edit], 4);
  assert.equal(result.topologyCompatible, true);
  assert.deepEqual(result.order, ["history", "thinking", "prose", "edit"]);
  // Identity decides, not painted rows: prose that was still at zero rows in the last frame keeps its place as it grows.
  const pending = { ...prose, rows: [] };
  assert.deepEqual(frozenBlockConstraint([history, thinking, pending, edit], [history, thinking, prose, edit], 4),
    { pinned: new Set(["history", "thinking"]), topologyCompatible: true, order: ["history", "thinking", "prose", "edit"] });
  // A new block with that source is a piece of the frozen card drawn again: it still breaks the topology.
  assert.equal(frozenBlockConstraint([history, thinking, prose], [history, thinking, prose, { id: "again", kind: "structure", sources: ["message"], rows: ["T"] }], 4).topologyCompatible, false);
});

test("frozen prefix comparison preserves terminal bytes and rejects shortened history", () => {
  const rows = ["\x1b[31mred\x1b[0m", "same", "tail"];
  assert.equal(preservesFrozenPrefix(rows, [rows[0], "same", "new tail"], 2), true);
  assert.equal(preservesFrozenPrefix(rows, ["red", "same", "tail"], 1), false);
  assert.equal(preservesFrozenPrefix(rows, [rows[0]], 2), false);
  assert.equal(preservesFrozenPrefix(rows, [], 0), true);
});

test("partial block compatibility depends on frozen bytes and later history offsets", () => {
  const old = ["", "\x1b[31mfixed\x1b[0m", "old body", "old tail"];
  assert.equal(allowsFrozenBlockChange(old, ["", "new request", "new tool"], 1), true);
  assert.equal(allowsFrozenBlockChange(old, ["", old[1], "summary"], 2), true);
  assert.equal(allowsFrozenBlockChange(old, ["", "fixed", "summary"], 2), false, "ANSI bytes remain frozen");
  assert.equal(allowsFrozenBlockChange(old, [""], 2), false, "cannot truncate the protected prefix");
  assert.equal(allowsFrozenBlockChange(old, [...old, "new input"], 4), true, "append begins exactly at the boundary");
  assert.equal(allowsFrozenBlockChange(old, [...old, "new input"], 5), false, "append would displace a later frozen owner");
  assert.equal(allowsFrozenBlockChange(old, [...old], 5), true);
});

test("tail protection retains a crossing block at its existing position", () => {
  const history = { id: "history", rows: ["history"] };
  const crossing = { id: "crossing", rows: ["fixed", "visible"] };
  const zeroHeight = { id: "footer", rows: [] };
  const old = [history, crossing, zeroHeight];
  const target = [history, { ...crossing, rows: ["fixed"] }, zeroHeight];
  const result = addressableBlockTail(old, target, 2);
  assert.equal(result.retained, "crossing");
  assert.deepEqual(result.blocks, old);
  assert.deepEqual(target[1].rows, ["fixed"], "constraint does not mutate its candidate");
});

test("regular root keeps Pi input and mouse layout native", (t) => {
  const handlers = new Map();
  compactUi2Tree({ registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
  handlers.get("session_start")({}, { mode: "tui", ui: { setFooter() {}, setWorkingIndicator() {}, setWorkingMessage() {}, setWidget() {} } });
  t.after(() => handlers.get("session_shutdown")({}, { mode: "tui", ui: { setWorkingMessage() {}, setWorkingIndicator() {} } }));
  const hit = { render: () => ["editor"], handleMouse: () => ({ handled: true }) };
  const root = new Container();
  root.mode = "regular";
  root.addChild({ render: () => ["history"] });
  root.addChild(hit);
  assert.deepEqual(root.render(40), ["history", "editor"]);
  assert.equal(root.mouseLayout.children.length, 2);
  assert.equal(root.mouseLayout.children[1].component, hit);
  assert.equal(root.handleMouse({ type: "click", button: "left", x: 0, y: 1, screenX: 0, screenY: 1, width: 40, height: 2 }).handled, true);
});

test("nested native containers keep Pi's mouse layout for each child frame", (t) => {
  const handlers = new Map();
  compactUi2Tree({ registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
  handlers.get("session_start")({}, { mode: "tui", ui: { setFooter() {}, setWorkingIndicator() {}, setWorkingMessage() {}, setWidget() {} } });
  t.after(() => handlers.get("session_shutdown")({}, { mode: "tui", ui: { setWorkingMessage() {}, setWorkingIndicator() {} } }));
  const clicks = [];
  const hit = (name, rows) => ({ render: () => rows, handleMouse: (event) => { clicks.push([name, event.y, event.height]); return { handled: true }; } });
  const header = hit("header", ["h"]);
  const chat = new Container();
  chat.addChild(hit("a", ["a0"]));
  chat.addChild(hit("b", ["b0", "b1"]));
  const document = new Container();
  document.addChild(header);
  document.addChild(chat);
  const root = new Container();
  root.mode = "regular";
  root.addChild(document);
  root.addChild(hit("editor", ["editor"]));
  assert.deepEqual(root.render(40), ["h", "a0", "b0", "b1", "editor"]);
  assert.deepEqual(document.mouseLayout, { width: 40, children: [{ component: header, height: 1 }, { component: chat, height: 3 }] });
  assert.deepEqual(chat.mouseLayout.children.map((entry) => entry.height), [1, 2]);
  assert.equal(root.handleMouse({ type: "click", button: "left", x: 0, y: 3, screenX: 0, screenY: 3, width: 40, height: 5 }).handled, true);
  assert.deepEqual(clicks, [["b", 1, 2]], "the event reaches the chat child under the pointer");
});

test("regular mode folds a process block in place under the header", (t) => {
  let now = 0;
  const timers = new Map();
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', callback => { const id = {}; timers.set(id, callback); return id; });
  t.mock.method(globalThis, 'clearInterval', id => timers.delete(id));
  const handlers = new Map();
  compactUi2Tree({ registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
  let factory;
  const ctx = {
    mode: "tui",
    model: undefined,
    thinkingLevel: "off",
    getContextUsage: () => undefined,
    sessionManager: {
      getBranch: () => [],
      getCwd: () => "/",
      getSessionName: () => undefined,
    },
    ui: {
      theme: undefined,
      getToolsExpanded: () => false,
      onTerminalInput: () => () => {},
      setEditorComponent() {},
      setWorkingIndicator() {},
      setWorkingMessage() {},
      setWidget() {},
      setFooter(next) { factory = next; },
    },
  };
  handlers.get("session_start")({}, ctx);
  const tui = {
    mode: "regular",
    previousViewportTop: 0,
    terminal: { rows: 40 },
    requestRender: pullRoots,
  };
  const footer = factory(tui, {}, { onBranchChange: () => () => {} });
  t.after(() => {
    footer.dispose();
    handlers.get("session_shutdown")({}, ctx);
  });

  const bash = {
    toolName: "bash",
    args: { command: "printf ok" },
    executionStarted: true,
    isPartial: true,
    result: { isError: false, content: [{ type: "text", text: "line-one\nline-two" }] },
    setExpanded() {},
    updateArgs(args) { this.args = args; },
    updateResult(value) { this.result = value; this.isPartial = false; },
  };
  const root = new Container();
  const header = new Container();
  header.addChild({ render: () => ["h1", "h2"] });
  const chat = new Container();
  chat.addChild(bash);
  chat.addChild({ render: () => ["later"] });
  root.addChild(header);
  root.addChild(chat);

  const draw = () => {
    root.render(80);
    for (let i = 0; i < 200; i++) {
      now += 25;
      for (const callback of [...timers.values()]) callback();
      root.render(80);
    }
    return root.render(80);
  };
  const opened = draw();
  assert.deepEqual(opened.map(row => row.trim()), ['h1', 'h2', '● Ran 1 shell command', '⎿  Bash(printf ok)', 'line-one', 'line-two']);
  assert.equal(opened.includes("later"), false, "native successors wait for a running run to settle");
  tui.previousViewportTop = 3;
  bash.updateArgs({ command: "printf UPDATED_OPEN" });
  const updated = draw();
  assert.deepEqual(updated.slice(0, 3), opened.slice(0, 3), "the frozen header and summary stay byte-identical");
  assert.match(updated[3], /UPDATED_OPEN/, "the addressable current call still updates");

  // Once the preview itself is frozen, the compact endpoint cannot rewrite it.
  tui.previousViewportTop = 4;
  bash.updateResult({ isError: false, content: [{ type: "text", text: "line-one\\nline-two" }] });
  const frozen = draw();
  assert.deepEqual(frozen.slice(0, 4), updated.slice(0, 4));
  assert.ok(frozen.includes("later"), "a deferred endpoint still releases the native successor");
  tui.previousViewportTop = 0;
  tui.terminal.rows = 50;
  const resized = draw();
  assert.deepEqual(resized, ["h1", "h2", " ● Ran 1 shell command", "", "later"]);
  assert.doesNotMatch(resized.join("\\n"), /line-one|UPDATED_OPEN/);
});
