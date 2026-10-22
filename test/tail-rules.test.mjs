import assert from "node:assert/strict";
import { test } from "node:test";
import { attachMotionScheduler, stopMotion } from "../extensions/motion.ts";
import { motionMs } from "../extensions/snapshot.ts";
import { HostRowsCache, HostRowsCoordinator } from "./host-rows.mjs";

const card = (toolName, args = {}, extra = {}) => ({
  toolName,
  args,
  result: { isError: false, content: [{ type: "text", text: "result" }] },
  updateResult(value) { this.result = value; },
  setExpanded() {},
  render() { return [`native ${toolName}`]; },
  ...extra,
});

const thinking = (text, extra = {}) => card("thinking", { thinking: text }, {
  lastMessage: { content: [{ type: "thinking", thinking: text }], stopReason: "toolUse" },
  ...extra,
});

const native = (text) => ({ render: () => [text] });

function projectionOptions(agentSettled) {
  return {
    classify: component => component.toolName ? component : undefined,
    renderNative: component => component.render(),
    theme: false,
    expanded: false,
    styleEpoch: 0,
    confirmPaint: true,
    agentSettled,
  };
}

function acknowledge(cache, result) {
  for (const block of result.blocks ?? []) {
    for (const paint of block.paint ?? []) cache.acknowledge(paint.id, paint.text);
  }
}

test("a terminal run stays on its last preview until the agent settles, then folds; cold history is folded", t => {
  let now = 0;
  attachMotionScheduler(() => {}, { now: () => now, setInterval: () => 1, clearInterval() {} });
  t.after(() => stopMotion());
  const live = [
    card("bash", { command: "first" }, { playbackSource: true, playbackEnded: true }),
    card("bash", { command: "last" }, { playbackSource: true, playbackEnded: true }),
  ];
  const running = new HostRowsCache();
  const preview = running.prepare(live, 80, projectionOptions(false));
  assert.match(preview.rows.join("\n"), /Bash\(last\)/, "the last terminal call remains previewed while the source is open");
  assert.match(preview.rows[0], /Ran 2 shell commands/);
  running.dispose();

  const settled = new HostRowsCache();
  const options = projectionOptions(true);
  let folded;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    folded = settled.prepare(live, 80, options);
    acknowledge(settled, folded);
    if (folded.rows.length === 1) break;
    now += 1_000;
    settled.invalidate();
  }
  assert.deepEqual(folded.rows, [" ● Ran 2 shell commands"], "settled source folds its final run");
  settled.dispose();

  const cold = new HostRowsCache();
  const history = cold.prepare(live.map(source => ({ ...source, playbackSource: false })), 80, projectionOptions(false));
  assert.deepEqual(history.rows, [" ● Ran 2 shell commands"], "history is never left on a current-call preview");
  cold.dispose();
});

for (const [name, source] of [
  ["Thinking", thinking("old thought", { playbackSource: true, playbackEnded: true })],
  ["edit", card("edit", { path: "old.ts", oldText: "a", newText: "b" }, { playbackSource: true, playbackEnded: true })],
  ["write", card("write", { path: "old.ts", content: "new" }, { playbackSource: true, playbackEnded: true })],
  ["run", card("bash", { command: "old" }, { playbackSource: true, playbackEnded: true })],
]) {
  test(`${name} that has not started enters final form when a newer item waits`, t => {
    let now = 0;
    attachMotionScheduler(() => {}, { now: () => now, setInterval: () => 1, clearInterval() {} });
    t.after(() => stopMotion());
    const cache = new HostRowsCache();
    const result = cache.prepare([source, native("NEWER_ITEM")], 80, projectionOptions(false));
    assert.ok([...cache.gate.settled.keys()].some(id => id.endsWith("#final")), "admission is recorded as final");
    assert.ok(result.blocks.every(block => !block.playback), "final admission has no playback block");
    cache.dispose();
  });
}

test("an item that already started keeps playing after a successor arrives", t => {
  let now = 0;
  attachMotionScheduler(() => {}, { now: () => now, setInterval: () => 1, clearInterval() {} });
  t.after(() => stopMotion());
  const source = thinking("started body", { playbackSource: true, playbackEnded: false });
  const children = [source];
  const cache = new HostRowsCache();
  cache.prepare(children, 80, projectionOptions(false));
  assert.ok([...cache.gate.settled.keys()].some(id => id.endsWith("#play")), "started source is admitted to play");
  children.push(native("NEWER_ITEM"));
  source.playbackEnded = true;
  cache.invalidate();
  cache.prepare(children, 80, projectionOptions(false));
  assert.equal([...cache.gate.settled.keys()].some(id => id.endsWith("#final")), false, "a started source is never reclassified as final");
  cache.dispose();
});

test("a passage grows one entering block at a time", () => {
  const coordinator = new HostRowsCoordinator();
  coordinator.register({ blocks: [], structureKey: "initial" });
  coordinator.publish();
  const target = [
    { id: "thinking", kind: "structure", rows: ["thinking"], shape: "thinking", enters: true },
    { id: "write", kind: "structure", rows: ["write"], shape: "write", enters: true },
  ];
  coordinator.stage({ blocks: target, structureKey: "target" }, 0);
  coordinator.publish();
  const pending = coordinator.render().owners[0];
  assert.ok(pending.blocks[1].startedAt >= pending.blocks[0].deadlineAt, "the second block starts after the first settles");
  const middle = coordinator.advanceTo(pending.blocks[0].deadlineAt - 1)[0];
  assert.equal(middle.blocks[1].rows.length, 0, "only one block is growing at a time");
});

for (const kind of ["Thinking", "Write"]) {
  for (const count of [1, 4, 12, 30]) {
    test(`${kind} backlog ${count} keeps the passage within the bounded motion window`, () => {
      const coordinator = new HostRowsCoordinator();
      coordinator.register({ blocks: [], structureKey: "initial" });
      coordinator.publish();
      const blocks = Array.from({ length: count }, (_, index) => ({
        id: `${kind.toLowerCase()}-${index}`,
        kind: "structure",
        rows: [`${kind}-${index}`],
        shape: kind,
        enters: true,
      }));
      coordinator.stage({ blocks, structureKey: kind }, 0);
      coordinator.publish();
      const pending = coordinator.render().owners[0];
      const first = pending.blocks[0].startedAt;
      const last = pending.blocks.at(-1);
      assert.ok(last.deadlineAt - first <= motionMs(count), `${kind} N=${count} exceeds one passage window`);
      assert.ok(last.deadlineAt - first <= 2_400, `${kind} N=${count} exceeds the 2400ms cap`);
    });
  }
}

// A run member keeps the admission it was given first. The first call is admitted to play and its paint is
// not yet received when two newer calls arrive in the same frame: it stays the open call, the middle call
// goes straight into the summary and never plays, and only the newest call plays after it.
test("run admissions are first-writer-wins: a started call keeps playing, a skipped call never plays", t => {
  let now = 0;
  attachMotionScheduler(() => {}, { now: () => now, setInterval: () => 1, clearInterval() {} });
  t.after(() => stopMotion());
  const calls = ["a", "b", "c"].map(command => card("bash", { command }, { playbackSource: true, playbackEnded: false }));
  const cache = new HostRowsCache(), options = projectionOptions(false);
  const open = rows => ["a", "b", "c"].filter(command => rows.some(row => row.includes(`Bash(${command})`)));
  assert.deepEqual(open(cache.prepare(calls.slice(0, 1), 80, options).rows), ["a"], "the first call is admitted to play");
  for (const call of calls) call.playbackEnded = true;
  const children = [...calls, native("DONE")];
  const opened = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = cache.prepare(children, 80, options);
    opened.push(open(result.rows));
    acknowledge(cache, result);
    now += 1_000;
    cache.invalidate();
  }
  assert.deepEqual(opened[0], ["a"], "the started call stays open when newer calls arrive");
  assert.ok(opened.every(rows => !rows.includes("b")), "the call skipped under a newer one never plays");
  assert.ok(opened.some(rows => rows.includes("c")), "the newest call plays");
  assert.match(cache.prepare(children, 80, options).rows.join("\n"), /Ran 3 shell commands/);
  cache.dispose();
});
