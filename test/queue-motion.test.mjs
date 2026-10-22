import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PaintGate, settleId} from '../extensions/queue.ts';
import {attachMotionScheduler,stopMotion} from '../extensions/motion.ts';
const source=(id,text,extra={})=>({id,text,limit:text,live:true,...extra});
function harness(t){let now=0;const timers=new Map();let next=0;
  attachMotionScheduler(()=>{}, {now:()=>now,setInterval(fn){timers.set(++next,fn);return next;},clearInterval(id){timers.delete(id);}});
  const gate=new PaintGate();t.after(()=>{gate.dispose();stopMotion();});
  return {gate,timers,step(ms=25){now+=ms;gate.advance({now,elapsedMs:ms});}};
}
test('Thinking prefixes require a real receipt before replacing a window',t=>{
  const {gate,step}=harness(t);gate.prepare([source('a','x'.repeat(200))],true);step();
  const first=gate.flowText('a');assert.ok(first.length>0&&first.length<200);
  step(2000);assert.equal(gate.flowText('a'),first);assert.equal(gate.flowComplete('a','x'.repeat(200)),false);
  assert.equal(gate.acknowledge('a',first),true);step();assert.ok(gate.flowText('a').length>first.length);
});
test('complete grants still need a final paint',t=>{const {gate,step}=harness(t);gate.prepare([source('a','abc')],true);step(1000);
  assert.equal(gate.flowText('a'),'abc');assert.equal(gate.flowComplete('a','abc'),false);
  gate.acknowledge('a','abc');assert.equal(gate.flowComplete('a','abc'),true);
});
test('the next Thinking waits for the preceding final source receipt',t=>{const {gate,step,timers}=harness(t);
  gate.prepare([source('a','FIRST'),source('b','SECOND')],true);step(1000);
  assert.equal(gate.flowText('a'),'FIRST');assert.equal(gate.flowText('b'),'');assert.equal(timers.size,0);
  step(1000);assert.equal(gate.flowText('b'),'');gate.acknowledge('a','FIRST');step(1000);
  assert.equal(gate.flowText('b'),'SECOND');gate.acknowledge('b','SECOND');assert.equal(timers.size,0);
});
test('old receipt cannot acknowledge a newer prefix',t=>{const {gate,step}=harness(t);gate.prepare([source('a','x'.repeat(200))],true);step();const old=gate.flowText('a');
  gate.acknowledge('a',old);step();assert.equal(gate.acknowledge('a',old),false);
});
test('cold history has no playback or timer',t=>{const {gate,timers}=harness(t);gate.prepare([source('old','history',{live:false})],true);
  assert.equal(gate.flowComplete('old','history'),true);assert.equal(timers.size,0);
});
test('empty Thinking needs no body receipt and cannot block its successor',t=>{const {gate,step,timers}=harness(t);
  gate.prepare([source('empty',''),source('next','NEXT')],true);assert.equal(gate.flowComplete('empty',''),true);
  step(1000);assert.equal(gate.flowText('next'),'NEXT');gate.acknowledge('next','NEXT');assert.equal(timers.size,0);
  gate.prepare([source('next','')],true);assert.equal(gate.flowComplete('next',''),true);assert.equal(timers.size,0);
});
test('temporary absence preserves a granted prefix',t=>{const {gate,step}=harness(t);gate.prepare([source('a','x'.repeat(200))],true);step();const shown=gate.flowText('a');
  gate.prepare([],true);gate.prepare([source('a','x'.repeat(200))],true);assert.equal(gate.flowText('a'),shown);
});
test('confirmed topology removal releases only that source',t=>{const {gate,step}=harness(t);gate.prepare([source('a','AAAA'),source('b','BBBB')],true);step();
  gate.retireRemoved(['a']);step(1000);assert.equal(gate.flowText('a'),'');assert.equal(gate.flowText('b'),'BBBB');
});
test('graphemes remain whole for Han, emoji, combining marks and ZWJ',t=>{const {gate,step}=harness(t);const text='中文👨‍👩‍👧‍👦é'.repeat(5);
  gate.prepare([source('a',text)],true);const boundaries=new Set([...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)].map(p=>p.index+p.segment.length));
  for(let i=0;i<80&&!gate.flowComplete('a',text);i++){step();const shown=gate.flowText('a');assert.ok(!shown||boundaries.has(shown.length));gate.acknowledge('a',shown);}
  assert.equal(gate.flowComplete('a',text),true);
});
test('append resumes at the same drawn prefix',t=>{const {gate,step}=harness(t);gate.prepare([source('a','abc')],true);step(1000);gate.acknowledge('a','abc');
  gate.prepare([source('a','abcdef')],true);assert.equal(gate.flowText('a'),'abc');assert.equal(gate.flowComplete('a','abcdef'),false);
  step(1000);gate.acknowledge('a','abcdef');assert.equal(gate.flowComplete('a','abcdef'),true);
});
test('interruption stops backlog and releases its motion timer',t=>{const {gate,step,timers}=harness(t);gate.prepare([source('a','x'.repeat(500))],true);step();gate.interrupt();
  assert.equal(timers.size,0);assert.equal(gate.flowComplete('a','x'.repeat(500)),true);
});
test('no-scheduler formatting never creates artificial playback',t=>{const {gate,timers}=harness(t);gate.prepare([source('a','whole')],false);
  assert.equal(gate.flows.size,0);assert.equal(gate.flowComplete('a','whole'),true);assert.equal(timers.size,0);
});
test('settle receipts record actual draw time once for each item phase',t=>{
 const {gate,step}=harness(t);assert.equal(gate.isSettled('card:a:bash'),false);
 step(150);assert.equal(gate.acknowledge(settleId('card:a:bash'),'settled'),true);
 assert.equal(gate.isSettled('card:a:bash'),true);assert.equal(gate.settledAt('card:a:bash'),150);
 step(150);assert.equal(gate.acknowledge(settleId('card:a:bash'),'settled'),false);
 assert.equal(gate.settledAt('card:a:bash'),150);assert.equal(gate.isSettled('card:a:bash','out'),false);
 gate.acknowledge(settleId('card:a:bash','out'),'settled');assert.equal(gate.settledAt('card:a:bash','out'),300);
});
test('waiting for a flush does not spin a timer',t=>{const {gate,step,timers}=harness(t);gate.prepare([source('a','x'.repeat(500))],true);step();assert.equal(timers.size,0);
  gate.acknowledge('a',gate.flowText('a'));assert.equal(timers.size,1);
});
test('removed owners release both settle phases while a survivor keeps its receipt',t=>{
 const {gate}=harness(t);
 for(const id of ['card:1:bash','card:2:read'])gate.acknowledge(settleId(id),'settled');
 gate.acknowledge(settleId('card:1:bash','out'),'settled');
 gate.retireRemoved(['card:1:bash']);assert.equal(gate.settled.size,1);assert.equal(gate.isSettled('card:2:read'),true);
 gate.retireRemoved(['card:2:read']);assert.equal(gate.hasOwnedState,false);
});
for(const delta of [0,10,40,150,1000])test(`elapsed ${delta}ms cannot accumulate debt while waiting for a real receipt`,t=>{
 const {gate,step}=harness(t);gate.prepare([source('a','x'.repeat(1000),{limit:'x'.repeat(8)})],true);step(1000);const shown=gate.flowText('a');
 assert.equal(shown.length,8);const credit=gate.flows.get('a').credit;step(delta);assert.equal(gate.flowText('a'),shown);assert.equal(gate.flows.get('a').credit,credit);
 gate.acknowledge('a',shown);gate.prepare([source('a','x'.repeat(1000),{limit:'x'.repeat(16)})],true);step(0);assert.equal(gate.flowText('a'),shown);
 step(25);assert.ok(gate.flowText('a').length>shown.length);
});
test('appended combining marks and ZWJ release whole new graphemes after the old painted prefix',t=>{
 const {gate,step}=harness(t);
 for(const [id,before,after] of [['latin','e','é!'],['emoji','👨','👨‍👩‍👧‍👦!']]){
  gate.prepare([source(id,before)],true);step(1000);gate.acknowledge(id,before);gate.prepare([source(id,after)],true);
  const boundaries=new Set([before,...[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(after)].map(p=>after.slice(0,p.index+p.segment.length))]);
  for(let i=0;i<40&&!gate.flowComplete(id,after);i++){step(25);assert.ok(boundaries.has(gate.flowText(id)));gate.acknowledge(id,gate.flowText(id));}
  assert.equal(gate.flowComplete(id,after),true);
 }
});
test('unpainted combining and ZWJ prefixes are normalized before the new row limit is granted',t=>{
 const {gate,step}=harness(t);
 for(const [id,old,next] of [['pending-latin','e','é!'],['pending-emoji','👨','👨‍👩‍👧‍👦!']]){
  gate.prepare([source(id,old)],true);step(1000);assert.equal(gate.flowText(id),old);
  gate.prepare([source(id,next)],true);assert.equal(gate.flowText(id),'','an unpainted obsolete cluster cannot be acknowledged');
  assert.equal(gate.acknowledge(id,old),false);step(1000);assert.equal(gate.flowText(id),next);gate.acknowledge(id,next);assert.equal(gate.flowComplete(id,next),true);
 }
});

test('PaintGate combines time-weighted arrival rate and backlog with a ten-token floor',t=>{
 const {gate,step}=harness(t);
 gate.prepare([source('rate','x'.repeat(100))],true);
 step(500);const shown=gate.flowText('rate');
 assert.equal(shown.length,50,'100 units/s backlog over half a second');
 gate.acknowledge('rate',shown);
 gate.prepare([source('rate','x'.repeat(200))],true);
 step(100);
 const weighted=(1-Math.exp(-0.5))*200;
 assert.equal(gate.flowText('rate').length,50+Math.floor((weighted+150)*0.1));
 gate.interrupt();gate.prepare([source('floor','abc')],true);step(25);
 assert.equal(gate.flowText('floor'),'a','10 tokens/s = 40 ASCII units/s');
});

test('non-prefix rewriting retains only the common complete-grapheme prefix and resets credit',t=>{
 const {gate,step}=harness(t);gate.prepare([source('rewrite','abcdef')],true);step(1000);gate.acknowledge('rewrite','abcdef');
 gate.prepare([source('rewrite','abcXYZ')],true);
 assert.equal(gate.flowText('rewrite'),'abc');assert.equal(gate.flows.get('rewrite').credit,0);
 assert.equal(gate.flowComplete('rewrite','abcXYZ'),false);
 gate.acknowledge('rewrite','abc');step(1000);gate.acknowledge('rewrite','abcXYZ');
 assert.equal(gate.flowComplete('rewrite','abcXYZ'),true);
});
