import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {arg,hash,matchExpected,outputDirectory,snapshot,writeReport} from './source.mjs';
const selection=arg('case','all'),width=Number(arg('width','80'));
assert.ok([40,80].includes(width));
const cases={short:[['stream',{scenario:'short',width}]],history:[['stream',{scenario:'history',width}]],
  reload:[['native',{mode:'reload',width}]],control:[['native',{mode:'control',width}]]};
cases.all=[...['short','history'].flatMap(scenario=>[80,40].map(width=>['stream',{scenario,width}])),
  ...[80,40].map(width=>['native',{mode:'reload',width}])];
assert.ok(selection==='sources'||cases[selection],'--case must be sources|short|history|reload|control|all');
const manifest=snapshot();if(arg('sources'))matchExpected(manifest,arg('sources'));
const output=outputDirectory({exclusive:true});const manifestPath=join(output,'sources.json');writeReport(manifestPath,manifest);
if(selection==='sources'){console.log(manifestPath);process.exit(0);}
const results=[];
for(const[entry,options]of cases[selection]){
  const params=['--experimental-strip-types',fileURLToPath(new URL(`${entry}.mjs`,import.meta.url)),`--out-dir=${output}`,`--sources=${manifestPath}`,
    ...Object.entries(options).map(([k,v])=>`--${k}=${v}`)];
  if(entry==='stream')for(const name of ['rounds','lifecycle'])if(arg(name)!==undefined)params.push(`--${name}=${arg(name)}`);
  const child=spawnSync(process.execPath,params,{encoding:'utf8',maxBuffer:4*1024*1024});
  const key=[entry,options.scenario??options.mode,options.width].join('-');const log=join(output,`${key}.log`);
  writeFileSync(log,(child.stdout??'')+(child.stderr??''),{flag:'wx'});
  const path=join(output,`${key}.json`);let data;try{data=JSON.parse(readFileSync(path,'utf8'));}catch{}
  const summary=data?.summary;const passed=child.status===0&&(summary?.passed??summary?.functionalPassed)===true;
  results.push({entry,options,status:child.status,passed,path,sha256:data?hash(readFileSync(path)):null,summary,log});
  console.log(JSON.stringify({entry,...options,status:child.status,passed,failure:summary?.failure}));
  if(!passed)break;
}
assert.deepEqual(snapshot(),manifest,'source changed across matrix');
const summary={selection,passed:results.length===cases[selection].length&&results.every(r=>r.passed),sources:manifest,results};
writeReport(join(output,'summary.json'),summary);if(!summary.passed)process.exitCode=1;
