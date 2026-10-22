import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {describe,test} from 'node:test';
import {fileURLToPath} from 'node:url';
// The native replay drives real Pi status, custom-entry and reload paths through the
// interactive mode; each group runs in its own process for the same reason as replay streams.
const script=fileURLToPath(new URL('./replay/native.mjs',import.meta.url));
const run=args=>new Promise(resolve=>execFile(process.execPath,['--experimental-strip-types',script,...args],
  {maxBuffer:1<<26},(error,stdout,stderr)=>resolve({code:error?.code??0,stdout,stderr})));
describe('native replay',{concurrency:true},()=>{
for(const mode of ['reload','control'])for(const width of [80,40])
  test(`native replay ${mode} ${width}`,async()=>{
    const {code,stdout,stderr}=await run([`--mode=${mode}`,`--width=${width}`]);
    const line=stdout.trim().split('\n').at(-1)??'';
    assert.equal(code,0,`${line.slice(0,2000)}\n${stderr.slice(-2000)}`);
    assert.equal(JSON.parse(line).passed,true);
  });
});
