import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameCoordinator, motionMs, TICK_MS, restEnd } from "../extensions/snapshot.ts";
import { HostRowsCoordinator } from "./host-rows.mjs";

test('Baroque motion and rest durations follow the shared sixteenth and beat grid', () => {
  assert.equal(TICK_MS, 150);
  for (const [rows, ms] of [[0,150],[1,150],[2,300],[8,1200],[16,2400],[17,2400],[100,2400]]) assert.equal(motionMs(rows), ms);
  for (const [at, end] of [[0,600],[1,600],[599,600],[600,1200],[601,1200]]) assert.equal(restEnd(at), end);
});

for (const [from, to] of [[1,2],[2,1],[9,1],[1,9],[30,1],[1,30]]) {
  test(`height ${from} to ${to} moves monotonically on a quantized row-count deadline`, () => {
    const c = localFrame([tree('scope', from)]);
    const target = tree('scope', to, 'target');
    const pending = stageLocal(c, [target], 175);
    const block = pending.blocks[0];
    const start = 300, duration = motionMs(Math.abs(from - to));
    assert.equal(block.startedAt, start);
    assert.equal(block.deadlineAt, start + duration);
    assert.deepEqual(pending.rows, tree('scope', from).rows);
    assert.equal(c.advanceTo(start), undefined);
    let height = from;
    for (let at = start + 25; at <= start + duration; at += 25) {
      const frame = c.advanceTo(at)[0], b = frame.blocks[0];
      assert.equal(b.rows.length, Math.ceil(from + (to - from) * Math.min(1,(at - start) / duration)));
      assert.ok(to > from ? b.rows.length >= height : b.rows.length <= height);
      height = b.rows.length;
    }
    assert.deepEqual(c.render().rows, target.rows);
    assert.equal(c.hasPending, false);
    assert.equal(c.advanceTo(start + duration + 25), undefined);
  });
}

test('paced playback grows immediately and its fold withholds settle receipts until stable', () => {
  const c = localFrame([native('header',['header']), native('footer',['footer'])]);
  const live = { ...tree('thinking', 6), playback: true, paint: [{id:'flow',text:'prefix',from:0,to:6}] };
  const playing = stageLocal(c, [native('header',['header']),live,native('footer',['footer'])],125);
  assert.deepEqual(playing.blocks[1].rows, live.rows);
  assert.equal(c.hasPending,false);
  const target = {...tree('thinking',1,'folded'), playback:false, paint:[{id:'settle:flow',text:'settled',from:0,to:1,settled:true}]};
  const folded = stageLocal(c,[native('header',['header']),target,native('footer',['footer'])],200);
  assert.equal(folded.blocks[1].startedAt,300);
  assert.equal(folded.blocks[1].deadlineAt,1050);
  assert.ok(!c.advanceTo(675)[0].blocks[1].paint.some(p=>p.settled),'old flow metadata cannot claim the new settled endpoint');
  const final=c.advanceTo(1050)[0].blocks[1];
  assert.equal(final.phase,'stable');
  assert.deepEqual(final.paint,target.paint);
});

test('settled receipt metadata changes publish independently and public copies remain isolated', () => {
  const c=localFrame([tree('scope',1)]);
  const target={...tree('scope',1),paint:[{id:'settle:a',text:'settled',from:0,to:1,settled:true}]};
  const first=stageLocal(c,[target],0);
  assert.equal(first.blocks[0].paint[0].settled,true);
  first.blocks[0].paint[0].settled=false;
  assert.equal(c.readBlocks()[0].paint[0].settled,true);
  const next={...target,paint:[{...target.paint[0],id:'settle:b'}]};
  assert.equal(stageLocal(c,[next],25).blocks[0].paint[0].id,'settle:b');
});

test('same-height content changes publish directly; every height change moves even with the same shape', () => {
  const c=localFrame([structure('scope',['title','body'])]);
  assert.deepEqual(stageLocal(c,[structure('scope',['title','updated'])],0).rows,['title','updated']);
  assert.equal(c.hasPending,false);
  const pending=stageLocal(c,[structure('scope',['title','updated','more'])],25);
  assert.equal(pending.blocks[0].deadlineAt,300);
  assert.equal(c.hasPending,true);
  assert.deepEqual(c.advanceTo(300)[0].rows,['title','updated','more']);
});

test('same-height target rebase retains progress; a height retarget starts from the current rows', () => {
  const c=localFrame([tree('scope',9)]);
  stageLocal(c,[structure('scope',['summary'],'closed')],0);
  const half=c.advanceTo(600)[0];
  const same=stageLocal(c,[structure('scope',['latest'],'closed')],625);
  assert.equal(same.blocks[0].progress,0.5);
  assert.equal(same.blocks[0].deadlineAt,1200);
  assert.equal(same.rows[0],'latest');
  assert.equal(same.rows.length,half.rows.length);
  const reversed=stageLocal(c,[tree('scope',9)],650);
  assert.equal(reversed.blocks[0].startedAt,750);
  assert.equal(reversed.blocks[0].deadlineAt,750+motionMs(9-half.rows.length));
  assert.deepEqual(reversed.rows,same.rows);
  assert.deepEqual(c.advanceTo(reversed.blocks[0].deadlineAt)[0].rows,tree('scope',9).rows);
});

test('independent blocks publish atomically with their own deadlines despite offsetting native growth', () => {
  const c=localFrame([tree('a',9),tree('b',5),native('footer',['footer'])]);
  stageLocal(c,[tree('a',1,'closed'),tree('b',5),native('footer',['footer'])],0);
  c.advanceTo(150);
  const pending=stageLocal(c,[tree('a',1,'closed'),tree('b',1,'closed'),native('footer',Array(9).fill('footer'))],150);
  assert.deepEqual(pending.blocks.slice(0,2).map(b=>b.deadlineAt),[1200,750]);
  assert.equal(pending.blocks[2].rows.length,9);
  const bDone=c.advanceTo(750)[0];
  assert.deepEqual(bDone.blocks.slice(0,2).map(b=>b.phase),['transition','stable']);
  assert.deepEqual(c.render().rows,bDone.rows);
  assert.equal(c.render().rootRevision,bDone.rootRevision);
  assert.equal(c.advanceTo(1200)[0].phase,'committed');
});

test('jitter and delayed callbacks use elapsed grid time without overshoot', () => {
  const c=localFrame([tree('scope',9)]);
  stageLocal(c,[tree('scope',1,'closed')],2000);
  assert.equal(c.advanceTo(2020),undefined);
  assert.equal(c.advanceTo(2100),undefined);
  assert.equal(c.readBlocks()[0].progress,0);
  assert.equal(c.advanceTo(2125)[0].blocks[0].progress,25/1200);
  assert.deepEqual(c.advanceTo(10000)[0].rows,tree('scope',1,'closed').rows);
  assert.equal(c.hasPending,false);
});

test('common prefix and suffix survive each intermediate fold without duplicate root rows', () => {
  const prefix='\x1b[32mfixed\x1b[0m', warning='warning';
  const c=localFrame([structure('scope',[prefix,'title','body1','body2',warning])]);
  c.observeBoundary(1);
  const target=structure('scope',[prefix,'summary',warning],'closed');
  stageLocal(c,[target],0);
  for(let at=25;at<=300;at+=25){
    const frame=c.advanceTo(at)[0];
    assert.equal(frame.rows[0],prefix);
    assert.equal(frame.rows.at(-1),warning);
    assert.equal(frame.rows.filter(r=>r===warning).length,1);
    assert.deepEqual(frame.deferred,[]);
  }
  assert.deepEqual(c.render().rows,target.rows);
});

for(const boundary of [2,5]) test(`a frozen crossing block at ${boundary} defers while its visible neighbor folds`,()=>{
  const first={...tree('frozen',5),sources:['source']}, second=tree('visible',5);
  const c=localFrame([first,second]); c.observeBoundary(boundary);
  const target={...tree('frozen',1,'closed'),sources:['source'],paint:[{id:'settle:source',text:'settled',settled:true,from:0,to:1}]};
  const p=stageLocal(c,[target,tree('visible',1,'closed')],0);
  assert.deepEqual(p.blocks[0].rows,first.rows);
  assert.equal(p.blocks[0].paint,undefined);
  assert.ok(p.deferred.some(b=>b.id==='frozen'));
  const final=c.advanceTo(600)[0];
  assert.deepEqual(final.blocks[0].rows,first.rows);
  assert.deepEqual(final.blocks[1].rows,tree('visible',1,'closed').rows);
  assert.equal(c.hasPending,false);
});

test('compatible frozen prefixes allow folding and expansion of the writable tail',()=>{
  const fixed=['\x1b[31mfixed\x1b[0m','fixed2'];
  const c=localFrame([structure('scope',[...fixed,'a','b','c','d'])]); c.observeBoundary(2);
  for(const [at,rows,shape] of [[0,[...fixed,'summary'],'closed'],[600,[...fixed,'a','b','c','d'],'open']]){
    const p=stageLocal(c,[structure('scope',rows,shape)],at),end=p.blocks[0].deadlineAt;
    for(let now=at+25;now<=end;now+=25){const f=c.advanceTo(now)[0];assert.deepEqual(f.rows.slice(0,2),fixed);assert.deepEqual(f.deferred,[]);}
    assert.deepEqual(c.render().rows,rows);
  }
});

test('freezing an incompatible midpoint pins exactly the published bytes and ends motion',()=>{
  const c=localFrame([tree('scope',9)]);stageLocal(c,[tree('scope',1,'closed')],0);
  const mid=c.advanceTo(600)[0];c.observeBoundary(3);
  assert.deepEqual(c.render().rows,mid.rows);
  assert.equal(c.hasPending,false);
  assert.equal(c.advanceTo(2000),undefined);
});

test('removal releases its owner immediately while the new item enters on its own grid',()=>{
  const c=localFrame([tree('old',4),native('tail',['tail'])]);
  const p=stageLocal(c,[tree('new',3),native('tail',['tail'])],0);
  assert.ok(!p.blocks.some(b=>b.id==='old'));
  assert.equal(p.blocks.find(b=>b.id==='new').deadlineAt,450);
  const final=c.advanceTo(600)[0];
  assert.deepEqual(final.rows,[...tree('new',3).rows,'tail']);
  assert.deepEqual(final.blocks.map(b=>b.id),['new','tail']);
});

test('cancel and geometry discard deadlines; a fresh motion begins from the actual publication',()=>{
  const c=localFrame([tree('scope',9)]);stageLocal(c,[tree('scope',1,'closed')],0);
  const mid=c.advanceTo(600)[0];c.cancel();
  assert.deepEqual(c.render().rows,mid.rows);
  assert.equal(c.advanceTo(10000),undefined);
  const fresh=stageLocal(c,[tree('scope',1,'error')],10000);
  assert.equal(fresh.blocks[0].startedAt,10050);
  assert.equal(fresh.blocks[0].deadlineAt,10050+motionMs(mid.rows.length-1));
  c.onGeometryChange();assert.equal(c.advanceTo(20000),undefined);
  assert.deepEqual(c.publish()[0].rows,[]);
  stageLocal(c,[tree('scope',1,'narrow')],20000);c.commit();
  assert.deepEqual(c.render().rows,tree('scope',1,'narrow').rows);
});

test('a newly frozen compatible prefix retains its active fold deadline across content rebase',()=>{
  const fixed='\x1b[31mfixed\x1b[0m';
  const c=localFrame([structure('scope',[fixed,'a','b','c','d','e'])]);
  stageLocal(c,[structure('scope',[fixed,'summary'],'closed')],0);
  const midpoint=c.advanceTo(300)[0], deadline=midpoint.blocks[0].deadlineAt;
  c.observeBoundary(1);
  const rebased=stageLocal(c,[structure('scope',[fixed,'latest'],'closed')],325);
  assert.equal(rebased.blocks[0].deadlineAt,deadline);
  assert.equal(rebased.blocks[0].progress,midpoint.blocks[0].progress);
  assert.equal(rebased.rows[0],fixed);
  const final=c.advanceTo(deadline)[0];
  assert.deepEqual(final.rows,[fixed,'latest']);
  assert.deepEqual(final.deferred,[]);
});

test('unsafe insertion before a frozen prefix defers topology while a visible local update completes',()=>{
  const history=native('history',['h0','h1']), c=localFrame([history,tree('scope',5)]);
  c.observeBoundary(2);
  const pending=stageLocal(c,[native('unsafe',['unsafe']),history,tree('scope',1,'closed')],0);
  assert.ok(pending.deferred.some(b=>b.reason==='frozen-order'));
  const final=c.advanceTo(600)[0];
  assert.deepEqual(final.rows.slice(0,2),history.rows);
  assert.deepEqual(final.blocks.find(b=>b.id==='scope').rows,tree('scope',1,'closed').rows);
  assert.ok(!final.rows.includes('unsafe'));
  assert.equal(c.hasPending,false);
});

test('a final crossing block cannot shrink away its only addressable row',()=>{
  const old=structure('scope',['fixed1','fixed2','visible']);
  const c=localFrame([old]);c.observeBoundary(2);
  stageLocal(c,[structure('scope',['fixed1','fixed2'],'closed')],0);
  const held=c.advanceTo(150)[0];
  assert.deepEqual(held.rows,old.rows);
  assert.deepEqual(held.deferred,[{id:'scope',reason:'host-addressable-tail'}]);
  assert.equal(c.hasPending,false);
});

test('newly admitted text keeps revealing after its unchanged prefix crosses the viewport',()=>{
  const old=structure('scope',['fixed']);
  const c=localFrame([old,native('tail',['tail'])]);
  const target=structure('scope',['fixed','a','b','c','d']);
  stageLocal(c,[target,native('tail',['tail'])],0);
  c.advanceTo(150);c.observeBoundary(1);
  const final=c.advanceTo(600)[0];
  assert.deepEqual(final.rows,[...target.rows,'tail']);
  assert.deepEqual(final.deferred,[]);
  assert.equal(c.hasPending,false);
});

const native = (id, rows) => ({ id, kind: "native", rows, shape: "native" });
const tree = (id, count, shape = "open") => ({ id, kind: "structure", rows: Array.from({ length: count }, (_, i) => `${id}:${shape}:${i}`), shape });

function localFrame(blocks) {
  const coordinator = new HostRowsCoordinator();
  coordinator.register({ blocks, structureKey: "initial" });
  coordinator.publish();
  return coordinator;
}

function stageLocal(coordinator, blocks, now, structureKey = "target") {
  const result = coordinator.stage({ blocks, structureKey }, now);
  if (result !== "unchanged") coordinator.publish();
  return coordinator.render().owners[0];
}

function setup() {
  return localFrame([
    structure("first", ["first open", "first body", "first tail"]),
    structure("second", ["second open", "second body", "second tail"]),
  ]);
}

const structure = (id, rows, shape = "open") => ({ id, kind: "structure", rows, shape });
const initialSecond = () => structure("second", ["second open", "second body", "second tail"]);

test("relabel merges a static published run into one block and refuses moving or different rows", () => {
  const c = localFrame([native("a", ["a1"]), native("b", ["b1", "b2"]), native("c", ["c1"])]);
  const rows = c.render().rows;
  assert.equal(c.observeBoundary(3), undefined, "an unchanged boundary observation publishes nothing and stages nothing");
  assert.equal(c.relabel(["a", "b"], native("sealed", ["a1", "b1", "x"])), false, "rows must be identical");
  assert.equal(c.relabel(["a", "c"], native("sealed", ["a1", "c1"])), false, "the run must be contiguous");
  assert.equal(c.relabel(["a", "b"], native("sealed", ["a1", "b1", "b2"])), true);
  assert.deepEqual(c.render().rows, rows, "relabel never changes published rows");
  assert.deepEqual(c.readBlocks().map((block) => block.id), ["sealed", "c"]);
  assert.equal(c.stage({ blocks: [native("sealed", ["a1", "b1", "b2"]), native("c", ["c1"])], structureKey: "initial" }), "unchanged",
    "a target that already carries the seal is compatible with the relabeled publication");
  const moving = localFrame([tree("x", 3), native("y", ["y1"])]);
  stageLocal(moving, [tree("x", 1, "closed"), native("y", ["y1"])], 100);
  assert.equal(moving.relabel(["x", "y"], native("sealed", moving.render().rows)), false, "a moving block is never sealed");
});

test('shared owner blocks are stable until the next publication and public renders stay isolated', () => {
  const block = { ...native('history', ['original']), sources: ['source'], paint: [{ id: 's', text: 'body', from: 0, to: 1 }] };
  const c = localFrame([block]);
  const first = c.readBlocks();
  assert.equal(c.readBlocks(), first);
  const mutable = c.render(); mutable.owners[0].blocks[0].rows[0] = 'external';
  assert.equal(first[0].rows[0], 'original');
  assert.equal(c.stage({ blocks: [block], structureKey: 'initial' }), 'unchanged');
  assert.equal(c.readBlocks(), first);
  c.stage({ blocks: [native('history', ['updated'])] }); c.commit();
  assert.notEqual(c.readBlocks(), first);
  assert.equal(first[0].rows[0], 'original');
});

test("playback and receipt metadata cannot bypass an incompatible frozen prefix", () => {
  const old = { ...tree("thinking", 5), sources: ["source"] };
  const coordinator = localFrame([old, native("footer", ["footer"])]);
  coordinator.observeBoundary(3);
  const before = coordinator.render().rows;
  const target = { ...old, playback: true, rows: ["new title", "new text"],
    paint: [{ id: "source", text: "new text", from: 1, to: 2 }] };
  const held = stageLocal(coordinator, [target, native("footer", ["footer"])], 100);
  assert.deepEqual(held.rows, before);
  assert.deepEqual(held.blocks[0].paint, undefined, "unpublished new text cannot acquire a visible receipt");
  assert.ok(held.deferred.some(item => item.id === "thinking" && item.reason === "frozen-block"));
  assert.equal(coordinator.hasPending, false);
});

test("a stale host boundary is clamped to the current publication", () => {
  const coordinator = localFrame([native("short", ["short"])]);
  assert.throws(() => coordinator.observeBoundary(24), /outside the publication/);
  assert.doesNotThrow(() => coordinator.observeAvailableBoundary(24));
  assert.equal(coordinator.render().rows.length, 1);
});

test("public snapshots copy receipt values and receipt-only changes invalidate publication", () => {
  const coordinator = localFrame([native("footer", ["footer"])]);
  const live = { ...tree("thinking", 3), playback: true,
    paint: [{ id: "source", text: "first", from: 1, to: 3 }] };
  coordinator.stage({ blocks: [live] }, 100);
  coordinator.publish();
  const read = coordinator.render().owners[0].blocks[0];
  read.paint[0].from = 99;
  read.paint.push({ id: "outside", text: "", from: 0, to: 1 });
  assert.deepEqual(coordinator.render().owners[0].blocks[0].paint, [{ id: "source", text: "first", from: 1, to: 3 }]);
  const sameRows = { ...live, paint: [{ id: "source", text: "second", from: 1, to: 3 }] };
  stageLocal(coordinator, [sameRows], 125);
  assert.equal(coordinator.render().owners[0].blocks[0].paint[0].text, "second", "receipt-only changes invalidate publication");
});

test("render is read-only and does not publish", () => {
  const coordinator = setup();
  const rootRevision = coordinator.currentRootRevision;
  const first = coordinator.render();
  const second = coordinator.render();
  assert.equal(first.rootRevision, rootRevision);
  assert.equal(second.rootRevision, rootRevision);
  assert.deepEqual(first.rows, second.rows);
});

test("fallback carries native blocks alongside projected blocks", () => {
  const coordinator = setup();
  coordinator.stage({
    kind: "fallback", reason: "unsupported projection",
    blocks: [native("first", ["native first", "native detail"]), structure("second", ["projected second"], "closed")],
  }, 200);
  const committed = coordinator.commit()[0];
  assert.deepEqual(committed.rows, ["native first", "native detail", "projected second"]);
  assert.equal(committed.kind, "fallback");
  assert.equal(committed.reason, "unsupported projection");
  assert.deepEqual(committed.blocks.map((block) => block.kind), ["native", "structure"]);
});

test("geometry publishes an empty barrier until the next stage", () => {
  const coordinator = setup();
  coordinator.onGeometryChange();
  const barrier = coordinator.publish()[0];
  assert.equal(barrier.phase, "barrier");
  assert.deepEqual(barrier.rows, []);
  const blocks = [structure("first", ["first narrow"]), structure("second", ["second narrow"])];
  coordinator.stage({ blocks }, 200);
  const narrow = coordinator.commit()[0];
  assert.deepEqual(narrow.rows, ["first narrow", "second narrow"]);
});

test("text-only block content publishes directly without a structural motion", () => {
  const coordinator = setup();
  const after = stageLocal(coordinator, [structure("first", ["updated text", "first body", "first tail"]), initialSecond()], 200);
  assert.equal(after.rows[0], "updated text");
  assert.equal(coordinator.hasPending, false);
});

test("a frozen aggregate defers its merge without discarding later requests", () => {
  const first = { ...structure("scope", ["old", "frozen detail", "live detail", "tail"]), sources: ["old"] };
  const second = { ...structure("second", ["new heading", "new body"]), sources: ["new"] };
  const summary = { ...structure("scope", ["2 Thinking"], "summary"), sources: ["old", "new"] };
  const footer = native("footer", ["footer"]);
  const coordinator = localFrame([first, second, footer]);
  coordinator.observeBoundary(2);
  const deferred = stageLocal(coordinator, [summary, footer], 0);
  assert.deepEqual(deferred.blocks.flatMap((block) => block.sources ?? []), ["old", "new"]);
  assert.deepEqual(deferred.rows, [...first.rows, ...second.rows, "footer"]);
  assert.deepEqual(deferred.deferred, ["scope", "second"].map((id) => ({ id, reason: "frozen-block" })));
  assert.equal(coordinator.advanceTo(800), undefined);
  const changed = stageLocal(coordinator, [summary, native("footer", ["updated footer"])], 900);
  assert.deepEqual(changed.rows, [...first.rows, ...second.rows, "updated footer"]);
  assert.equal(coordinator.hasPending, false);
  coordinator.onGeometryChange();
  const barrier = coordinator.publish()[0];
  assert.equal(barrier.phase, "barrier");
  coordinator.stage({ blocks: [summary, footer] }, 1000);
  const merged = coordinator.commit()[0];
  assert.deepEqual(merged.rows, ["2 Thinking", "footer"]);
  assert.deepEqual(merged.blocks[0].sources, ["old", "new"]);
  assert.deepEqual(merged.deferred, []);
});

test("block fallback retains its explicit native reason even for empty output", () => {
  const coordinator = new HostRowsCoordinator();
  coordinator.register({ kind: "fallback", reason: "native empty component", blocks: [] });
  const result = coordinator.publish()[0];
  assert.equal(result.kind, "fallback");
  assert.equal(result.reason, "native empty component");
  assert.deepEqual(result.rows, []);
});

test("a changed frozen byte still defers and cannot be bypassed by commit", () => {
  const old = { ...tree("scope", 4), rows: ["", "frozen", "body", "tail"] };
  const incompatible = { ...old, shape: "new-request", rows: ["", "rewritten", "new Thinking", "new tool", "new result"] };
  const coordinator = localFrame([old, native("footer", ["footer"])]);
  coordinator.observeBoundary(2);
  const result = stageLocal(coordinator, [incompatible, native("footer", ["footer"])], 200);
  assert.deepEqual(result.blocks[0].rows, old.rows);
  assert.deepEqual(result.deferred, [{ id: "scope", reason: "frozen-block" }]);
  assert.equal(coordinator.hasPending, false);
  assert.deepEqual(coordinator.commit()[0].rows, [...old.rows, "footer"]);
});

test("partial-prefix compatibility does not discard represented sources on a mixed split", () => {
  const old = { ...tree("scope", 5), rows: ["", "Thinking1", "body1", "Thinking2", "body2"], sources: ["thinking1", "thinking2"] };
  const footer = native("footer", ["footer"]);
  const coordinator = localFrame([old, footer]);
  coordinator.observeBoundary(1);
  const target = [{ ...old, shape: "first", sources: ["thinking1"], rows: ["", "Thinking1"] },
    { ...native("prose", ["late prose"]), sources: ["thinking2"] },
    { ...tree("split", 2), sources: ["thinking2"] },
    native("next-user", ["NEW USER"]), { ...tree("fresh", 2), sources: ["thinking3"] }, footer];
  stageLocal(coordinator, target, 200);
  const final = coordinator.advanceTo(1000)[0];
  assert.deepEqual(final.blocks[0].rows, old.rows, "compatible text alone cannot abandon already represented sources");
  assert.equal(final.blocks.some((block) => block.id === "split"), false);
  assert.ok(final.rows.includes("NEW USER"));
  assert.ok(final.blocks.some((block) => block.id === "fresh"));
  assert.equal(coordinator.hasPending, false);
});

test("frozen mixed scope splits retain old content once and admit new input before a visible footer", () => {
  const history = native("history", ["h0", "h1"]);
  const oldScope = { ...tree("scope", 5), sources: ["old-thinking", "later-thinking"] };
  const footer = native("footer", ["footer0", "footer1"]);
  for (const boundary of [3, 8]) {
    const coordinator = localFrame([history, oldScope, footer]);
    coordinator.observeBoundary(boundary);
    const frozen = coordinator.render().rows.slice(0, boundary);
    const split = [history, { ...tree("scope", 1, "folded"), sources: ["old-thinking"] },
      { ...native("mixed-prose", ["late prose"]), sources: ["later-thinking"] },
      { ...tree("split", 2), sources: ["later-thinking"] }, native("new-user", ["NEW USER"]),
      { ...tree("fresh", 3), sources: ["new-thinking"] }, footer];
    stageLocal(coordinator, split, 200);
    const completed = coordinator.advanceTo(1000)[0];
    assert.deepEqual(completed.rows.slice(0, boundary), frozen);
    assert.equal(completed.blocks.filter((block) => block.id === "scope").length, 1);
    assert.deepEqual(completed.blocks.find((block) => block.id === "scope").rows, oldScope.rows);
    assert.equal(completed.blocks.some((block) => block.id === "split"), false);
    assert.ok(completed.rows.includes("NEW USER"));
    assert.deepEqual(completed.blocks.find((block) => block.id === "fresh").rows, tree("fresh", 3).rows);
    assert.equal(coordinator.hasPending, false);
    assert.ok(completed.deferred.some((entry) => entry.reason === "frozen-order"));
    const finalRevision = coordinator.currentRootRevision;
    assert.equal(coordinator.stage({ blocks: split, structureKey: "target" }, 1400), "unchanged");
    assert.equal(coordinator.currentRootRevision, finalRevision);
    coordinator.onGeometryChange();
    coordinator.stage({ blocks: split }, 1600);
    assert.deepEqual(coordinator.commit()[0].rows, split.flatMap((block) => block.rows));
  }
});

test("removing the last addressable tail is deferred even though the frozen prefix matches", () => {
  const history = native("history", ["h0", "h1"]);
  for (const replacement of [[], [native("tail", [])]]) {
    const coordinator = localFrame([history, native("tail", ["visible"])]);
    coordinator.observeBoundary(2);
    const held = stageLocal(coordinator, [history, ...replacement], 0);
    assert.deepEqual(held.rows, ["h0", "h1", "visible"]);
    assert.deepEqual(held.deferred, [{ id: "tail", reason: "host-addressable-tail" }]);
    assert.equal(coordinator.hasPending, false);
  }
});

test("public reads cannot mutate the publication and a backward sample cannot rewind it", () => {
  const coordinator = localFrame([tree("scope", 9)]);
  stageLocal(coordinator, [tree("scope", 1, "closed")], 2000);
  const midpoint = coordinator.advanceTo(2400)[0];
  const revision = coordinator.currentRootRevision;
  const read = coordinator.render();
  read.owners[0].blocks[0].rows[0] = "mutated output";
  read.owners[0].deferred.push({ id: "x", reason: "frozen-block" });
  read.rows[0] = "mutated root";
  assert.deepEqual(coordinator.render().rows, midpoint.rows);
  assert.equal(coordinator.currentRootRevision, revision);
  assert.equal(coordinator.advanceTo(2300), undefined, "a backward sample cannot rewind progress");
  assert.deepEqual(coordinator.advanceTo(4000)[0].rows, tree("scope", 1, "closed").rows);
  const endpointRevision = coordinator.currentRootRevision;
  assert.equal(coordinator.stage({ blocks: [tree("scope", 1, "closed")], structureKey: "target" }, 4200), "unchanged");
  assert.equal(coordinator.currentRootRevision, endpointRevision);
});

test("physical geometry rebuild clears local freezes while explicit commit still respects them", () => {
  const coordinator = localFrame([tree("scope", 9), native("footer", ["footer"])]);
  coordinator.observeBoundary(3);
  stageLocal(coordinator, [tree("scope", 1, "folded"), native("footer", ["footer"])], 0);
  assert.equal(coordinator.commit()[0].blocks[0].rows.length, 9);
  coordinator.onGeometryChange();
  assert.equal(coordinator.publish()[0].phase, "barrier");
  coordinator.stage({ blocks: [tree("scope", 1, "folded"), native("footer", ["narrow footer"])] }, 2000);
  const rebuilt = coordinator.commit()[0];
  assert.deepEqual(rebuilt.rows, [...tree("scope", 1, "folded").rows, "narrow footer"]);
  assert.equal(rebuilt.deferred.length, 0);
  assert.equal(coordinator.hasPending, false);
});

test("interleaved topology changes and viewport advances preserve frozen bytes and converge without timers", () => {
  let seed = 0x4c33464f;
  const random = (max) => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % max;
  };
  let target = [native("history", Array.from({ length: 8 }, (_, i) => `h${i}`)), tree("a", 9), tree("b", 5), native("footer", ["footer"] )];
  const coordinator = localFrame(target);
  let boundary = 6;
  coordinator.observeBoundary(boundary);
  let now = 0;
  for (let index = 0; index < 200; index++) {
    now += random(40);
    const prior = coordinator.render();
    const frozen = prior.rows.slice(0, boundary);
    const operation = random(6);
    if (operation === 0 && target.length) {
      const at = random(target.length);
      target[at] = { ...target[at], rows: Array.from({ length: random(10) }, (_, row) => `mutation:${index}:${row}`), shape: `shape:${random(3)}` };
      stageLocal(coordinator, target, now);
    } else if (operation === 1) {
      target.splice(random(target.length + 1), 0, tree(`new-${index}`, random(8)));
      stageLocal(coordinator, target, now);
    } else if (operation === 2 && target.length) {
      target.splice(random(target.length), 1);
      stageLocal(coordinator, target, now);
    } else if (operation === 3 && target.length > 1) {
      const [moved] = target.splice(random(target.length), 1);
      target.splice(random(target.length + 1), 0, moved);
      stageLocal(coordinator, target, now);
    } else if (operation === 4 && prior.rows.length > boundary + 1) {
      boundary += random(prior.rows.length - boundary);
      coordinator.observeBoundary(boundary);
    } else coordinator.advanceTo(now);
    const after = coordinator.render();
    assert.deepEqual(after.rows.slice(0, frozen.length), frozen);
    assert.equal(new Set(after.owners[0].blocks.map((block) => block.id)).size, after.owners[0].blocks.length);
    assert.deepEqual(coordinator.render().rows, after.rows);
    assert.equal(coordinator.currentRootRevision, after.rootRevision);
  }
  coordinator.advanceTo(now + 1_000);
  assert.equal(coordinator.hasPending, false);
});

test("a sealed block is the same block while its rows are the same array, and is never read", () => {
  // The plain coordinator: the host view would read every row when it materializes.
  const coordinator = new FrameCoordinator();
  const reads = [];
  const rows = new Proxy(["H0", "H1"], { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) reads.push(key);
    return Reflect.get(target, key, receiver);
  } });
  const sealed = { id: "sealed", kind: "native", shape: "sealed", sealed: true, rows };
  const tail = (row) => ({ id: "tail", kind: "native", shape: "tail", rows: [row] });
  coordinator.register({ blocks: [sealed, tail("T0")], structureKey: "k" });
  coordinator.publish();
  coordinator.observeBoundary(2);
  reads.length = 0;
  assert.equal(coordinator.stage({ blocks: [sealed, tail("T0")], structureKey: "k" }), "unchanged");
  assert.equal(coordinator.stage({ blocks: [sealed, tail("T1")], structureKey: "k" }), "opened");
  coordinator.publish();
  assert.deepEqual(reads, [], "staging and publishing compare the sealed rows by identity only");
  assert.equal(coordinator.stage({ blocks: [{ ...sealed, rows: ["H0", "H1"] }, tail("T1")], structureKey: "k" }), "opened",
    "a new sealed array is a new block");
});
