import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {arg,matchExpected,outputDirectory,snapshot,writeReport} from './source.mjs';
const selection=arg('case','short'),width=Number(arg('width','80'));
assert.ok([40,80].includes(width));assert.ok(['short','history','compat-tools','compat-history'].includes(selection));
const before=snapshot();if(arg('sources'))matchExpected(before,arg('sources'));
const output=outputDirectory({exclusive:true}),manifestPath=join(output,'sources.json');writeReport(manifestPath,before);
const compat=selection.startsWith('compat-');
const script=fileURLToPath(new URL(compat?'compat.mjs':'stream.mjs',import.meta.url));
const params=[process.execPath,'--experimental-strip-types',script,`--out-dir=${output}`,`--sources=${manifestPath}`,`--width=${width}`,'--speed=1',
  ...(compat?[`--scenario=${selection==='compat-tools'?'continuous-tools':'fixed'}`,`--history=${selection==='compat-history'?1000:0}`,'--quiet']:[`--scenario=${selection}`,'--tty','--rounds=3','--lifecycle=false'])];
const quote=v=>`'${String(v).replaceAll("'","'\\''")}'`;
const command=`stty cols ${width} rows 24; exec ${params.map(quote).join(' ')}`;
const result=spawnSync('script',['-qef',`-t${join(output,'terminal.time')}`,'-c',command,join(output,'terminal.tty')],{stdio:'inherit'});
assert.deepEqual(snapshot(),before,'source changed during PTY');
writeReport(join(output,'record.json'),{selection,width,speed:1,exitCode:result.status,sources:before,tty:join(output,'terminal.tty'),timing:join(output,'terminal.time'),humanInput:false});
process.exitCode=result.status??1;
