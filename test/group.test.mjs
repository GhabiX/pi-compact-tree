import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardStatus,
  thinkingSummary,
  toTreeCard,
  toolLifecycle,
} from "../extensions/group.ts";
import { renderProcessChildren } from "./support/reference-tree.mjs";

const tool = (name, extra = {}) => ({
  toolName: name,
  args: {},
  requestStart: name === "thinking",
  result: { isError: false },
  ...extra,
});
const spacer = { kind: "spacer", render: () => [""] };
const native = (text) => ({ render: () => [text] });
const classify = (child) => child.kind === "spacer" ? "spacer" : child.toolName === "spine_spawn" ? undefined : child.toolName ? child : undefined;
const render = (children, project = classify) => renderProcessChildren(children, project, (child) => child.render(), false, 120, false);

test('native prose and spine_spawn retain source order and close the preceding run',()=>{
  for(const boundary of [native('native answer'),{...tool('spine_spawn'),...native('spawn view')}]){
    const rows=render([tool('bash',{args:{command:'FIRST'}}),boundary,tool('read',{args:{path:'LAST'}})]);
    assert.equal(rows.filter(row=>row===boundary.render()[0]).length,1);
    assert.ok(rows[0].includes('Ran 1 shell command'));assert.doesNotMatch(rows.join('\n'),/FIRST/);
    assert.ok(rows.findIndex(row=>row===boundary.render()[0])<rows.findIndex(row=>row.includes('Read(LAST)')));
  }
});
test('internal spacers do not add boundaries or duplicate native gaps',()=>{
  assert.deepEqual(render([spacer,tool('bash'),spacer,tool('read'),spacer,native('report'),spacer]),
    [' ● Ran 1 shell command, read 1 file','','report']);
});
test('each child is classified once and completed outputs are normalized once',()=>{
  const children=Array.from({length:2000},(_,i)=>tool('bash',{args:{command:`echo ${i}`},result:{isError:false,content:[{type:'text',text:'done'}]}}));
  let visits=0;const rows=render(children,c=>{visits++;return classify(c);});
  assert.equal(visits,children.length);assert.equal(rows.length,3);assert.match(rows[0],/Ran 2000 shell commands/);assert.match(rows[1],/Bash\(echo 1999\)/);
});
test('ordinary tools named notice retain their own status and preview',()=>{
  const rows=render([tool('notice',{args:{text:'ordinary'},result:{isError:true}})]);
  assert.match(rows[0],/Called Notice 1 time/);assert.match(rows[1],/Notice\(text="ordinary"\)/);
});

test("tool lifecycle markers follow queue, execution and final result order", () => {
  const card = tool("bash", { executionStarted: false, result: undefined });
  assert.equal(toolLifecycle(card), "queued");
  assert.equal(cardStatus(card), undefined);
  assert.equal(toTreeCard(card), undefined);
  assert.deepEqual(render([card]), []);
  card.executionStarted = true;
  assert.equal(toolLifecycle(card), "running");
  assert.equal(cardStatus(card), "running");
  card.result = { isError: false };
  assert.equal(toolLifecycle(card), "completed");
  card.result = { isError: true };
  assert.equal(toolLifecycle(card), "errored");
  card.isPartial = true;
  assert.equal(toolLifecycle(card), "running");

  const thinking = tool("thinking", {
    isStreaming: true,
    lastMessage: { content: [{ type: "thinking", thinking: "plan" }] },
  });
  assert.equal(toolLifecycle(thinking), "running");
  thinking.isStreaming = false;
  thinking.lastMessage = { stopReason: "toolUse", content: [{ type: "thinking", thinking: "plan" }] };
  assert.equal(toolLifecycle(thinking), "completed");
  thinking.lastMessage = { stopReason: "error", content: [{ type: "thinking", thinking: "plan" }] };
  assert.equal(toolLifecycle(thinking), "errored");
});

test("completion follows the host result and partial flag", () => {
  const card = tool("spine_open", { isPartial: true, result: { isError: false } });
  assert.equal(cardStatus(card), "running");
  card.isPartial = false;
  assert.equal(cardStatus(card), "completed");
});


test("completed thinking keeps a compact title and an expandable body", () => {
  const message = { content: [{ type: "thinking", thinking: "first line\nsecond line" }] };
  assert.equal(thinkingSummary(message), "first line second line");
  const card = tool("thinking", { lastMessage: message, args: { thinking: thinkingSummary(message) } });
  assert.equal(toTreeCard(card).args.thinking, "first line second line");
  assert.equal(toTreeCard(card).detail, "first line\nsecond line");
  const long = "full thinking summary ".repeat(15).trim();
  assert.equal(thinkingSummary({ content: [{ type: "thinking", thinking: long }] }), long);
});

test("tool outputs preserve full text, diff and inner calls, with codemode header excluded", () => {
  const result = { isError: false, content: [{ type: "text", text: "first\n" }, { type: "text", text: "second" }] };
  assert.equal(toTreeCard(tool("read", { result })).output, "first\nsecond");
  const large = "line ".repeat(5000);
  assert.equal(toTreeCard(tool("read", { result: { content: [{ type: "text", text: large }] } })).output, large);
  assert.equal(toTreeCard(tool("read", { result: { content: [] } })).output, undefined);
  const calls = [{ name: "read", args: "{}", status: "error", error: "missing" }];
  const tree = toTreeCard(tool("codemode", { result: { content: [
    { type: "text", text: "Script completed\n" }, { type: "text", text: "ACTUAL_OUTPUT" }
  ], details: { calls, diff: "+new" } } }));
  assert.equal(tree.output, "ACTUAL_OUTPUT");
  assert.deepEqual(tree.calls, calls);
  assert.equal(tree.diff, "+new");
});

test("streaming thinking keeps a short title and opens its body underneath", () => {
  const card = tool("thinking", {
    isStreaming: true,
    args: {},
    lastMessage: { content: [{ type: "thinking", thinking: "do not stream this" }] },
  });
  const tree = toTreeCard(card);
  assert.deepEqual(tree.args, {});
  assert.equal(tree.detail, "do not stream this");
  assert.equal(tree.status, "running");
});

test("Thinking preserves every block and all text beyond the tool digest limit", () => {
  const first = "START " + "plan ".repeat(1000) + " END";
  const second = "\n中文 e\u0301\n\nsecond block";
  const message = { content: [
    { type: "thinking", thinking: first }, { type: "text", text: "native prose" },
    { type: "thinking", thinking: "" }, { type: "thinking", thinking: second },
    { type: "toolCall", id: "call", name: "bash" },
  ] };
  const before = structuredClone(message);
  for (const isStreaming of [true, false]) {
    const card = toTreeCard(tool("thinking", { lastMessage: message, isStreaming }));
    assert.equal(card.detail, first + "\n\n" + second);
    assert.ok(card.detail.length > 4096);
    assert.equal(card.detail.includes("native prose"), false);
  }
  assert.deepEqual(message, before, "extracting display text never mutates the message");
});
