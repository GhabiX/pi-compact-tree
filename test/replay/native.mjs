import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configure,hash,reportPath,writeReport} from './source.mjs';
import {createFixture} from './fixture.mjs';
import {piRoot} from '../pi-host.mjs';
import {ctrlOReprint} from '../support/reprint.mjs';
const arg=(name,fallback)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const width=Number(arg('width','80')),mode=arg('mode','reload');
assert.ok([40,80].includes(width));assert.ok(['reload','control'].includes(mode));
const output=arg('out-dir')?reportPath(`native-${mode}-${width}.json`):undefined;
const source=configure('current');
const extraSources=Object.fromEntries(['core/agent-session.js','core/extensions/runner.js'].map(p=>{const path=join(piRoot,'dist',p);return[path,hash(readFileSync(path))];}));
const f=await createFixture({width,history:12,pluginInitially:mode==='control'});
const root=f.mode.renderer,frames=[],checkpoints=[];
const adapter=()=>f.Container.prototype[Symbol.for('pi-compact-ui2tree/container-render-v1')];
const frame=()=>adapter().rootFrames.get(root);
const plain=rows=>rows.map(f.stripTerminalSequences);
const busy=()=>[...f.intervals.values()].some(t=>t.owner==='motion');
// Code that changes a native component directly asks Pi for a draw, as an extension must.
const changed=()=>root.requestRender();
const passageEnds=new Set(),reprint=ctrlOReprint(),reprintWrites=new Set();
// Pi also draws while the clock advances, so a frame's redraws and writes count from the previous drawn frame.
const lastDrawn={redraws:root.fullRedraws,writes:f.writes.length};
// Scrollback clears since a write index, except those of a permitted Ctrl+O reprint.
const clearsSince=from=>f.writes.slice(from).filter((text,i)=>text.includes('\x1b[3J')&&!reprintWrites.has(from+i)).length;
let clearsFrom=0,component,initial,failure,shutdown,previous,checking=mode==='control',initialRedraws,structuralSamples=0;
// Pi draws on its own schedule: draw runs the frame Pi has scheduled, if any, and checks
// only frames Pi actually drew.
let rendered=false;f.onRender(()=>{rendered=true;});
async function draw(label,{drawn=false}={}){
  await f.frame();const host=root.captureRenderState();
  if(rendered&&reprint({toolsExpanded:f.mode.toolOutputExpanded,redraws:root.fullRedraws-lastDrawn.redraws,coordinator:frame()?.coordinator})){
    previous=undefined;passageEnds.clear();if(initialRedraws!==undefined)initialRedraws++;
    for(let i=lastDrawn.writes;i<f.writes.length;i++)reprintWrites.add(i);
  }
  if(!rendered){assert.ok(!drawn,`${label}: Pi drew a frame for this change`);return host;}
  rendered=false;
  if(checking){
    const footer=plain(f.mode.customFooter.render(width)).at(-1);
    assert.equal(plain(host.previousLines).findLastIndex(row=>row===footer)-host.previousViewportTop,23,'footer pinned');
    assert.ok(host.hardwareCursorRow>=host.previousViewportTop&&host.hardwareCursorRow<host.previousViewportTop+24,'caret visible');
    if(previous)assert.deepEqual(host.previousLines.slice(0,previous.previousViewportTop),previous.previousLines.slice(0,previous.previousViewportTop),'frozen prefix');
    // Blocks entering together form a passage, each starting where the one above ends; a passage
    // longer than a bar is fitted into one bar, so only its ends sit on the sixteenth grid.
    const moving=(frame().coordinator.render().owners[0].blocks??[]).filter(block=>block.deadlineAt!==undefined);
    // A block above may already have finished, so its end is remembered across frames.
    const starts=new Set(moving.map(block=>block.startedAt));for(const block of moving)passageEnds.add(block.deadlineAt);
    for(const block of moving){
      const duration=block.deadlineAt-block.startedAt;assert.ok(duration>0&&duration<=2400);
      if(!passageEnds.has(block.startedAt))assert.equal(block.startedAt%150,0,'passage starts on the grid');
      if(!starts.has(block.deadlineAt))assert.equal(block.deadlineAt%150,0,'passage ends on the grid');
      structuralSamples++;
    }
  }
  initialRedraws??=root.fullRedraws;assert.equal(root.fullRedraws,initialRedraws,'no extra ordinary full redraw');
  previous=host;lastDrawn.redraws=root.fullRedraws;lastDrawn.writes=f.writes.length;frames.push({label,atMs:f.now,V:host.previousViewportTop,height:host.previousLines.length,hash:hash(host.previousLines),cursor:host.hardwareCursorRow-host.previousViewportTop});return host;
}
async function settle(label){await draw(label);for(let i=0;busy()&&i<1000;i++){await f.tick();await draw(label);}assert.equal(busy(),false,'motion idle');}
// Visibility is judged where it is observable: the plugin's target, its publication and the host screen.
function layers(){return {target:plain(frame().target.blocks.flatMap(b=>b.rows)),publication:plain(frame().coordinator.render().owners.flatMap(o=>o.blocks.flatMap(b=>b.rows))),host:plain(root.captureRenderState().previousLines)};}
function checkMarkers(label,markers,count=1){
  const rows=layers();
  const result=Object.fromEntries(markers.map(marker=>[marker,Object.fromEntries(Object.entries(rows).map(([name,list])=>[name,list.filter(row=>row.includes(marker)).length]))]));
  for(const [marker,counts]of Object.entries(result))for(const[name,value]of Object.entries(counts))assert.equal(value,count,`${label} ${name} ${marker} unique visibility`);
  checkpoints.push({label,source:component&&f.stripTerminalSequences(component.text),sameStatusObject:f.mode.lastStatusText===component,markers:result,layerHashes:Object.fromEntries(Object.entries(rows).map(([name,list])=>[name,hash(list)]))});
}
async function updateStatus(text,label){f.mode.showStatus(text);assert.equal(f.mode.lastStatusText,component,'same native Text');await settle(label);checkMarkers(label,text.split('\n'));}
// A draw right after a deliberate change observes that change, so Pi must have drawn a frame.
const shown=label=>draw(label,{drawn:true});
async function emit(event){await f.emit(event);await draw(event.type);}
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=content=>({role:'assistant',content,stopReason:'stop',timestamp:2,model:'fixture-model',provider:'fixture',api:'openai-responses',usage});
try{
  if(mode==='reload'){
    // Only disk/resource loading is isolated. The real CLI method owns rebuild,
    // showStatus and the awaited post-session-start completion update.
    // Pi turns an error in reload into a "Reload failed" status, so the hook keeps its own
    // failure and rethrows it once the command returns.
    let hookFailure;
    f.session.reload=async({beforeSessionStart})=>{try{
      // The flag belongs to Pi's reload-box frame, which is not checked.
      rendered=false;
      await beforeSessionStart();f.context.ui.setToolsExpanded(true);component=f.mode.lastStatusText;
      const host=await shown('earlier-session-start-native-draw');
      const index=plain(host.previousLines).findIndex(row=>row.includes('Tool output: expanded'));
      assert.ok(host.previousViewportTop>0);assert.ok(index>=host.previousViewportTop,'source entirely addressable');
      initial={V:host.previousViewportTop,index,source:f.stripTerminalSequences(component.text)};
      const redrawsBefore=root.fullRedraws;clearsFrom=f.writes.length;
      await f.handlers.get('session_start')({type:'session_start',reason:'reload'},f.context);
      // A replacement session_start reprints the document exactly once (as in stream.mjs);
      // the reprint starts a new frozen prefix and new passages.
      initialRedraws=redrawsBefore+1;previous=undefined;passageEnds.clear();
      checking=true;await settle('later-session-start-plugin-draw');checkMarkers('adopted-status',['Tool output: expanded']);
    }catch(error){hookFailure=error;throw error;}};
    assert.equal(f.session.isStreaming,false);await f.mode.handleReloadCommand();if(hookFailure)throw hookFailure;await settle('reload-return');
    // The plugin's reprint clears scrollback once; from here on nothing clears it.
    assert.equal(clearsSince(clearsFrom),1,'session replacement clears scrollback once');
    clearsFrom=f.writes.length;
    assert.equal(f.mode.lastStatusText,component);assert.ok(f.stripTerminalSequences(component.text).startsWith('Reloaded keybindings'));
    checkMarkers('reload-completed',['Reloaded keybindings']);
  }else{
    f.mode.showStatus('CONTROL_NATIVE_INITIAL');component=f.mode.lastStatusText;const host=await shown('native-control');
    const index=plain(host.previousLines).findIndex(row=>row.includes('CONTROL_NATIVE_INITIAL'));assert.ok(index>=host.previousViewportTop);
    initial={V:host.previousViewportTop,index,source:f.stripTerminalSequences(component.text)};await settle('control-ready');
  }
  if(mode==='control'){f.context.ui.setToolsExpanded(true);await settle('control-tool-expanded');}
  f.context.ui.setToolsExpanded(false);await settle('ctrl-o-collapsed');await f.tick(1000);await draw('idle-one-second');
  assert.equal(f.mode.lastStatusText,component);checkMarkers('ctrl-o-updated',['Tool output: collapsed']);
  const held=frame().coordinator.render(),heldHash=hash(held);
  await updateStatus('NATIVE_GROW_A\nNATIVE_GROW_B\nNATIVE_GROW_C','same-object-grow');
  await updateStatus('NATIVE_SHRINK','same-object-shrink');await updateStatus('NATIVE_AGAIN','same-object-again');
  assert.equal(hash(held),heldHash,'held public snapshot is detached');
  const twin=new f.Text('NATIVE_AGAIN',0,0);assert.notEqual(twin,component);f.mode.chatContainer.addChild(twin);changed();await settle('identical-text-new-component');checkMarkers('independent-identical-components',['NATIVE_AGAIN'],2);
  component.setText('NATIVE_DISTINCT_UPDATED');changed();await settle('first-identity-only');checkMarkers('first-identity-only',['NATIVE_DISTINCT_UPDATED']);checkMarkers('other-identity-retains-text',['NATIVE_AGAIN']);
  // Actual CustomEntry Ctrl+O rebuilds a nested native renderer after adoption.
  let customPhase='BEFORE';
  f.session.extensionRunner.getEntryRenderer=type=>type==='replay-native'?(entry,{expanded})=>{
    const nested=new f.Container();nested.addChild(new f.Text(`CUSTOM_${customPhase}`,0,0));
    if(expanded)nested.addChild(new f.Text(`CUSTOM_EXTRA_${customPhase}`,0,0));return nested;
  }:undefined;
  f.mode.addCustomEntryToChat({customType:'replay-native',data:{},id:'replay-custom',type:'custom',timestamp:2,parentId:null});changed();
  await settle('custom-native-created');checkMarkers('custom-native-created',['CUSTOM_BEFORE']);
  customPhase='EXPANDED';f.mode.setToolsExpanded(true);await settle('custom-dynamic-expand');
  checkMarkers('custom-dynamic-expand',['CUSTOM_EXPANDED','CUSTOM_EXTRA_EXPANDED']);
  customPhase='SHRUNK';f.mode.setToolsExpanded(false);await settle('custom-dynamic-shrink');
  checkMarkers('custom-dynamic-shrink',['CUSTOM_SHRUNK']);
  for(const rows of Object.values(layers()))assert.equal(rows.some(row=>row.includes('CUSTOM_EXTRA_')),false);
  await emit({type:'message_start',message:{role:'user',content:[{type:'text',text:'FRESH_USER_ACCEPTANCE'}],timestamp:2}});
  await emit({type:'message_start',message:assistant([])});
  const message=assistant([{type:'thinking',thinking:'FRESH_THINK_ACCEPTANCE\nSeparate source remains admitted.'}]);
  await emit({type:'message_update',message});await emit({type:'message_end',message});await settle('fresh-input-idle');
  checkMarkers('new-user-and-thinking',['FRESH_USER_ACCEPTANCE','FRESH_THINK_ACCEPTANCE']);
  // Public native-container changes advance the actual host boundary; after
  // that, the old component cannot rewrite already printed scrollback.
  f.mode.chatContainer.addChild(new f.Text(Array.from({length:30},(_,i)=>`HISTORY_ADVANCE_${i}`).join('\n'),0,0));
  const live=new f.Text('OTHER_LIVE_BEFORE',0,0);f.mode.chatContainer.addChild(live);changed();await settle('advance-boundary');
  const before=root.captureRenderState(),oldIndex=plain(before.previousLines).findIndex(row=>row.includes('NATIVE_DISTINCT_UPDATED'));
  assert.ok(oldIndex>=0&&oldIndex<before.previousViewportTop,'old status is now actually frozen');
  component.setText('FROZEN_SOURCE_LATE_UPDATE');live.setText('OTHER_LIVE_AFTER');changed();await settle('late-frozen-and-live-update');
  assert.deepEqual(root.captureRenderState().previousLines.slice(0,before.previousViewportTop),before.previousLines.slice(0,before.previousViewportTop),'crossed source bytes preserved');
  checkMarkers('independent-live-after-frozen-update',['OTHER_LIVE_AFTER']);
  assert.equal(clearsSince(clearsFrom),0,'no scrollback clear');assert.equal(busy(),false);
}catch(error){failure={message:error.message,stack:error.stack};}
finally{await f.handlers.get('session_shutdown')?.({type:'session_shutdown'},f.context);shutdown=f.close();source.verify();}
for(const[path,sha]of Object.entries(extraSources))assert.equal(hash(readFileSync(path)),sha,path);
const summary={mode,width,draws:frames.length,structuralSamples,passed:!failure&&shutdown.remainingTimers===0,timers:shutdown.remainingTimers,fullRedraws:root.fullRedraws,clearScrollback:f.writes.filter(text=>text.includes('\x1b[3J')).length,failure};
if(output)writeReport(output,{summary,initial,checkpoints,frames,source:source.info,extraSources,probeSha:hash(readFileSync(fileURLToPath(import.meta.url))),isolation:[...f.isolation,'AgentSession.reload disk/resource effects replaced with beforeSessionStart and sequential awaited extension handlers; actual InteractiveMode.handleReloadCommand/rebuildChatFromMessages/showStatus remain unchanged','No CLI streaming reload, disk restore, or performance claim']});
console.log(JSON.stringify(summary));if(!summary.passed)process.exitCode=1;
