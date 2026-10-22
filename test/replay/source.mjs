import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempMinute } from '../register.mjs';
import { piRequire, piRoot, pluginRoot } from '../pi-host.mjs';

export const replayRoot = dirname(fileURLToPath(import.meta.url));
export const tuiRoot = dirname(dirname(piRequire.resolve('@earendil-works/pi-tui')));
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const arg = (key, fallback) => process.argv.find(v => v.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
export const piPaths = [...['dist/modes/interactive/interactive-mode.js', 'dist/modes/interactive/tui-renderer.js',
  'dist/modes/interactive/components/custom-editor.js', 'dist/modes/interactive/components/footer.js',
  'dist/core/agent-session.js', 'dist/core/extensions/runner.js',
  ...['assistant-message.js', 'tool-execution.js', 'custom-entry.js'].map(n => `dist/modes/interactive/components/${n}`)].map(n => join(piRoot, n)),
  ...['tui.js', 'tui-main-screen.js', 'components/editor.js'].map(n => join(tuiRoot, 'dist', n))];
const fingerprints = paths => Object.fromEntries(paths.map(path => [path, hash(readFileSync(path))]));
export function snapshot() {
  return {revision:execFileSync('git',['rev-parse','HEAD'],{cwd:pluginRoot,encoding:'utf8'}).trim(),
    production:fingerprints(readdirSync(join(pluginRoot,'extensions')).filter(n=>n.endsWith('.ts')).sort().map(n=>join(pluginRoot,'extensions',n))),
    pi:fingerprints(piPaths),
    piVersion:JSON.parse(readFileSync(join(piRoot,'package.json'),'utf8')).version,
    tuiVersion:JSON.parse(readFileSync(join(tuiRoot,'package.json'),'utf8')).version,
    fixtures:fingerprints([...readdirSync(replayRoot).filter(n=>/\.(mjs|sh)$/.test(n)).sort().map(n=>join(replayRoot,n)),
      ...['fixtures/session-slice.json','pi-host.mjs','register.mjs','resolve-pi.mjs'].map(n=>join(pluginRoot,'test',n))])};
}
export function matchExpected(actual, filename) {
  const expected=JSON.parse(readFileSync(resolve(filename),'utf8'));
  const input=expected.production ?? expected.original ?? expected.sources ?? expected;
  const normalized=Object.fromEntries(Object.entries(input).map(([path,sha])=>[isAbsolute(path)?path:resolve(pluginRoot,path.startsWith('extensions/')?path:`extensions/${path}`),sha]));
  assert.deepEqual(actual.production, normalized, 'expected production source set/hash mismatch');
  if(expected.pi && Object.values(expected.pi).every(v=>typeof v==='string')) assert.deepEqual(actual.pi,expected.pi,'expected Pi source mismatch');
  if(expected.fixtures) assert.deepEqual(actual.fixtures,expected.fixtures,'expected replay/fixture source mismatch');
}
/** --out-dir (relative to the working directory), else a directory of this run under the test temp root. */
export function outputDirectory({exclusive=false}={}) {
  const value=arg('out-dir');assert.notEqual(value,'','--out-dir needs a path');
  const path=resolve(value??join(tempMinute,`replay-${process.pid}`));
  if(exclusive){mkdirSync(dirname(path),{recursive:true});mkdirSync(path);}
  else mkdirSync(path,{recursive:true});
  return path;
}
export function reportPath(name) {
  assert.match(name,/^[A-Za-z0-9_.-]+\.json$/);
  const path=join(outputDirectory(),name);assert.ok(!existsSync(path),`refusing existing output: ${path}`);return path;
}
export function writeReport(path,data){writeFileSync(path,JSON.stringify(data)+'\n',{flag:'wx'});}
export function configure(variant='current') {
  assert.equal(variant,'current','current entry only');
  const manifest=snapshot();if(arg('sources'))matchExpected(manifest,arg('sources'));
  const source=new Map(Object.keys(manifest.production).map(path=>[path,readFileSync(path,'utf8')]));
  const interactive=join(piRoot,'dist/modes/interactive/interactive-mode.js'),piOriginal=readFileSync(interactive,'utf8');
  const substitutions=[['import { ensureTool } from "../../utils/tools-manager.js";','const ensureTool = async () => undefined;'],
    ['import { loadAllHighlightLanguages } from "../../utils/syntax-highlight.js";','const loadAllHighlightLanguages = async () => {};']];
  let piFixture=piOriginal;for(const[a,b]of substitutions){assert.equal(piFixture.split(a).length,2);piFixture=piFixture.replace(a,b);}
  const loaded={};
  const hook=registerHooks({load(url,context,next){
    if(!url.startsWith('file:'))return next(url,context);const path=fileURLToPath(url);
    if(source.has(path)){const text=source.get(path);loaded[path]=hash(text);return{format:'module-typescript',source:text,shortCircuit:true};}
    if(path===interactive)return{format:'module',source:piFixture,shortCircuit:true};
    return next(url,context);
  }});
  const info={...manifest,variant,original:manifest.production,loaded,interactiveFixture:{original:hash(piOriginal),executed:hash(piFixture),substitutions}};
  return{info,hook,verify(){const after=snapshot();assert.deepEqual(after,manifest,'source/Pi/fixture set changed during run');for(const[path,sha]of Object.entries(loaded))assert.equal(sha,manifest.production[path]);}};
}
