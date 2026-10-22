import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {configure} from './replay/source.mjs';
const source=configure();
const {createFixture}=await import('./replay/fixture.mjs');
after(()=>{source.verify();source.hook.deregister();});
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=(content,stopReason='toolUse',extra={})=>({role:'assistant',api:'openai-responses',provider:'fixture',model:'fixture-model',content,stopReason,timestamp:1,usage,...extra});
const thought=(text,extra=[])=>assistant([{type:'thinking',thinking:text},...extra]);
const call=(id,command='pwd')=>({type:'toolCall',id,name:'bash',arguments:{command}});
async function harness(t,opts={}){
  const f=await createFixture({height:40,...opts}),root=f.mode.renderer,frames=[],receipts=[];
  t.after(()=>assert.equal(f.close().remainingTimers,0));
  // Frames and receipts are read after each draw Pi schedules itself; the test never draws.
  f.onRender(()=>{const host=root.captureRenderState();const state=f.Container.prototype[Symbol.for('pi-compact-ui2tree/container-render-v1')];
    let offset=0;for(const block of state.rootFrames.get(root).coordinator.render().owners[0].blocks){
      for(const span of block.paint??[]){if(root.hasOverlay()||span.to<=span.from||offset+span.from<host.previousViewportTop||offset+span.to>host.previousViewportTop+f.terminal.rows)continue;
        const rows=block.rows.slice(span.from,span.to).map(f.stripTerminalSequences);
        if(rows.every((row,i)=>row.trimEnd()===f.stripTerminalSequences(host.previousLines[offset+span.from+i]??'').trimEnd()))receipts.push({...span,rows,at:f.now});
      }offset+=block.rows.length;
    }
    frames.push({rows:host.previousLines.map(f.stripTerminalSequences),at:f.now});
  });
  const screen=()=>root.captureRenderState().previousLines.map(f.stripTerminalSequences);
  /** The screen once the draw Pi has scheduled, if any, has run. */
  async function draw(){await f.frame();return screen();}
  async function emit(event,flush=true){await f.emit(event);if(flush)await f.frame();}
  async function step(ms=25){await f.tick(ms);return screen();}
  async function drain(max=1600){for(let i=0;i<max;i++)await step();}
  async function start(text,calls=[]){await emit({type:'agent_start'});await emit({type:'message_start',message:assistant([])});await emit({type:'message_update',message:thought(text,calls)});}
  async function finish(text,calls=[]){await emit({type:'message_end',message:thought(text,calls)});}
  async function tool(id,command='pwd',error=false){await emit({type:'tool_execution_start',toolCallId:id,toolName:'bash',args:{command}});
    await emit({type:'tool_execution_end',toolCallId:id,result:{content:[{type:'text',text:'RESULT'}],isError:error},isError:error});}
  return {f,root,frames,receipts,draw,emit,step,drain,start,finish,tool};
}
for(const width of [40,80,140])test(`real Pi Thinking draws every advancing prefix and final source at ${width}`,async t=>{
  const h=await harness(t,{width}),text=Array.from({length:30},(_,i)=>`THOUGHT_${i} 中文👩‍💻`).join('\n');
  await h.start(text);await h.step();await h.draw();assert.ok(h.receipts.some(p=>!p.settled&&text.startsWith(p.text)&&p.text.length>0&&p.text.length<text.length));
  await h.finish(text);await h.drain();const draws=h.receipts.filter(p=>!p.settled&&text.startsWith(p.text));
  assert.ok(draws.some(p=>p.text===text),'the actual host drew the complete final prefix');
  assert.ok(draws.every(p=>p.rows.length<=9),'Thinking uses one title plus at most eight body rows');
  assert.match(h.frames.at(-1).rows.join('\n'),/THOUGHT_0/);
  assert.doesNotMatch(h.frames.at(-1).rows.join('\n'),/THOUGHT_29/,'body is reclaimed after the source ended and was painted');
});
test('empty streaming and terminal Thinking sources have no process heading until content or a tool arrives',async t=>{
  const h=await harness(t);
  for(const text of ['', ' \n ']){
    await h.start(text);
    assert.ok(h.frames.at(-1).rows.every(row=>!/^ ●/.test(row)));
    await h.finish(text);
    assert.ok(h.frames.at(-1).rows.every(row=>!/^ ●/.test(row)));
  }
  await h.emit({type:'tool_execution_start',toolCallId:'empty-read',toolName:'read',args:{path:'empty.md'}});
  await h.drain(100);assert.ok(h.frames.at(-1).rows.includes(' ● Read 1 file'));
  await h.emit({type:'tool_execution_end',toolCallId:'empty-read',result:{content:[],isError:false},isError:false});
  await h.drain(20);
  await h.drain(100);assert.ok(h.frames.at(-1).rows.includes(' ● Read 1 file'));
});
test('later items wait for predecessor playback, fold and settle receipt',async t=>{
  const h=await harness(t),one=call('one','FIRST_COMMAND');await h.start('FIRST_THOUGHT',[one]);await h.finish('FIRST_THOUGHT',[one]);
  await h.emit({type:'tool_execution_start',toolCallId:'one',toolName:'bash',args:one.arguments},false);
  await h.emit({type:'tool_execution_end',toolCallId:'one',result:{content:[],isError:false},isError:false},false);
  await h.emit({type:'message_start',message:assistant([])},false);await h.emit({type:'message_update',message:thought('SECOND_THOUGHT')},false);
  const first=(await h.draw()).join('\n');assert.doesNotMatch(first,/FIRST_COMMAND|SECOND_THOUGHT/);
  await h.drain();const final=h.frames.at(-1).rows.join('\n');assert.doesNotMatch(final,/FIRST_COMMAND/);assert.match(final,/FIRST_THOUGHT[\s\S]*Ran 1 shell command[\s\S]*SECOND_THOUGHT/);
  assert.ok(!h.frames.some(f=>f.rows.some(row=>row.includes('Bash(FIRST_COMMAND)'))),'a closed run enters as its final summary');
  const nextAt=h.frames.findIndex(f=>f.rows.some(row=>row.includes('SECOND_THOUGHT')));
  assert.ok(h.frames.slice(0,nextAt).some(f=>f.rows.some(row=>row===' ● Ran 1 shell command')));
});
test('a final result replaces an unflushed partial and remains visible while the current call is previewed',async t=>{
  const h=await harness(t),c=call('tail','TAIL_COMMAND');await h.start('Inspect result.',[c]);await h.finish('Inspect result.',[c]);await h.drain(100);
  await h.emit({type:'tool_execution_start',toolCallId:'tail',toolName:'bash',args:c.arguments});
  await h.emit({type:'tool_execution_update',toolCallId:'tail',partialResult:{content:[{type:'text',text:'UNPAINTED_TAIL'}],isError:false}},false);
  await h.emit({type:'tool_execution_end',toolCallId:'tail',result:{content:[{type:'text',text:'FINAL_TAIL'}],isError:false},isError:false},false);
  await h.draw();await h.drain(200);const rows=h.frames.at(-1).rows.join('\n');
  assert.doesNotMatch(rows,/UNPAINTED_TAIL/);assert.match(rows,/Bash\(TAIL_COMMAND\)/);assert.match(rows,/FINAL_TAIL/);
});
test('best-effort result tails cannot freeze a pending Thinking window in a 24-row terminal',async t=>{
  const h=await harness(t,{height:24}),text=Array.from({length:24},(_,i)=>`TAIL_PRESSURE_${i}`).join('\n');
  await h.start(text);await h.finish(text);
  for(let i=0;i<5;i++){
    await h.emit({type:'tool_execution_start',toolCallId:`pressure-${i}`,toolName:'bash',args:{command:`PRESSURE_${i}`}},false);
    await h.emit({type:'tool_execution_update',toolCallId:`pressure-${i}`,partialResult:{content:[{type:'text',text:'TAIL_FIRST\nTAIL_LAST'}],isError:false}},false);
  }
  await h.draw();await h.drain(1600);const fullyDrawn=h.receipts.some(p=>p.text===text&&!p.settled),tails=h.frames.at(-1).rows.join('\n');
  for(let i=0;i<5;i++)await h.emit({type:'tool_execution_end',toolCallId:`pressure-${i}`,result:{content:[],isError:false},isError:false});
  await h.drain(40);assert.ok(fullyDrawn,'result tails must give way to guaranteed Thinking');assert.match(tails,/TAIL_FIRST/,"running result after a complete Thinking fold");assert.match(tails,/TAIL_LAST/);
});
test('running tools publish direct title previews instead of playing multiline call bodies',async t=>{
  const h=await harness(t),command=Array.from({length:20},(_,i)=>`COMMAND_${i}`).join('\n'),c=call('direct',command);
  await h.start('Start a tool.',[c]);await h.finish('Start a tool.',[c]);await h.emit({type:'tool_execution_start',toolCallId:c.id,toolName:c.name,args:c.arguments});
  await h.drain(200);const rows=h.frames.at(-1).rows;assert.equal(rows.filter(row=>row.includes('COMMAND_')).length,1);assert.match(rows.join('\n'),/Bash\(COMMAND_0/);
  await h.f.mode.toggleToolOutputExpansion();await h.draw();await h.drain(200);assert.ok(h.frames.at(-1).rows.filter(row=>row.includes('COMMAND_')).length>8);
});
test('prose after live Thinking waits for the Thinking source to be drawn and stays native',async t=>{
  const h=await harness(t),text=Array.from({length:25},(_,i)=>`LINE_${i}`).join('\n'),message=assistant([{type:'thinking',thinking:text},{type:'text',text:'NATIVE_FINAL_ANSWER'}],'stop');
  await h.emit({type:'message_start',message:assistant([])});await h.emit({type:'message_update',message},false);await h.emit({type:'message_end',message},false);
  assert.doesNotMatch((await h.draw()).join('\n'),/NATIVE_FINAL_ANSWER/);await h.drain();assert.match(h.frames.at(-1).rows.join('\n'),/NATIVE_FINAL_ANSWER/);
  assert.equal(h.receipts.some(p=>p.text===text&&!p.settled),false,'a finished Thinking with a visible successor enters final');assert.equal(h.frames.at(-1).rows.filter(row=>row.includes('NATIVE_FINAL_ANSWER')).length,1);
});
test('official overlay withholds actual receipts and preserves the pending Thinking prefix',async t=>{
  const h=await harness(t),text='overlay '.repeat(150);await h.start(text);await h.step();
  const before=h.receipts.filter(p=>!p.settled&&text.startsWith(p.text)).at(-1).text;
  h.root.showOverlay({render:()=>['OVERLAY'],invalidate(){},handleInput(){}},{width:20,height:3});await h.draw();for(let i=0;i<20;i++)await h.step();
  assert.equal(h.receipts.filter(p=>!p.settled&&text.startsWith(p.text)).at(-1).text,before);
  h.root.hideOverlay();await h.draw();await h.finish(text);await h.drain();assert.ok(h.receipts.some(p=>p.text===text&&!p.settled));
});
test('restored pure Thinking remains a summary and expands full text with Ctrl+O',async t=>{
  const text='COLD_THOUGHT\nUNIQUE_BODY_END',h=await harness(t,{restored:[thought(text)]});
  assert.match((await h.draw()).join('\n'),/COLD_THOUGHT/);
  h.f.mode.toggleToolOutputExpansion();await h.draw();await h.drain(200);assert.ok(h.frames.at(-1).rows.filter(row=>row.includes('UNIQUE_BODY_END')).length>=1);
  h.f.mode.toggleToolOutputExpansion();await h.draw();await h.drain(200);assert.match(h.frames.at(-1).rows.join('\n'),/COLD_THOUGHT/);
});
// Under a burst only the calls that started play; the rest go straight into the summary, so the screen keeps up.
for(const count of [8,60])test('a '+count+'-call burst plays its started calls in order, one open at a time, and catches up',async t=>{
  const h=await harness(t);await h.start('Batch tools.');await h.finish('Batch tools.');await h.drain(100);
  for(let i=0;i<count;i++){
    await h.emit({type:'tool_execution_start',toolCallId:'batch-'+i,toolName:'bash',args:{command:'BATCH_'+i}},false);
    await h.emit({type:'tool_execution_end',toolCallId:'batch-'+i,result:{content:[],isError:false},isError:false},false);
  }
  const done=assistant([{type:'text',text:'BATCH_DONE'}],'stop');await h.emit({type:'message_start',message:done},false);await h.emit({type:'message_end',message:done},false);
  // The same bounded time for 8 and 60 calls: the display lag does not grow with the burst.
  await h.draw();await h.drain(400);
  let prior=-1;const played=[];
  for(let i=0;i<count;i++){
    const at=h.frames.findIndex(f=>f.rows.some(row=>row.includes('Bash(BATCH_'+i+')')));
    if(at<0)continue;assert.ok(at>prior,'call '+i+' plays after its predecessor');prior=at;played.push(i);
  }
  assert.deepEqual(played,[],'an ended run with a visible successor enters directly as its final summary');
  assert.ok(h.frames.every(f=>f.rows.filter(row=>/⎿  Bash\(BATCH_/.test(row)).length<=1));
  assert.match(h.frames.at(-1).rows.join('\n'),new RegExp('Ran '+count+' shell commands'));
  assert.doesNotMatch(h.frames.at(-1).rows.join('\n'),/BATCH_\d/);
  assert.match(h.frames.at(-1).rows.join('\n'),/BATCH_DONE/);
  assert.equal([...h.f.intervals.values()].filter(timer=>timer.owner==='motion').length,0);
});
test('live Thinking keeps its paced window under Ctrl+O and then shows its first eight body rows',async t=>{
  const h=await harness(t),text=Array.from({length:20},(_,i)=>`EXPANDED_THOUGHT_${i}`).join('\n');
  await h.start(text);await h.step();h.f.mode.toggleToolOutputExpansion();await h.draw();
  assert.doesNotMatch(h.frames.at(-1).rows.join('\n'),/EXPANDED_THOUGHT_19/);
  await h.finish(text);await h.drain();assert.ok(h.receipts.some(p=>p.text===text&&!p.settled));
  assert.match(h.frames.at(-1).rows.join('\n'),/EXPANDED_THOUGHT_8\n\s+… \+11 lines/);assert.doesNotMatch(h.frames.at(-1).rows.join('\n'),/EXPANDED_THOUGHT_19/);
});
test('tall native widgets and width changes preserve the pending Thinking source and frozen prefix',async t=>{
  const h=await harness(t,{history:30}),text=Array.from({length:24},(_,i)=>`RESIZE_THOUGHT_${i}`).join('\n');
  await h.draw();const old=h.root.captureRenderState(),frozen=old.previousLines.slice(0,old.previousViewportTop);
  await h.start(text);h.f.context.ui.setWidget('tall',()=>new h.f.Text(Array.from({length:60},(_,i)=>`WIDGET_${i}`).join('\n'),0,0));
  await h.step();await h.f.resize({columns:140});await h.draw();await h.finish(text);await h.drain();
  assert.ok(h.receipts.some(p=>p.text===text&&!p.settled),'widgets cannot consume the Thinking receipt window');
  assert.ok(h.frames.at(-1).rows.some(row=>row.includes('INPUT fixture')));assert.ok(h.frames.at(-1).rows.some(row=>row.includes('context left')));
  h.f.context.ui.setWidget('tall',undefined);await h.draw();await h.drain(40);
  assert.ok(!h.frames.at(-1).rows.some(row=>row.includes('WIDGET_')));
  // Width changes explicitly redraw history; a height-preserving semantic update may not rewrite its frozen bytes.
  const before=h.root.captureRenderState(),prefix=before.previousLines.slice(0,before.previousViewportTop);
  h.f.mode.editor.setText('INPUT changed');h.root.requestRender();await h.draw();
  assert.ok(h.frames.at(-1).rows.some(row=>row.includes('INPUT changed')));assert.deepEqual(h.root.captureRenderState().previousLines.slice(0,prefix.length),prefix);
  assert.ok(frozen.length>0);
});
for(const height of [24,40])test(`shared viewport budget drains two five-tool runs at ${height} rows`,async t=>{
 const h=await harness(t,{height}),first=Array.from({length:24},(_,i)=>`FIRST_${i}`).join('\n');await h.start(first);await h.finish(first);
 for(const segment of ['first','second']){
  if(segment==='second'){await h.emit({type:'message_start',message:assistant([])},false);await h.emit({type:'message_update',message:thought('SECOND_THOUGHT')},false);await h.emit({type:'message_end',message:thought('SECOND_THOUGHT')},false);}
  for(let i=0;i<5;i++){await h.emit({type:'tool_execution_start',toolCallId:`${segment}-${i}`,toolName:'bash',args:{command:`${segment.toUpperCase()}_TOOL_${i}`}},false);await h.emit({type:'tool_execution_end',toolCallId:`${segment}-${i}`,result:{content:[],isError:false},isError:false},false);}
 }
 const done=assistant([{type:'text',text:'NATIVE_DONE'}],'stop');await h.emit({type:'message_start',message:done},false);await h.emit({type:'message_end',message:done},false);await h.draw();await h.drain(2400);
 assert.ok(h.receipts.some(p=>!p.settled&&p.text===first));assert.equal(h.receipts.some(p=>!p.settled&&p.text==='SECOND_THOUGHT'),false);
 // Each run arrived whole and therefore enters directly as its final summary.
 const history=h.root.captureRenderState().previousLines.join('\n');assert.equal(history.split('Ran 5 shell commands').length-1,2);
 assert.doesNotMatch(history,/FIRST_TOOL_4|SECOND_TOOL_4/);
 assert.match(h.frames.at(-1).rows.join('\n'),/NATIVE_DONE/);assert.equal([...h.f.intervals.values()].filter(timer=>timer.owner==='motion').length,0);
});
test('a shorter non-prefix rewrite with a delayed frame starts at its first line and draws every line',async t=>{
 const h=await harness(t,{width:40}),old='OLD '+'x'.repeat(800),next=Array.from({length:25},(_,i)=>`NEW_${i}`).join('\n');await h.start(old);await h.drain(300);assert.ok(h.receipts.some(p=>p.text===old));
 await h.emit({type:'message_update',message:thought(next)},false);await h.draw();const start=h.receipts.length;await h.f.stall(1000);await h.draw();
 const first=h.receipts.slice(start).find(p=>!p.settled&&p.text&&next.startsWith(p.text));assert.ok(first);assert.ok(first.text.length<next.length);assert.ok(first.text.split('\n').length<=2);
 await h.finish(next);await h.drain(400);assert.ok(h.receipts.some(p=>!p.settled&&p.text===next));
 for(let i=0;i<25;i++)assert.ok(h.receipts.some(p=>!p.settled&&p.rows.some(row=>new RegExp(`NEW_${i}$`).test(row))));
});
for(const reason of ['aborted','length','error'])test(`native ${reason} diagnostics and the next answer follow the actually drawn Thinking`,async t=>{
 const h=await harness(t,{height:24}),text=Array.from({length:24},(_,i)=>`LIFECYCLE_${i}`).join('\n');await h.start(text);
 await h.emit({type:'message_end',message:assistant([{type:'thinking',thinking:text}],reason,{errorMessage:'PROVIDER_DIAGNOSTIC'})},false);
 const next=assistant([{type:'text',text:'NEXT_NATIVE_ANSWER'}],'stop');await h.emit({type:'message_start',message:next},false);await h.emit({type:'message_end',message:next},false);
 assert.doesNotMatch((await h.draw()).join('\n'),/NEXT_NATIVE_ANSWER/);await h.drain(800);assert.ok(h.receipts.some(p=>!p.settled&&p.text===text));
 const final=h.frames.at(-1).rows.join('\n');assert.match(final,/NEXT_NATIVE_ANSWER/);assert.match(final,reason==='error'?/PROVIDER_DIAGNOSTIC/:reason==='length'?/truncat/i:/abort/i);
});
test('waiting for a receipt unseals history on a height-only change and resumes its window',async t=>{
 const h=await harness(t,{history:30,height:40}),text=Array.from({length:30},(_,i)=>`HEIGHT_${i}`).join('\n');await h.draw();await h.start(text);await h.step();
 const state=h.f.Container.prototype[Symbol.for('pi-compact-ui2tree/container-render-v1')];let calls=0;
 const caches=[...state.caches].map(ref=>ref.deref()).filter(Boolean);
 assert.ok(caches.some(cache=>cache.sealed),'the test starts with a genuinely sealed prefix');
 const cache=caches.find(cache=>[...cache.gate.flows.values()].some(flow=>flow.text===text)),[id]=[...cache.gate.flows].find(([,flow])=>flow.text===text);
 // Pi draws on its own cadence: advance until a granted line still waits for its receipt.
 for(let i=0;i<40&&cache.gate.flows.get(id).drawn===cache.gate.flows.get(id).shown;i++)await h.f.tick(25);
 const flow=cache.gate.flows.get(id),granted=flow.shown;
 assert.notEqual(flow.drawn,granted,'the resize occurs while an actual receipt is pending');
 for(const current of caches){const original=current.unseal.bind(current);current.unseal=()=>{if(current.sealed)calls++;const result=original();assert.equal(current.sealed,undefined);return result;};}
 await h.f.resize({rows:24});await h.draw();assert.ok(calls>0);assert.equal(cache.gate.flowText(id),granted,'unseal keeps the granted source version');await h.finish(text);await h.drain(800);assert.ok(h.receipts.some(p=>!p.settled&&p.text===text));
});
test('overlay with theme, Ctrl+O and width changes keeps receipts pending until dismissal',async t=>{
 const h=await harness(t),text=Array.from({length:20},(_,i)=>`OVERLAY_CHANGE_${i}`).join('\n');await h.start(text);await h.step();
 h.root.showOverlay({render:()=>['OVERLAY'],invalidate(){},handleInput(){}},{width:20,height:3});await h.draw();const before=h.receipts.length;
 h.f.context.ui.setTheme('light');h.f.mode.toggleToolOutputExpansion();await h.f.resize({columns:140});await h.draw();for(let i=0;i<8;i++)await h.step();assert.equal(h.receipts.length,before);
 h.root.hideOverlay();await h.draw();await h.finish(text);await h.drain(500);assert.ok(h.receipts.some(p=>!p.settled&&p.text===text));h.f.context.ui.setTheme('dark');
});
test('leading blank grants own an actual body row and cannot stall before visible content',async t=>{
 const h=await harness(t,{height:24}),text='\n\n   \nVISIBLE_AFTER_BLANKS\nFINAL_VISIBLE_LINE';await h.start(text);await h.finish(text);await h.drain(300);
 assert.ok(h.receipts.some(p=>!p.settled&&p.text==='\n'&&p.rows.length===1),'the blank prefix has a real visible row receipt');
 assert.ok(h.receipts.some(p=>!p.settled&&p.text===text));assert.equal([...h.f.intervals.values()].filter(timer=>timer.owner==='motion').length,0);
});
