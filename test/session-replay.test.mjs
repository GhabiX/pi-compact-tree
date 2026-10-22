import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {configure} from './replay/source.mjs';
const source=configure();const {createFixture}=await import('./replay/fixture.mjs');
after(()=>{source.verify();source.hook.deregister();});
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=(content,stopReason='toolUse',extra={})=>({role:'assistant',api:'openai-responses',provider:'fixture',model:'fixture-model',content,stopReason,timestamp:1,usage,...extra});
for(const width of [80,140])test(`one tool per request folds into flat runs separated by Thinking at ${width}`,async t=>{
 const f=await createFixture({width,height:40});t.after(()=>assert.equal(f.close().remainingTimers,0));const root=f.mode.renderer;
 // Pi draws on its own schedule: draw runs the frame it has scheduled, the test never draws itself.
 const draw=()=>f.frame(),drain=async()=>{for(let i=0;i<150;i++)await f.tick();await f.frame();};
 await f.emit({type:'agent_start'});
 for(let i=0;i<9;i++){
  const thinking=i===0?'Analyze files.':i===7?'Run final checks.':undefined,content=thinking?[{type:'thinking',thinking}]:[],name=i<3?'read':'bash',id=`call-${i}`,args=name==='read'?{path:`fixture/${i}.md`}:{command:`printf ${i}`};
  const m=assistant([...content,{type:'toolCall',id,name,arguments:args}]);
  await f.emit({type:'message_start',message:assistant([])});await f.emit({type:'message_update',message:m});await f.emit({type:'message_end',message:m});await draw();await drain();
  await f.emit({type:'tool_execution_start',toolCallId:id,toolName:name,args});await draw();
  await f.emit({type:'tool_execution_end',toolCallId:id,result:{content:[],isError:false},isError:false});await draw();await drain();
 }
 const m=assistant([{type:'text',text:'NATIVE_DONE'}],'stop');await f.emit({type:'message_start',message:m});await f.emit({type:'message_end',message:m});await draw();await drain();
 const rows=root.captureRenderState().previousLines.map(f.stripTerminalSequences);
 assert.equal(rows.filter(row=>/● Analyze files/.test(row)).length,1);
 assert.equal(rows.filter(row=>/● Run final checks/.test(row)).length,1);
 assert.equal(rows.filter(row=>/⎿  (Read|Bash)\(/.test(row)).length,0,'all terminal calls fold before prose');
 assert.equal(rows.filter(row=>/Read 3 files, ran 4 shell commands/.test(row)).length,1);
 assert.equal(rows.filter(row=>/Ran 2 shell commands/.test(row)).length,1);
 assert.equal(rows.filter(row=>row.includes('NATIVE_DONE')).length,1);
});
for(const width of [80,140])test(`three provider failures remain independent diagnostic items at ${width}`,async t=>{
 const f=await createFixture({width,height:40});t.after(()=>assert.equal(f.close().remainingTimers,0));const root=f.mode.renderer;
 for(let i=0;i<3;i++){const m=assistant([],'error',{errorMessage:'fetch failed'});await f.emit({type:'message_start',message:m});await f.emit({type:'message_end',message:m});await f.frame();}
 const m=assistant([{type:'text',text:'FINAL_REPLY'}],'stop');await f.emit({type:'message_start',message:m});await f.emit({type:'message_end',message:m});
 for(let i=0;i<400;i++)await f.tick();await f.frame();
 const rows=root.captureRenderState().previousLines.map(f.stripTerminalSequences);assert.equal(rows.filter(row=>/Provider errors/.test(row)).length,0);
 assert.equal(rows.filter(row=>/● Error: fetch failed/.test(row)).length,3);assert.equal(rows.filter(row=>row.includes('FINAL_REPLY')).length,1);
});
