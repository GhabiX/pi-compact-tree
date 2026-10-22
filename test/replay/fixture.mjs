import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piRoot, pluginRoot } from '../pi-host.mjs';

/** Real InteractiveMode constructor/init; only external session/runtime effects are fixtures. */
export async function createFixture({width=80, height=24, tty=false, history=0, restored=[], pluginInitially=true, installExtension, settings={}}={}) {
  process.env.PI_OFFLINE = '1';
  const installed = p => import(pathToFileURL(join(piRoot, 'dist', p)).href);
  const {InteractiveMode} = await installed('modes/interactive/interactive-mode.js');
  const {SettingsManager} = await installed('core/settings-manager.js');
  const {SessionManager} = await installed('core/session-manager.js');
  const theme = await installed('modes/interactive/theme/theme.js');
  const {Container, Text, stripTerminalSequences, CURSOR_MARKER} = await import('@earendil-works/pi-tui');
  const install = installExtension ?? (await import('../../extensions/compact-ui2tree.ts')).default;
  const motion = await import('../../extensions/motion.ts');
  let now=0, timerId=0, pluginEnabled=pluginInitially, context, eventSink, startReason='startup';
  const intervals = new Map(), timeouts = new Map(), writes=[];
  const originalInterval=globalThis.setInterval, originalClear=globalThis.clearInterval, originalFetch=globalThis.fetch;
  const originalTimeout=globalThis.setTimeout, originalClearTimeout=globalThis.clearTimeout;
  const originalNow = performance.now, originalDateNow = Date.now;
  // Both clocks Pi and the plugin read run on fixture time; wall time never reaches a frame.
  const epoch = Date.UTC(2026, 0, 1);
  performance.now=()=>now;Date.now=()=>epoch+now;
  globalThis.setInterval=(callback, delay)=>{const id=++timerId;const owner=/\/extensions\/motion\.ts(?:[?:])/.test(new Error().stack)?'motion':'native';intervals.set(id,{id,callback,delay:Math.max(1,delay),due:now+Math.max(1,delay),owner}); return id;};
  globalThis.clearInterval=id=>intervals.delete(id);
  // Pi's render throttle runs on the same clock: requestRender is Pi's own, so a frame
  // is drawn when and as often as Pi would draw it. Other timeouts (the terminal colour
  // query at init, which no fixture terminal answers) stay real.
  globalThis.setTimeout=(callback, delay=0, ...args)=>{
    if(!/\.scheduleRender \(.*\/pi-tui\/dist\/tui\.js/.test(new Error().stack))return originalTimeout(callback, delay, ...args);
    const id=++timerId;timeouts.set(id,{id,callback:()=>callback(...args),due:now+Math.max(0,delay)});return id;};
  globalThis.clearTimeout=id=>typeof id==='number'?timeouts.delete(id):originalClearTimeout(id);
  // Lets Pi's process.nextTick render scheduling run, as the event loop would.
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  globalThis.fetch=async()=>{throw new Error('network access forbidden by fixture');};
  const terminal={columns:width,rows:height,write(value){writes.push(value); if(tty)process.stdout.write(value);},
    start(input,resize){this.input=input;this.resize=resize;},stop(){},hideCursor(){if(tty)this.write('\x1b[?25l');},showCursor(){if(tty)this.write('\x1b[?25h');},setTitle(){},setProgress(){},setProgramStatus(){},setTerminalColorSchemeNotifications(){}};
  // Pi's defaults: the plugin must be right with no configuration. Only the theme is fixed
  // (Pi would ask the terminal for its background).
  const settingsManager=SettingsManager.inMemory({theme:'dark',installTelemetryEnabled:false,...settings});
  // /data is outside this repository: FooterDataProvider starts no git watcher.
  const sessionManager=SessionManager.inMemory('/data');
  sessionManager.appendSessionInfo('bottom-layout-fixture');
  const messages=[];
  for(let i=0;i<history;i++){
    const m={role:'user',content:[{type:'text',text:`Historical turn ${i+1}`}],timestamp:i};
    messages.push(m);sessionManager.appendMessage(m);
  }
  // Restored session messages render as cold history: settled, never replayed.
  for(const m of restored){messages.push(m);sessionManager.appendMessage(m);}
  const model={id:'fixture-model',provider:'fixture',name:'Fixture',reasoning:true,contextWindow:200000,maxTokens:8192,
    api:'openai-responses',input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const handlers = new Map(), commands = new Map();
  install({on(name,callback){handlers.set(name,callback);},registerCommand(name,command){commands.set(name,command);}});
  const empty=()=>[];
  const extensionRunner={getRegisteredCommands:empty,getCommandDiagnostics:empty,getShortcutDiagnostics:empty,
    getShortcuts:()=>new Map(),getMarkdownTransformers:empty,getEntryRenderer:()=>undefined,getMessageRenderer:()=>undefined,
    resolveToolRenderers:(_name,base)=>base()};
  const session={settingsManager,sessionManager,model,thinkingLevel:'medium',scopedModels:[],promptTemplates:[],
    state:{messages,model,thinkingLevel:'medium'},agent:{state:{messages},signal:new AbortController().signal},
    autoCompactionEnabled:false,isStreaming:false,isCompacting:false,isIdle:true,pendingMessageCount:0,retryAttempt:0,
    extensionRunner,modelRuntime:{getAvailableSnapshot:()=>[model],getError:()=>undefined,isUsingSubscription:()=>false},
    resourceLoader:{getThemes:()=>({themes:[],diagnostics:[]}),getSkills:()=>({skills:[],diagnostics:[]}),
      getPrompts:()=>({prompts:[],diagnostics:[]}),
      // As in Pi, the startup listing names this plugin.
      getExtensions:()=>({extensions:[{path:join(pluginRoot,'extensions','compact-ui2tree.ts')}],errors:[]}),
      getSystemPromptSource:()=>undefined,getAppendSystemPromptSources:empty,getAgentsFiles:()=>({agentsFiles:[]})},
    getContextUsage:()=>({tokens:123,contextWindow:200000,percent:0.0615}),getAvailableThinkingLevels:()=>['off','medium'],
    getSteeringMessages:empty,getFollowUpMessages:empty,getToolDefinition:()=>undefined,
    subscribe(callback){eventSink=callback;return()=>{eventSink=undefined;};},
    async bindExtensions({uiContext,mode}){
      context={ui:uiContext,mode,hasUI:true,cwd:'/data',sessionManager,model,thinkingLevel:'medium',getContextUsage:session.getContextUsage};
      if(pluginEnabled) await handlers.get('session_start')({type:'session_start',reason:startReason},context);
    },
    prompt(){throw new Error('tool/model execution forbidden by fixture');},
  };
  const runtime={session,setBeforeSessionInvalidate(callback){this.before=callback;},setRebindSession(callback){this.rebind=callback;}};
  const mode=new InteractiveMode(runtime,{terminal,tuiMode:'regular',initialThemeSetting:'dark'});
  mode.renderer.logDirectory=undefined;
  // Every draw, whoever asked for it, as Pi's renderer performs it.
  const renderListeners=new Set(), doRender=mode.renderer.doRender.bind(mode.renderer);
  mode.renderer.doRender=()=>{const start=process.hrtime.bigint();doRender();const ms=Number(process.hrtime.bigint()-start)/1e6;for(const listener of renderListeners)listener(ms);};
  try { await mode.init(); } catch(error) { close(); throw error; }
  assert.equal(mode.isInitialized,true);
  // A throttle left on the real clock would draw on wall time, not on this one.
  mode.renderer.requestRender();await settle();
  assert.equal(timeouts.size,1,"Pi's render throttle runs on the fixture clock");
  await frame();
  assert.equal(mode.ui === mode.renderer,false,'actual stable Proxy is distinct from renderer');
  assert.equal(mode.ui.children,mode.renderer.children);
  assert.deepEqual(mode.renderer.children,[mode.documentContainer,mode.pendingMessagesContainer,mode.statusContainer,
    mode.widgetContainerAbove,mode.editorContainer,mode.widgetContainerBelow,mode.footerContainer]);
  if(pluginEnabled) assert.equal(mode.footerContainer.children[0],mode.customFooter);
  mode.editor.setText('INPUT fixture');
  let expectedFooter=mode.customFooter?.render(width).map(stripTerminalSequences) ?? mode.footer.render(width).map(stripTerminalSequences);
  async function emit(event){
    assert.ok(eventSink,'real rebind subscribed to session event stream');
    const handler=handlers.get(event.type);if(pluginEnabled && handler)await handler(event,context);
    // AgentSession awaits extension handlers before delivering the event to UI.
    await eventSink(event);
    if(event.type==='message_end' && event.message){messages.push(event.message);sessionManager.appendMessage(event.message);}
    await settle();
  }
  /** Advances the clock by `ms`, firing every due timer at its own time, oldest first. */
  async function tick(ms=25){
    const target=now+ms;let fired=0;
    for(;;){
      let next;
      for(const timer of [...intervals.values(),...timeouts.values()])if(timer.due<=target&&(!next||timer.due<next.due||(timer.due===next.due&&timer.id<next.id)))next=timer;
      if(!next)break;
      now=Math.max(now,next.due);
      if(intervals.has(next.id))next.due=now+next.delay;else timeouts.delete(next.id);
      next.callback();fired++;
      await settle();
    }
    now=target;
    await settle();
    return fired;
  }
  /** Runs the draw Pi has scheduled, at its time; false when Pi scheduled none. Tests never draw on their own. */
  async function frame(){
    await settle();
    let due;for(const timer of timeouts.values())due=Math.min(due??timer.due,timer.due);
    if(due===undefined)return false;
    await tick(due-now);return true;
  }
  /** The terminal changes size, as ProcessTerminal reports SIGWINCH. */
  async function resize({columns=terminal.columns,rows=terminal.rows}){terminal.columns=columns;terminal.rows=rows;terminal.resize();await settle();}
  /** The event loop is blocked for `ms`: the clock jumps, then each due timer fires once, as Node does. */
  function stall(ms){now+=ms;return tick(0);}
  async function reload(){await handlers.get('session_shutdown')?.({},context);startReason='reload';await mode.rebindCurrentSession();}
  async function activate(){pluginEnabled=true;await mode.rebindCurrentSession();}
  async function replaceExtension(install){handlers.clear();commands.clear();install({on(name,callback){handlers.set(name,callback);},registerCommand(name,command){commands.set(name,command);}});pluginEnabled=true;await handlers.get('session_start')({},context);}
  function close(){
    if(pluginEnabled)handlers.get('session_shutdown')?.({},context);
    mode.customFooter?.dispose?.();mode.stop();mode.themeController.dispose();theme.stopThemeWatcher();
    const remaining=intervals.size;
    globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear;globalThis.fetch=originalFetch;performance.now=originalNow;Date.now=originalDateNow;
    globalThis.setTimeout=originalTimeout;globalThis.clearTimeout=originalClearTimeout;
    return {remainingTimers:remaining};
  }
  return {mode,session,sessionManager,get context(){return context;},terminal,handlers,commands,writes,intervals,Container,Text,stripTerminalSequences,CURSOR_MARKER,
    tick,frame,stall,resize,settle,emit,reload,activate,replaceExtension,close,onRender(listener){renderListeners.add(listener);return()=>renderListeners.delete(listener);},get now(){return now;},set startReason(value){startReason=value;},motion,expectedFooter,
    isolation:['in-memory AgentSession/runtime/resources; no model/tool execution','ensureTool import disabled: no download/spawn',
      'loadAllHighlightLanguages startup warmup disabled','terminal input never read; Pi schedules its own draws on the fake clock',
      'settings/session inMemory; cwd /data avoids git watcher; PI_OFFLINE and fetch guard','real constructor/init/rebind/mount/footer/Proxy/editor unchanged']};
}
