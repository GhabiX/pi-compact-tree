import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { piRoot } from '../pi-host.mjs';

/** Native terminal/editor/InteractiveMode + AgentSession prompt/input/steer.
 * Only model execution, persistence and abort side effects are isolated here.
 * The default replay fixture still forbids model/tool execution.
 */
export async function enableInput(f) {
  const { AgentSession } = await import(pathToFileURL(join(piRoot, 'dist/core/agent-session.js')).href);
  const { ExtensionRunner } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/runner.js')).href);
  const events = [], submissions = [];
  const trace = (type, extra = {}) => events.push({ at: f.now, type, ...extra });
  const s=f.session;s._steeringMessages=[];s._followUpMessages=[];s._pendingNextTurnMessages=[];
  s._baseSystemPromptOptions={selectedTools:[]};s._modelRuntime={hasConfiguredAuth:()=>true};
  s._tryExecuteExtensionCommand=async()=>false;s._expandSkillCommand=x=>x;
  s._flushPendingBashMessages=()=>{};s._flushPendingCustomMessages=()=>{};s._findLastAssistantMessage=()=>undefined;
  s.getActiveToolNames=()=>[];s._normalizePromptImages=async()=>({images:[],hints:[]});s._preparePromptAndToolLoadout=()=>undefined;
  s._emitQueueUpdate=()=>{trace('queue_update',{steering:[...s._steeringMessages]});};
  s.getSteeringMessages=()=>[...s._steeringMessages];s.getFollowUpMessages=()=>[...s._followUpMessages];
  s.clearQueue=()=>{const q={steering:s._steeringMessages.splice(0),followUp:s._followUpMessages.splice(0)};trace('clearQueue');return q;};
  s.abort=async()=>{trace('native-abort');s.isStreaming=false;s.isIdle=true;};
  s.abortBash=()=>trace('native-abort-bash');
  const runner={hasHandlers:name=>f.handlers.has(name),createContext:()=>({...f.context,isIdle:()=>s.isIdle}),emitError:e=>{throw e.error;},
    get extensions(){return [{path:'fixture-extension',handlers:new Map([...f.handlers].map(([k,v])=>[k,[v]]))}];},
    emitInput(...args){trace('native-input',{text:args[0]});return ExtensionRunner.prototype.emitInput.apply(this,args);},
    emitBeforeAgentStart:async(_text,_images,options)=>({systemPromptOptions:options,messages:[]})};
  s._extensionRunner=runner;s._runInputHandlers=AgentSession.prototype._runInputHandlers;
  s._queueSteer=AgentSession.prototype._queueSteer;s.agent.steer=m=>{trace('native-steer',{text:m.content[0].text});};
  s._runAgentPrompt=async(messages)=>{trace('native-run-accepted');for(const m of messages){await f.emit({type:'message_start',message:m});await f.emit({type:'message_end',message:m});}};
  // Idle prompts start through _startRun; keep the no-model boundary and emit the native user message.
  s._startRun=async(trigger,onStarted)=>{onStarted?.();await s._runAgentPrompt([{role:'user',content:[{type:'text',text:trigger.prompt}],timestamp:2}]);};
  s.prompt=(body,options)=>{trace('native-prompt',{body,options});const promise=AgentSession.prototype.prompt.call(s,body,options);submissions.push(promise);return promise;};
  f.mode.onInputCallback=body=>{s.prompt(body).catch(error=>trace('prompt-error',{message:error.message}));};
  return {
    events, submissions,
    async key(data) {
      trace('terminal-input', { data });
      f.terminal.input(data);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.allSettled(submissions);
      await Promise.resolve();
    },
  };
}
