import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {describe,test} from 'node:test';
import {fileURLToPath} from 'node:url';
// The replay streams drive the real Pi interactive mode through whole sessions
// (lifecycle, resize, overlay, reload); each group runs in its own process because
// stream.mjs patches Pi modules and terminal globals for the life of the process.
const script=fileURLToPath(new URL('./replay/stream.mjs',import.meta.url));
const run=args=>new Promise(resolve=>execFile(process.execPath,['--experimental-strip-types',script,...args],
  {maxBuffer:1<<26},(error,stdout,stderr)=>resolve({code:error?.code??0,stdout,stderr})));
describe('replay streams',{concurrency:true},()=>{
for(const scenario of ['short','history','adoption'])for(const width of [80,40])for(const termux of [false,true])
  test(`replay stream ${scenario} ${width}${termux?' termux':''}`,async()=>{
    const {code,stdout,stderr}=await run([`--scenario=${scenario}`,`--width=${width}`,...termux?['--termux']:[]]);
    const line=stdout.trim().split('\n').at(-1)??'';
    assert.equal(code,0,`${line.slice(0,2000)}\n${stderr.slice(-2000)}`);
    assert.equal(JSON.parse(line).summary.functionalPassed,true);
  });
});
