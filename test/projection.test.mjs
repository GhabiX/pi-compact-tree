import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HostRowsCache, rowOwners} from './host-rows.mjs';
import {attachMotionScheduler,stopMotion} from '../extensions/motion.ts';
const presentation=(classify,renderNative=c=>c.render())=>({classify,renderNative,theme:false,expanded:false,styleEpoch:0});
function processCard(name,state={}){return {toolName:name,args:{command:name},result:{isError:false,content:[{type:'text',text:'done'}]},updateResult(value){this.result=value;},setExpanded(){},...state,render(){return [`native ${name}`]}};}
function thinkingCard(text,state={}){return processCard('thinking',{args:{thinking:text},lastMessage:{content:[{type:'thinking',thinking:text}],stopReason:'toolUse'},...state});}

const options=()=>({...presentation(c=>c.toolName?c:undefined),layoutId:'chat'});
test('request flags do not split a run; Thinking and changes create flat items', () => {
  const cache = new HostRowsCache(), children = [thinkingCard('FIRST'), ...['bash','read','bash'].map(n => processCard(n, { requestStart: true })), thinkingCard('SECOND'), processCard('write')];
  const r = cache.prepare(children, 80, options());
  assert.equal(r.blocks.length, 4);
  assert.deepEqual(r.blocks.map(b => b.rows.find(row => row.trim())), [' ● FIRST', ' ● Ran 2 shell commands, read 1 file', ' ● SECOND', ' ● Write']);
  cache.dispose();
});
test('marker-only native rows do not split runs and visible prose closes the last call', () => {
  const cache = new HostRowsCache(), children = [processCard('read'), {render: () => ['\x1b]133;C\x07']}, processCard('bash')];
  const r = cache.prepare(children, 80, options());
  assert.equal(r.blocks.filter(b => b.kind === 'structure').length, 1);
  assert.match(r.rows.join('\n'), /Read 1 file, ran 1 shell command/);
  children.push({render: () => ['ANSWER']});
  const done = cache.prepare(children, 80, options());
  assert.equal(done.blocks.find(b => b.kind === 'structure').rows.filter(row => row.trim()).length, 1);
  cache.dispose();
});
test('a run shows only its current call without a recent-children window', () => {
  const cache = new HostRowsCache(), children = Array.from({length: 8}, (_, i) => processCard('bash', {args: {command: 'command_' + i}}));
  const r = cache.prepare(children, 80, options());
  assert.deepEqual(r.rows, [' ● Ran 8 shell commands']);
  cache.dispose();
});
test('closed runs retain failed call diagnostics and hide successful details', () => {
  const cache = new HostRowsCache(), children = [thinkingCard('FIRST'), processCard('bash', {args: {command: 'SUCCESS'}}), processCard('read', {args: {path: 'failed.md'}, result: {isError: true, content: [{type: 'text', text: 'ENOENT'}]}}), thinkingCard('NEXT')];
  const r = cache.prepare(children, 80, options());
  assert.deepEqual(r.blocks[1].rows.filter(row => row.trim()), [' ● Ran 1 shell command, read 1 file', '   ⎿  Read(failed.md) · Error: ENOENT']);
  assert.doesNotMatch(r.rows.join('\n'), /SUCCESS/);
  cache.dispose();
});
test('terminal current calls replace partial output with final output and an error diagnostic', () => {
  const cache = new HostRowsCache(), c = processCard('bash', {result: undefined}), children = [c];
  c.updateResult({content: [{type: 'text', text: 'RUNNING_OUTPUT'}]}); c.isPartial = true; cache.invalidate();
  assert.match(cache.prepare(children, 80, options()).rows.join('\n'), /RUNNING_OUTPUT/);
  c.isPartial = false; c.updateResult({content: [{type: 'text', text: 'FINAL_OUTPUT'}], isError: true});
  const r = cache.prepare(children, 80, options());
  assert.doesNotMatch(r.rows.join('\n'), /RUNNING_OUTPUT/);
  assert.match(r.rows.join('\n'), /Error: FINAL_OUTPUT/);
  cache.dispose();
});
test('Ctrl+O shows the first eight body rows of Thinking and the change arguments', () => {
  const cache = new HostRowsCache(), text = Array.from({length: 12}, (_, i) => 'BODY_' + i).join('\n'), children = [thinkingCard(text), processCard('write', {args: {path: 'x', content: 'FULL_PAYLOAD'}}), thinkingCard('next')], o = options();
  assert.doesNotMatch(cache.prepare(children, 80, o).rows.join('\n'), /FULL_PAYLOAD/); o.expanded = true;
  const r = cache.prepare(children, 80, o);
  assert.match(r.rows.join('\n'), /BODY_8\n\s+… \+3 lines/); assert.doesNotMatch(r.rows.join('\n'), /BODY_9/);
  assert.match(r.rows.join('\n'), /FULL_PAYLOAD/); cache.dispose();
});
test('provider errors are independent items with one diagnostic per source', () => {
  const cache = new HostRowsCache(), children = [thinkingCard('provider'), ...Array.from({length: 3}, () => processCard('provider_error', {args: {text: 'Error: fetch failed'}, result: {isError: true, content: []}})), thinkingCard('next')];
  const r = cache.prepare(children, 80, options());
  assert.equal(r.blocks.length, 5);
  assert.equal(r.rows.filter(row => row === ' ● Error: fetch failed').length, 3);
  cache.dispose();
});
test('disposing a retained projection releases its publication and leaves prior snapshots isolated', () => {
  const cache = new HostRowsCache();
  const tool = processCard('bash');
  const snapshot = cache.prepare([tool], 80, presentation(c => c));
  assert.ok(snapshot.rows.length);
  cache.dispose();
  assert.equal(cache.read().rows.length, 0);
  assert.equal(cache.read().blocks.length, 0);
  assert.ok(snapshot.rows.length, 'the caller still owns its independent earlier snapshot');
});

test("host source identity survives cache recreation and newly inserted native boundaries", () => {
  const ids = new WeakMap();
  let next = 0;
  const identify = (source) => {
    if (!ids.has(source)) ids.set(source, `host-${++next}`);
    return ids.get(source);
  };
  const user = { render: () => ["user"] };
  const first = thinkingCard("first");
  const second = thinkingCard("second");
  const options = { ...presentation((source) => source.toolName ? source : undefined), expanded: true, layoutId: "chat" };
  const original = new HostRowsCache(identify);
  const before = original.prepare([user, first, second], 80, options);
  const secondBlock = before.blocks.find(block => block.rows.some(row => row.includes("second")));
  assert.ok(secondBlock);
  original.dispose();
  const added = { render: () => ["later user"] };
  const replacement = new HostRowsCache(identify);
  const after = replacement.prepare([user, first, second, added, thinkingCard("second")], 80, options);
  const copies = after.blocks.filter(block => block.rows.some(row => row.includes("second")));
  assert.equal(copies.length, 2);
  assert.equal(copies[0].id, secondBlock.id);
  assert.deepEqual(copies[0].sources, secondBlock.sources);
  assert.notEqual(copies[1].id, secondBlock.id, "equal text on another source is a new request");
  assert.notDeepEqual(copies[1].sources, secondBlock.sources);
  replacement.dispose();
});

test("projection reads do not reclassify, advance paint or observe unprepared mutations", () => {
  const card = processCard("write");
  const cache = new HostRowsCache();
  let calls = 0;
  const options = presentation((component) => { calls++; return component; });
  const first = cache.prepare([card], 80, options);
  const afterPrepare = calls;
  card.updateResult({ isError: false, content: [{ type: "text", text: "latest" }] });
  assert.deepEqual(cache.read(), first);
  assert.deepEqual(cache.read(), first);
  assert.equal(calls, afterPrepare);
  cache.dispose();
});

test("a sealed prefix keeps its rows, stops observing its sources and matches an unsealed suffix", () => {
  const ids = new WeakMap();
  let next = 0;
  const identify = (source) => {
    if (!ids.has(source)) ids.set(source, `host-${++next}`);
    return ids.get(source);
  };
  const reads = new Map();
  const user = (text) => {
    const component = { render() { reads.set(component, (reads.get(component) ?? 0) + 1); return ["", text]; } };
    return component;
  };
  // A projection owns hooks on its sources; the unsealed reference uses equal but distinct sources.
  const build = () => [user("USER 1"), processCard("bash"), processCard("read"), user("USER 2"), processCard("bash"), user("USER 3"),
    processCard("write"), processCard("edit"), user("USER 4")];
  const children = build().slice(0, 7);
  const options = {
    ...presentation((component) => component.toolName ? component : undefined),
    layoutId: "chat",
    nativeBlocks: (component, rows) => [{ id: identify(component), kind: "native", shape: "native", rows }],
  };
  const cache = new HostRowsCache(identify);
  const full = cache.prepare(children, 80, options);
  const proposal = cache.proposeSeal(full.rows.length, full.blocks.map((block) => ({ ...block, phase: "stable" })));
  assert.equal(proposal.count, 5, "the seal ends before the last frozen pure native boundary");
  assert.deepEqual(proposal.block.rows, full.rows.slice(0, proposal.block.rows.length));
  cache.commitSeal(proposal);
  const before = reads.get(children[0]);
  assert.deepEqual(cache.prepare(children, 80, options).rows, full.rows, "sealed output is byte-identical");
  assert.equal(reads.get(children[0]), before, "sealed sources are no longer observed");
  children.push(processCard("edit"), user("USER 4"));
  const fresh = new HostRowsCache(identify).prepare(build(), 80, options);
  assert.deepEqual(cache.prepare(children, 80, options).rows, fresh.rows, "an appended suffix matches an unsealed projection");
  cache.prepare(children, 40, options);
  assert.ok(reads.get(children[0]) > before, "a width change unseals and observes history again");
});

test("a seal followed only by native rows keeps the assembled output", () => {
  const ids = new WeakMap();
  let next = 0;
  const identify = (source) => {
    if (!ids.has(source)) ids.set(source, `host-${++next}`);
    return ids.get(source);
  };
  const user = (text) => ({ render() { return ["", text]; } });
  const children = [user("USER 1"), processCard("bash"), user("USER 2"), user("USER 3")];
  const options = {
    ...presentation((component) => component.toolName ? component : undefined),
    layoutId: "chat",
    nativeBlocks: (component, rows) => [{ id: identify(component), kind: "native", shape: "native", rows }],
  };
  const cache = new HostRowsCache(identify);
  const full = cache.prepare(children, 80, options);
  const proposal = cache.proposeSeal(full.rows.length, full.blocks.map((block) => ({ ...block, phase: "stable" })));
  assert.equal(proposal.count, 3, "the seal covers the only process");
  cache.commitSeal(proposal);
  const sealed = cache.prepare(children, 80, options);
  assert.notEqual(sealed.kind, "fallback", "native rows after a seal are not a native-only container");
  assert.deepEqual(sealed.rows, full.rows, "history is not rendered a second time");
});

test("prepared-row reuse observes unhooked native rows and row ownership", () => {
  const card = processCard("bash");
  let text = "native A";
  let owner = "native:a";
  let calls = 0;
  const native = { render() { calls++; return [text]; } };
  const children = [card, native];
  const cache = new HostRowsCache();
  const options = {
    ...presentation((component) => component === card ? component : undefined),
    layoutId: "chat",
    nativeBlocks: (_, rows) => [{ id: owner, kind: "native", shape: "native", rows }],
  };
  const first = cache.prepare(children, 80, options);
  assert.deepEqual(cache.prepare(children, 80, options), first);
  assert.equal(calls, 2, "native input still renders at the same paint clock");
  text = "native B";
  const changed = cache.prepare(children, 80, options);
  assert.ok(changed.rows.includes(text));
  assert.notDeepEqual(changed.rows, first.rows);
  owner = "native:b";
  const relabeled = cache.prepare(children, 80, options);
  assert.deepEqual(relabeled.rows, changed.rows);
  assert.ok(relabeled.blocks.some(block => block.id === owner));
  assert.notDeepEqual(rowOwners(relabeled), rowOwners(changed));
  cache.dispose();
});

test("stable preparation reuses classification while native children stay live", () => {
	const first = processCard("bash");
	const native = {
		render() {
			return ["native block"];
		},
	};
	const children = [first, native];
	const counts = { classify: 0, native: 0 };
	const cache = new HostRowsCache();
	const classify = (component) => {
		counts.classify += 1;
		return component === first ? component : undefined;
	};
	const options = presentation(classify, (component) => {
		counts.native += 1;
		return component.render();
	});

	cache.prepare(children, 80, options);
	assert.equal(counts.classify, 2);
	assert.equal(counts.native, 1);
	cache.prepare(children, 80, options);
	assert.equal(counts.classify, 2);
	assert.equal(counts.native, 2);

	first.updateResult({
		isError: false,
		content: [{ type: "text", text: "changed" }],
	});
	cache.prepare(children, 80, options);
	assert.equal(counts.classify, 3);
	assert.equal(counts.native, 3);
	cache.dispose();
});

test("queued to started is observed by the execution boundary hook", () => {
	const queued = processCard("write", {
		started: false,
		result: undefined,
		markExecutionStarted() {
			this.started = true;
		},
	});
	const cache = new HostRowsCache();
	const classify = (component) => (component.started ? component : "hidden");
	const options = presentation(classify);
	const children = [queued];

	const hidden = cache.prepare(children, 80, options);
	assert.equal(hidden.kind, "empty");
	assert.deepEqual(hidden.rows, []);
	queued.markExecutionStarted();
	const started = cache.prepare(children, 80, options);
	assert.equal(started.kind, "committed");
	assert.equal(started.rows.length, 2);
	assert.match(started.rows[0], /Write/);
	cache.dispose();
});

test("same-length replacements prepare the new source and release old hooks", () => {
	const previous = processCard("bash");
	const updateResult = previous.updateResult;
	const children = [previous];
	const cache = new HostRowsCache();
	const options = presentation((component) => component);
	cache.prepare(children, 80, options);
	assert.notEqual(previous.updateResult, updateResult);
	children[0] = processCard("read");
	const replacement = cache.prepare(children, 80, options);
	assert.equal(replacement.kind, "committed");
  assert.equal(replacement.rows.length, 1);
	assert.match(replacement.rows.join("\n"), /Read/);
	assert.doesNotMatch(replacement.rows.join("\n"), /Bash/);
	assert.equal(previous.updateResult, updateResult);
	cache.dispose();
});

test("dispose restores wrapped component methods", () => {
	const card = processCard("bash");
	const original = card.updateResult;
	const cache = new HostRowsCache();
	const options = presentation((component) => component);
	cache.prepare([card], 80, options);
	cache.dispose();
	assert.equal(card.updateResult, original);
	cache.dispose();
});

test("disabled preparation exposes native fallback and releases component hooks", () => {
  const card = processCard("bash");
  const original = card.updateResult;
  const cache = new HostRowsCache();
  const options = presentation((component) => component);
  cache.prepare([card], 80, options);
  assert.notEqual(card.updateResult, original);
  cache.disable();
  assert.equal(card.updateResult, original);
  const fallback = cache.prepare([card], 80, options);
  assert.equal(fallback.kind, "fallback");
  assert.equal(fallback.reason, "projection-disabled");
  assert.deepEqual(fallback.rows, ["native bash"]);
  cache.dispose();
});
test('topology churn bounds owned receipts and never replays its surviving title',()=>{
 attachMotionScheduler(()=>{}, {now:()=>0,setInterval:()=>1,clearInterval(){}});const cache=new HostRowsCache(),keep=processCard('read',{playbackSource:true});
 const o={...options(),confirmPaint:true};
 for(let i=0;i<100;i++){
  const x=processCard('bash',{playbackSource:true}),items=[keep,x];
  for(let j=0;j<3;j++)for(const b of cache.prepare(items,80,o).blocks??[])for(const p of b.paint??[])cache.acknowledge(p.id,p.text);
  const after=cache.prepare([keep],80,o);assert.ok(cache.gate.settled.size<=2);assert.ok((after.blocks[0].paint??[]).every(p=>p.id.includes('settle:')));
 }
 cache.dispose();stopMotion();
});
test('cold history and sealed live sources keep no heavy Flow and reenter cold on unseal',()=>{
 attachMotionScheduler(()=>{}, {now:()=>0,setInterval:()=>1,clearInterval(){}});
 const cache=new HostRowsCache(),children=[];for(let i=0;i<100;i++)children.push(thinkingCard('x'.repeat(10000),{playbackSource:false}),{render:()=>['USER '+i]});
 const o={...options(),confirmPaint:true,nativeBlocks:(c,rows)=>[{id:'n'+children.indexOf(c),kind:'native',rows,shape:'native'}]};
 const before=cache.prepare(children,80,o);assert.equal(cache.gate.flows.size,0);
 const proposal=cache.proposeSeal(before.rows.length,before.blocks.map(b=>({...b,phase:'stable'})));cache.commitSeal(proposal);
 assert.equal(cache.gate.flows.size,0);assert.equal(cache.gate.settled.size,0);cache.unseal();cache.prepare(children,80,o);assert.equal(cache.gate.flows.size,0);
 cache.dispose();stopMotion();
});
test('paint coordinates returned by read are isolated from publication metadata',()=>{
 attachMotionScheduler(()=>{}, {now:()=>0,setInterval:()=>1,clearInterval(){}});const cache=new HostRowsCache(),o={...options(),confirmPaint:true};
 cache.prepare([processCard('bash',{playbackSource:true})],80,o);const copy=cache.read(),original=cache.read().blocks[0].paint[0].from;
 copy.blocks[0].paint[0].from=999;assert.equal(cache.read().blocks[0].paint[0].from,original);cache.dispose();stopMotion();
});
test('a completed live body releases its heavy state at seal and stays cold after unseal',()=>{
 let now=0;attachMotionScheduler(()=>{}, {now:()=>now,setInterval:()=>1,clearInterval(){}});const cache=new HostRowsCache(),body='sealed live '.repeat(1000),thinking=thinkingCard(body,{playbackSource:true,playbackEnded:false}),native={render:()=>['USER']},children=[thinking,native];
 const o={...options(),confirmPaint:true,nativeBlocks:(c,rows)=>[{id:'native',kind:'native',rows,shape:'native'}]};
 for(let i=0;i<600;i++){now=i*25;cache.gate.advance({now,elapsedMs:25});for(const b of cache.prepare(children,80,o).blocks??[])for(const p of b.paint??[])cache.acknowledge(p.id,p.text);}
 const [id,flow]=[...cache.gate.flows][0];assert.equal(flow.drawn,body);assert.equal(cache.gate.flowComplete(id,body),true);
 cache.gate.acknowledge(`settle:${id}`, 'settled');thinking.playbackEnded=true;cache.invalidate();now += 1_000;const r=cache.prepare(children,80,o);assert.equal(cache.gate.flows.size,1);
 const proposal=cache.proposeSeal(r.rows.length,r.blocks.map(b=>({...b,phase:'stable'})));assert.ok(proposal);cache.commitSeal(proposal);
 assert.equal(cache.gate.flows.size,0);assert.equal(cache.gate.settled.size,0);cache.unseal();cache.prepare(children,80,o);assert.equal(cache.gate.flows.size,0);cache.dispose();stopMotion();
});
test('a source losing its process role releases its owned receipts without removing the component',()=>{
 attachMotionScheduler(()=>{}, {now:()=>0,setInterval:()=>1,clearInterval(){}});const cache=new HostRowsCache(),card=processCard('bash',{playbackSource:true}),o={...options(),confirmPaint:true,classify:c=>c.hidden?undefined:c};
 for(let i=0;i<3;i++)for(const b of cache.prepare([card],80,o).blocks??[])for(const p of b.paint??[])cache.acknowledge(p.id,p.text);
 assert.ok(cache.gate.settled.size>0);card.hidden=true;card.updateResult({content:[],isError:false});cache.prepare([card],80,o);assert.equal(cache.gate.settled.size,0);cache.dispose();stopMotion();
});
test('in-place replacement of a sealed child unseals while invalidate keeps the frozen prefix',()=>{
 const user=text=>({render(){return ['',text];}});
 const children=[thinkingCard('OLD_BODY'),user('NATIVE_1'),thinkingCard('TAIL_BODY')];
 const o={...options(),confirmPaint:true,nativeBlocks:(c,rows)=>[{id:'n',kind:'native',shape:'native',rows}]};
 const cache=new HostRowsCache();
 const first=cache.prepare(children,80,o);
 const proposal=cache.proposeSeal(first.rows.length,first.blocks.map(b=>({...b,phase:'stable'})));
 assert.ok(proposal);cache.commitSeal(proposal);assert.ok(cache.sealed);
 children[0]=thinkingCard('NEW_BODY');
 const replacedPrefix=cache.prepare(children,80,o);
 assert.equal(cache.sealed,undefined,'replacing a sealed child in place unseals the cache');
 assert.doesNotMatch(replacedPrefix.rows.join('\n'),/OLD_BODY/);
 assert.match(replacedPrefix.rows.join('\n'),/NEW_BODY/);
 const reseal=cache.proposeSeal(replacedPrefix.rows.length,replacedPrefix.blocks.map(b=>({...b,phase:'stable'})));
 assert.ok(reseal);cache.commitSeal(reseal);assert.ok(cache.sealed);
 children[2]=thinkingCard('NEW_TAIL');
 const replacedTail=cache.prepare(children,80,o);
 assert.ok(cache.sealed,'replacing an unsealed tail child keeps the seal');
 assert.match(replacedTail.rows.join('\n'),/NEW_BODY[\s\S]*NEW_TAIL/);
 // Pi invalidates components on ordinary updates; frozen rows are already in scrollback, so the seal stays.
 cache.invalidate();
 assert.ok(cache.sealed,'invalidate keeps the frozen seal');
 cache.dispose();
});
test('styleEpoch keeps the sealed prefix; Ctrl+O keeps it only while its rows come out the same',()=>{
 const user=text=>({render(){return ['',text];}});
 const children=[thinkingCard('FROZEN_0\nFROZEN_1\nFROZEN_2\nFROZEN_3'),user('NATIVE'),thinkingCard('TAIL_0\nTAIL_1\nTAIL_2\nTAIL_3')];
 const o={...options(),confirmPaint:true,nativeBlocks:(c,rows)=>[{id:'n',kind:'native',shape:'native',rows}]};
 const cache=new HostRowsCache();
 const first=cache.prepare(children,80,o);
 const proposal=cache.proposeSeal(first.rows.length,first.blocks.map(b=>({...b,phase:'stable'})));
 assert.ok(proposal);cache.commitSeal(proposal);
 o.styleEpoch=1;cache.prepare(children,80,o);
 assert.ok(cache.sealed,'styleEpoch does not unseal frozen history');
 o.expanded=true;
 const after=cache.prepare(children,80,o);
 assert.equal(cache.sealed,undefined,'Ctrl+O unseals a prefix it draws differently');
 assert.match(after.rows.join('\n'),/FROZEN_3[\s\S]*TAIL_3/);
 const plain=[thinkingCard('ONE'),user('NATIVE'),thinkingCard('TAIL_0\nTAIL_1\nTAIL_2\nTAIL_3')],p={...o,expanded:false},other=new HostRowsCache();
 const shown=other.prepare(plain,80,p);
 const seal=other.proposeSeal(shown.rows.length,shown.blocks.map(b=>({...b,phase:'stable'})));
 assert.ok(seal);other.commitSeal(seal);const block=other.sealed.block;
 p.expanded=true;
 assert.match(other.prepare(plain,80,p).rows.join('\n'),/TAIL_3/);
 assert.equal(other.sealed?.block,block,'Ctrl+O keeps a sealed prefix it draws the same');
 const resized=cache.prepare(children,40,o);
 assert.equal(cache.sealed,undefined,'width change unseals history');
 assert.match(resized.rows.join('\n'),/FROZEN_3/);
 cache.dispose();other.dispose();
});
test('a finished single item keeps the motion clock armed while waiting for its settle receipt',()=>{
 let now=0,armed=0,tickFn;
 attachMotionScheduler(()=>{},{now:()=>now,setInterval:(fn)=>{armed++;tickFn=fn;return 1;},clearInterval:()=>{armed--;}});
 const cache=new HostRowsCache(),thinking=thinkingCard('R1_THOUGHT',{isStreaming:true,playbackSource:true,playbackEnded:false});
 const tool=processCard('bash',{args:{command:'printf R1_TOOL'},playbackSource:true}),children=[thinking,tool],o={...options(),confirmPaint:true};
 cache.prepare(children,80,o);
 while(now<300){now+=25;tickFn();const r=cache.prepare(children,80,o);for(const p of r.blocks[0].paint??[])if(!p.settled)cache.acknowledge(p.id,p.text);}
 thinking.isStreaming=false;thinking.playbackEnded=true;thinking.updateResult(thinking.result);
 now=1200;const folding=cache.prepare(children,80,o);
 assert.equal(folding.blocks[0].playback,false);
 assert.ok(folding.blocks[0].paint.some(s=>s.settled),'folded Thinking waits for its settle receipt before admitting the tool');
 assert.equal(cache.ticking,true,'clock stays armed while waiting for the settle receipt');
 assert.equal(armed,1);
 cache.dispose();stopMotion();
});
