import assert from 'node:assert/strict';
import {configure, hash, reportPath, writeReport} from './source.mjs';
import {createFixture} from './fixture.mjs';
import {ctrlOReprint} from '../support/reprint.mjs';
const arg=(key,fallback)=>process.argv.find(v=>v.startsWith(`--${key}=`))?.slice(key.length+3) ?? fallback;
const scenario=arg('scenario','short'), width=Number(arg('width','80'));
const speed=Number(arg('speed','0')), tty=process.argv.includes('--tty');
const termux=process.argv.includes('--termux');
assert.ok(['short','history','adoption','perf'].includes(scenario));
assert.ok([40,80].includes(width));assert.ok(Number.isFinite(speed)&&speed>=0);
if(termux)process.env.TERMUX_VERSION='fixture';
if(tty){assert.ok(process.stdout.isTTY,'actual PTY required');assert.equal(process.stdout.columns,width);assert.equal(process.stdout.rows,24);}
// Without --out-dir (npm test) the run only prints its summary; evidence runs keep the full report in --out-dir.
const output=arg('out-dir')?reportPath(`stream-${scenario}-${width}${termux?'-termux':''}${tty?'-tty':''}.json`):undefined;
const sources=configure();
const rounds=Number(arg('rounds',scenario==='history'?'12':'3'));
const history=Number(arg('history',scenario==='history'||scenario==='adoption'?'24':scenario==='perf'?'1000':'0'));
const lifecycle=arg('lifecycle',scenario==='perf'?'false':'true')==='true';
assert.ok(Number.isInteger(rounds)&&rounds>0&&rounds<=30);
const realNow=()=>Number(process.hrtime.bigint())/1e6;
const origin=realNow();
const f=await createFixture({width,history,tty,pluginInitially:scenario!=='adoption'});
const playbackOrigin=realNow();
const {mode,terminal,stripTerminalSequences:strip}=f;
const root=mode.renderer;
const adapter=()=>f.Container.prototype[Symbol.for('pi-compact-ui2tree/container-render-v1')];
const frame=()=>adapter().rootFrames.get(root);
const plain=rows=>rows.map(strip);
const phases=[],samples=[],checkpoints=[],events=[],preparations=[],callbackTimes=[],hostGaps=[];
const native=new Map(),wrapped=new WeakSet();
let previous=root.captureRenderState(),previousSample,latestRows=[],nativeFooter=[],footerExtra=0,lastWall,event='setup';
let fullWrites=0, failure, shutdown, skipChecks=scenario==='adoption';
const reprinted=ctrlOReprint();
// Pi also draws while the clock advances, so a frame's redraws and writes count from the previous checked frame.
let beforeClears=root.fullRedraws,beforeWrites=f.writes.length;
function instrument(){
  for(const region of root.children.slice(1)){
    if(wrapped.has(region))continue;wrapped.add(region);
    const render=region.render.bind(region);
    region.render=w=>{const rows=render(w);native.set(region,rows.slice());return rows;};
  }
  const footer=mode.customFooter??mode.footer;
  if(!wrapped.has(footer)){
    wrapped.add(footer);const render=footer.render.bind(footer);
    footer.render=w=>{const rows=[...render(w),...Array.from({length:footerExtra},(_,i)=>`footer continuation ${i+1}`)];nativeFooter=plain(rows);return rows;};
  }
}
instrument();
const render=root.render.bind(root);
let rendered=false;
root.render=w=>{const start=realNow();const rows=render(w);const duration=realNow()-start;preparations.push(duration);latestRows=rows.slice();rendered=true;return rows;};
// While an assistant message is still streaming (before message_end), its active
// marker breathes on the shared clock; playback/rest/structural motion still must
// drain to idle, and once the stream ends the motion timer itself must stop.
const motionTimers=()=>{
  const count=[...f.intervals.values()].filter(t=>t.owner==='motion').length;
  if(!count||!mode.streamingComponent?.isStreaming)return count;
  const caches=[...(adapter()?.caches??[])].map(r=>r.deref()).filter(Boolean);
  return frame()?.coordinator.hasPending||caches.some(c=>(Number.isFinite(c.restDeadline)&&f.now<c.restDeadline)||[...c.gate.flows.values()].some(v=>v.drawn!==v.text)||c.blocks?.some(b=>b.paint?.some(s=>s.settled)))?count:0;
};
// Pi draws on its own schedule: draw runs the frame Pi has scheduled, if any, and samples
// only frames Pi actually drew.
async function draw(label,{drawn=false}={}){
  event=label;instrument();
  await f.frame();
  if(!rendered){assert.ok(!drawn,`${label}: Pi drew a frame for this change`);return previousSample;}
  rendered=false;
  const wall=realNow();if(lastWall!==undefined)hostGaps.push(wall-lastWall);lastWall=wall;
  const host=root.captureRenderState(), clean=plain(host.previousLines), presented=plain(latestRows);
  const footerLast=nativeFooter.at(-1);
  const footerAbs=presented.findLastIndex(v=>v===footerLast), actualFooterAbs=clean.findLastIndex(v=>v===footerLast);
  const marker=latestRows.findIndex(row=>row.includes(f.CURSOR_MARKER));
  // Production deliberately invokes native Container.render directly for live bottom regions.
  // Read its actual child-height cache instead of an instance wrapper that is bypassed.
  const nativeRegionHeights=root.children.slice(1).map(region=>{
    assert.ok(region.mouseLayout?.children,'native region must have actual render layout');
    return region.mouseLayout.children.reduce((n,child)=>n+child.height,0);
  });
  const bottomHeight=nativeRegionHeights.reduce((n,height)=>n+height,0),bottomGeometryHash=hash(nativeRegionHeights);
  const sameGeometry=previous&&previous.previousWidth===host.previousWidth&&previous.previousHeight===host.previousHeight;
  const reprint=reprinted({toolsExpanded:mode.toolOutputExpanded,redraws:root.fullRedraws-beforeClears,coordinator:frame().coordinator});
  const frozenStable=reprint||!sameGeometry||hash(host.previousLines.slice(0,previous.previousViewportTop))===hash(previous.previousLines.slice(0,previous.previousViewportTop));
  const pub=frame()?.coordinator.render();
  for(const block of pub?.owners[0]?.blocks??[])if(block.phase==='transition'){
    const duration=block.deadlineAt-block.startedAt;assert.equal(duration%150,0);assert.ok(duration>=150&&duration<=2400);assert.equal(block.startedAt%150,0);
    phases.push({now:f.now,id:block.id,start:block.startedAt,deadline:block.deadlineAt,progress:block.progress});
  }
  const sample={event:label,atMs:f.now,wallMs:wall-origin,H:terminal.rows,width:terminal.columns,V:host.previousViewportTop,
    footerAbs,footerPhysical:footerAbs-host.previousViewportTop,actualFooterPhysical:actualFooterAbs<0?null:actualFooterAbs-host.previousViewportTop,
    footerRows:nativeFooter.length,nativeBottomHeight:bottomHeight,nativeRegionHeights,bottomGeometryHash,caretPhysical:marker<0?null:marker-host.previousViewportTop,
    hardwareCaretPhysical:host.hardwareCursorRow-host.previousViewportTop,inputPhysical:presented.findIndex(row=>row.includes('INPUT fixture'))-host.previousViewportTop,
    overlay:root.hasOverlay(),sameGeometry:Boolean(sameGeometry),frozenStable,redraws:root.fullRedraws,newRedraws:root.fullRedraws-beforeClears,
    clearScrollback:f.writes.slice(beforeWrites).filter(s=>s.includes('\x1b[3J')).length,hostHash:hash(host.previousLines),rowsHash:hash(latestRows),
    publicationHash:pub?hash({rows:pub.rows,owners:pub.owners,rootRevision:pub.rootRevision}):null,
    editorTextHash:hash(mode.editor.getText()),pending:frame()?.coordinator.hasPending??false};
  samples.push(sample);
  if(!skipChecks){
    {
      assert.ok(frozenStable,`${label}: frozen normalized prefix`);
      assert.equal(sample.footerPhysical,terminal.rows-1,`${label}: footer bottom`);
      assert.ok(sample.caretPhysical!==null&&sample.caretPhysical>=0&&sample.caretPhysical<terminal.rows,`${label}: caret marker remains addressable`);
      if(!sample.overlay)assert.equal(sample.actualFooterPhysical,terminal.rows-1,`${label}: actual host footer bottom`);
      if(previousSample&&sameGeometry&&!sample.overlay&&!previousSample.overlay&&sample.bottomGeometryHash===previousSample.bottomGeometryHash&&sample.editorTextHash===previousSample.editorTextHash){
        assert.equal(sample.caretPhysical,previousSample.caretPhysical,`${label}: same editor and native region geometry keep caret fixed`);
      }
    }
    if(label==='reload')assert.equal(sample.newRedraws,1,'reload: session replacement requests one cleared full redraw');
    else if(!label.startsWith('resize-')&&!label.startsWith('tiny-')&&sameGeometry)assert.equal(sample.newRedraws,reprint?1:0,`${label}: ordinary update adds no full redraw`);
  }
  previous=host;previousSample=sample;fullWrites+=f.writes.length-beforeWrites;beforeClears=root.fullRedraws;beforeWrites=f.writes.length;
  return sample;
}
async function tick(label){
  if(speed>0){const delay=Math.max(0,(f.now+25)/speed-(realNow()-playbackOrigin));if(delay)await new Promise(resolve=>setTimeout(resolve,delay));}
  const elapsed=speed>0?Math.max(25,(realNow()-playbackOrigin)*speed-f.now):25;
  const start=realNow(), count=await f.tick(elapsed);if(count)callbackTimes.push(realNow()-start);
  await draw(label);
}
async function advance(ms,label){for(let n=0;n<ms;n+=25)await tick(label);}
async function settle(label){await draw(label);for(let n=0;motionTimers()&&n<1200;n++)await tick(label);assert.equal(motionTimers(),0,`${label}: bounded natural idle`);assert.equal(frame()?.coordinator.hasPending??false,false,`${label}: no structural pending`);}
// A draw right after a deliberate change observes that change, so Pi must have drawn a frame.
const shown=label=>draw(label,{drawn:true});
async function emit(e){events.push({event:e.type,atMs:f.now,messageRole:e.message?.role});await f.emit(e);await draw(e.type);}
const usage={input:100,output:30,cacheRead:0,cacheWrite:0,totalTokens:130,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=(content,stopReason='stop')=>({role:'assistant',api:'openai-responses',provider:'fixture',model:'fixture-model',content,stopReason,timestamp:1,usage});
async function user(text){const message={role:'user',content:[{type:'text',text}],timestamp:Date.now()};await emit({type:'message_start',message});await emit({type:'message_end',message});}
async function round(n){
  const marker=`R${n}_THOUGHT_UNIQUE`,toolMarker=`R${n}_TOOL_UNIQUE`,body=`${marker}\nInspect the current result.\nChoose next operation.\nPreserve original data.`;
  await emit({type:'message_start',message:assistant([])});
  await emit({type:'message_update',message:assistant([{type:'thinking',thinking:body.slice(0,30)}])});await advance(75,'thinking-stream');
  await emit({type:'message_update',message:assistant([{type:'thinking',thinking:body}])});await settle('thinking-settle');
  const atThinking=plain(root.captureRenderState().previousLines).join('\n');
  assert.ok(atThinking.includes(marker),`R${n} fresh thinking reaches actual host`);
  const call={type:'toolCall',id:`call-${n}`,name:'bash',arguments:{command:`printf ${toolMarker}`}};
  const message=assistant([{type:'thinking',thinking:body},call],'toolUse');
  await emit({type:'message_update',message});await advance(75,'tool-args');await emit({type:'message_end',message});
  assert.ok(mode.pendingTools.get(call.id),'real message_update creates actual tool component');
  await emit({type:'tool_execution_start',toolCallId:call.id,toolName:'bash',args:call.arguments});await advance(75,'tool-running');
  await emit({type:'tool_execution_update',toolCallId:call.id,partialResult:{content:[{type:'text',text:`${toolMarker} partial`}]}});await advance(75,'tool-stream');
  const result={content:[{type:'text',text:`${toolMarker}\nresult two\nresult three`}],isError:false};
  await emit({type:'tool_execution_end',toolCallId:call.id,result,isError:false});await settle('tool-settle');
  assert.ok(plain(root.captureRenderState().previousLines).join('\n').includes(toolMarker),`R${n} tool reaches actual host`);
  checkpoints.push({round:n,atMs:f.now,V:root.captureRenderState().previousViewportTop,thinkingVisible:true,toolVisible:true});
}
try{
  await draw('initial');
  if(scenario==='adoption'){
    assert.ok(root.captureRenderState().previousViewportTop>0,'real native initial messages cross viewport');
    await f.activate();instrument();skipChecks=false;await shown('adoption');await settle('adoption-settle');
  }
  await user('USER: investigate and continue through the tool results.');
  await emit({type:'agent_start'});await emit({type:'turn_start'});
  for(let n=1;n<=rounds;n++)await round(n);
  await emit({type:'agent_end',messages:[]});await settle('agent-end-settle');
  await user('NEXT USER: independent request.');await settle('new-user-fold');
  mode.toggleToolOutputExpansion();await shown('ctrl-o-expand');await settle('expand');
  mode.toggleToolOutputExpansion();await shown('ctrl-o-collapse');await settle('collapse');
  if(lifecycle){
    mode.editor.setText('INPUT fixture\nline two\nline three');root.requestRender();await shown('multiline');await settle('multiline-settle');
    mode.setExtensionWidget('probe-above',['ABOVE fixture','Second widget line'],{placement:'aboveEditor'});await shown('widget-above');
    mode.setExtensionWidget('probe-below',['BELOW fixture'],{placement:'belowEditor'});await shown('widget-below');
    // Pi's footer data provider asks for a draw when its data changes.
    footerExtra=1;root.requestRender();await shown('footer-grow');footerExtra=0;root.requestRender();await shown('footer-shrink');
    mode.editor.setAutocompleteProvider({triggerCharacters:['@'],getSuggestions:async()=>({prefix:'/fixture',items:Array.from({length:8},(_,i)=>({value:`/fixture${i}`,label:`/fixture${i}`,description:'fixture command'}))}),applyCompletion(){throw Error('completion selection not used');}});
    mode.editor.setText('/fixture');mode.editor.handleInput('\t');await mode.editor.autocompleteRequestTask;
    assert.ok(mode.editor.autocompleteState,'real native autocomplete menu is open');await shown('autocomplete');
    mode.editor.handleInput('\x1b');mode.editor.setText('INPUT fixture');root.requestRender();await shown('autocomplete-dismiss');
    mode.clearExtensionWidgets();await shown('widgets-dismiss');
    await f.resize({rows:40});await shown('resize-height-grow');await settle('resize-height-grow-settle');
    await f.resize({rows:24});await shown('resize-height-shrink');await settle('resize-height-shrink-settle');
    await f.resize({columns:width===80?40:80});await shown('resize-width');await settle('resize-width-settle');
    await f.resize({columns:width});await shown('resize-width-restore');await settle('resize-width-restore-settle');
    mode.toggleToolOutputExpansion();await shown('overlay-before');await advance(100,'overlay-quarter');
    const overlay=mode.ui.showOverlay(new f.Text('OVERLAY fixture',0,0),{width:20,anchor:'center',nonCapturing:true});
    await shown('overlay-open');await advance(100,'overlay-hold');overlay.hide();await shown('overlay-dismiss');await settle('overlay-resume');
    // Session replacement (/reload) clears the screen and reprints the document, starting a new frozen prefix.
    await f.reload();instrument();previous=undefined;await shown('reload');await settle('reload-settle');
    await user('POST RELOAD USER');await round(100);
    mode.setExtensionWidget('tall-above',Array.from({length:10},(_,i)=>`Tall above ${i}`),{placement:'aboveEditor'});
    mode.setExtensionWidget('tall-below',Array.from({length:10},(_,i)=>`Tall below ${i}`),{placement:'belowEditor'});
    mode.editor.setText('INPUT fixture\nline two\nline three\nline four\nline five');root.requestRender();await shown('tall-bottom');
    await f.resize({rows:6});await shown('tiny-height-six');await settle('tiny-six-settle');
    await f.resize({rows:2});await shown('tiny-height-two');await settle('tiny-two-settle');
    await f.resize({rows:24});mode.clearExtensionWidgets();mode.editor.setText('INPUT fixture');root.requestRender();await shown('resize-restore');await settle('restore-settle');
    await user('POST RESTORE USER');await settle('post-restore-fold');
  }
  await advance(100,'idle');
}catch(error){failure={event,atMs:f.now,name:error.name,message:error.message,stack:error.stack};}
finally{shutdown=f.close();sources.verify();}
function stats(a){const s=a.toSorted((a,b)=>a-b);return{count:s.length,median:s.length?s[Math.floor(s.length*.5)]:null,p95:s.length?s[Math.min(s.length-1,Math.floor(s.length*.95))]:null,max:s.at(-1)??null};}
const summary={scenario,width,rounds,history,termux,tty,speed,lifecycle,frames:samples.length,checkpointCount:checkpoints.length,
  allBottomPinned:samples.every(s=>s.footerPhysical===s.H-1),frozenPrefixStable:samples.every(s=>s.frozenStable),
  cursorAlwaysVisible:samples.every(s=>s.caretPhysical!==null&&s.caretPhysical>=0&&s.caretPhysical<s.H),
  fullRedraws:root.fullRedraws,clearScrollback:f.writes.filter(v=>v.includes('\x1b[3J')).length,fullWrites,
  transitions:phases.length,uniqueTransactions:new Set(phases.map(v=>`${v.id}:${v.start}:${v.deadline}`)).size,
  timersAfterShutdown:shutdown.remainingTimers,failure,
  metrics:{rootPrepareMs:stats(preparations),activeCallbackMs:stats(callbackTimes),hostDrawGapMs:stats(hostGaps),coldInitMs:samples[0]?.wallMs},
  functionalPassed:!failure&&shutdown.remainingTimers===0};

if(output)writeReport(output,{summary,sources:sources.info,fixture:{isolation:f.isolation,proxyDistinct:true,realConstructorAndInit:true},events,checkpoints,frames:samples,transactions:phases});
const result=JSON.stringify({output,summary});if(tty)process.stderr.write('\n'+result+'\n');else console.log(result);
if(failure||shutdown.remainingTimers!==0)process.exitCode=1;
