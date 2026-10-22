import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { configure } from './replay/source.mjs';

const source = configure();
const { createFixture } = await import('./replay/fixture.mjs');
const { enableInput } = await import('./replay/input.mjs');
after(() => { source.verify(); source.hook.deregister(); });
const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const thought = (text, calls = [], stopReason = 'toolUse') => ({ role: 'assistant', api: 'openai-responses',
  provider: 'fixture', model: 'fixture-model', content: [{ type: 'thinking', thinking: text }, ...calls], stopReason, timestamp: 1, usage });
const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 2 });
const text = Array.from({ length: 24 }, (_, i) => `OLD_LINE_${i} remains in the playback queue.`).join('\n');
const call = { type: 'toolCall', id: 'interrupt-call', name: 'bash', arguments: { command: 'printf OLD_COMMAND' } };

async function harness(t) {
  const f = await createFixture({ width: 80 }), root = f.mode.renderer, editor = f.mode.editor;
  const input = await enableInput(f), samples = [];
  const originalHandleInput = editor.handleInput;
  const frame = () => f.Container.prototype[Symbol.for('pi-compact-ui2tree/container-render-v1')].rootFrames.get(root);
  const strip = f.stripTerminalSequences;
  // Samples are read after each draw Pi schedules itself; the test never draws.
  f.onRender(() => {
    const host = root.captureRenderState(), receipts = [];
    let offset = 0;
    for (const block of frame().coordinator.render().owners[0].blocks) {
      for (const span of block.paint ?? []) {
        if (root.hasOverlay() || span.to <= span.from || span.to > block.rows.length ||
          offset + span.from < host.previousViewportTop || offset + span.to > host.previousViewportTop + host.previousHeight) continue;
        if (block.rows.slice(span.from, span.to).every((row, i) => strip(row).trimEnd() === strip(host.previousLines[offset + span.from + i] ?? '').trimEnd())) {
          receipts.push({ ...span, phase: block.phase });
        }
      }
      offset += block.rows.length;
    }
    samples.push({ at: f.now, host: host.previousLines.map(strip), receipts, state: host });
  });
  /** The latest sample once the draw Pi has scheduled, if any, has run. */
  async function draw() { await f.frame(); return samples.at(-1); }
  async function key(data) { await input.key(data); return draw(); }
  async function emit(event) { await f.emit(event); return draw(); }
  async function step() { await f.tick(25); return draw(); }
  const pending = () => root.renderRequested || [...f.intervals.values()].some(timer => timer.owner === 'motion');
  const seen = body => samples.flatMap(sample => sample.receipts).filter(span => !span.settled && span.text && body.startsWith(span.text)).at(-1)?.text ?? '';
  async function start(body = text) {
    f.session.isStreaming = true; f.session.isIdle = false;
    await emit({ type: 'agent_start' }); await emit({ type: 'turn_start' });
    await emit({ type: 'message_start', message: thought('') });
    await emit({ type: 'message_update', message: thought(body, [call]) });
    for (let i = 0; i < 30; i++) await step();
    assert.ok(seen(body).length > 0 && seen(body).length < body.length);
  }
  async function end(body = text, tool = call) {
    await emit({ type: 'message_end', message: thought(body, [tool]) });
    await emit({ type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.name, args: tool.arguments });
    await emit({ type: 'tool_execution_end', toolCallId: tool.id, result: { content: [{ type: 'text', text: 'OLD_RESULT' }], isError: false }, isError: false });
    f.session.isStreaming = false; f.session.isIdle = true;
    await emit({ type: 'agent_end', messages: [] });
  }
  async function drain() { for (let i = 0; i < 1000 && pending(); i++) await step(); assert.equal(pending(), false); }
  editor.setText(''); await draw();
  t.after(() => {
    assert.equal(editor.handleInput, originalHandleInput, 'native input handler identity');
    if (root.hasOverlay()) root.hideOverlay();
    assert.equal(f.close().remainingTimers, 0);
  });
  return { f, root, editor, input, samples, draw, key, emit, step, start, end, seen, pending, drain };
}

function completedEndpoint(span, bodyReceipt) {
  return !!bodyReceipt && span.settled === true && span.text === 'settled' &&
    span.phase === 'stable' && span.id === bodyReceipt.id.replace('card:', 'settle:card:');
}
test('normal completion positively identifies the complete source and its stable settle receipt',async t=>{
  const h=await harness(t),body=text;await h.start(body);await h.end(body);await h.drain();
  const receipt=h.samples.flatMap(s=>s.receipts).find(p=>!p.settled&&p.text===body);
  assert.ok(receipt);assert.ok(h.samples.flatMap(s=>s.receipts).some(p=>completedEndpoint(p,receipt,body)));
});

for (const running of [false, true]) test(`terminal Escape stops visual backlog while native streaming is ${running}`, async t => {
  const h = await harness(t); await h.start(); if (!running) await h.end();
  const before = h.seen(text), boundary = h.samples.length, callback = h.editor.onEscape;
  await h.key('\x1b'); if(running)await h.end(); for (let i = 0; i < 12; i++) await h.step();
  assert.equal(h.seen(text), before);
  assert.ok(before.length < text.length);
  const oldReceipt=h.samples.slice(0,boundary).flatMap(s=>s.receipts).find(p=>!p.settled&&p.text&&text.startsWith(p.text));
  assert.ok(oldReceipt);assert.ok(!h.samples.slice(boundary).some(s=>s.receipts.some(p=>completedEndpoint(p,oldReceipt,text))), 'skip cannot report this source as drawn');
  assert.equal(h.input.events.filter(e => e.type === 'native-abort').length, running ? 1 : 0);
  assert.equal(h.editor.onEscape, callback, 'temporary callback restored');
});

for (const running of [false, true]) test(`terminal Enter accepts ${running ? 'steering' : 'a new prompt'} without waiting for old playback`, async t => {
  const h = await harness(t); await h.start(); if (!running) await h.end();
  const before = h.seen(text), at = h.f.now;
  await h.key('INSERT_NEW_USER'); assert.equal(h.seen(text), before);
  await h.key('\r');
  assert.equal(h.input.events.filter(e => e.type === 'native-abort').length, 0);
  if (running) {
    assert.equal(h.input.events.filter(e => e.type === 'native-steer').length, 1);
    assert.ok(h.samples.at(-1).host.some(row => row.includes('Steering: INSERT_NEW_USER')));
    h.f.session._steeringMessages.length = 0;
    await h.emit({ type: 'message_start', message: user('INSERT_NEW_USER') });
    await h.emit({ type: 'message_end', message: user('INSERT_NEW_USER') });
  }
  // Pi throttles draws to one per 16 ms; the plugin adds no wait for playback on top of that.
  assert.ok(h.samples.at(-1).at - at <= 16, 'drawn in the next frame Pi schedules');
  assert.ok(h.samples.at(-1).host.some(row => row.trim() === 'INSERT_NEW_USER'), 'accepted native message is visible in the next actual draw');
  for (let i = 0; i < 12; i++) await h.step();
  assert.equal(h.seen(text), before);
});

test('typing, overlay dismissal, autocomplete cancellation and failed preflight do not skip playback', async t => {
  const h = await harness(t); await h.start();
  const advances = async action => { const before = h.seen(text); await action(); for (let i = 0; i < 8; i++) await h.step(); assert.ok(h.seen(text).length >= before.length); };
  await advances(() => h.key('ORDINARY_TYPING'));
  h.root.showOverlay({ render: () => ['OVERLAY'], invalidate() {}, handleInput(data) { if (data === '\x1b') h.root.hideOverlay(); } }, { width: 20, height: 3 });
  await h.draw(); await advances(() => h.key('\x1b')); assert.equal(h.root.hasOverlay(), false);
  h.editor.setText('fo');
  h.editor.setAutocompleteProvider({ getSuggestions: () => ({ items: [{ value: 'foobar', label: 'foobar' }, { value: 'foobaz', label: 'foobaz' }], prefix: 'fo' }),
    applyCompletion: (lines, line, col, item) => ({ lines: [item.value], cursorLine: 0, cursorCol: item.value.length }) });
  await h.key('\t'); await new Promise(resolve => setImmediate(resolve)); await h.draw();
  assert.equal(h.editor.isShowingAutocomplete(), true);
  await advances(() => h.key('\x1b')); assert.equal(h.editor.isShowingAutocomplete(), false);
  h.f.session.isStreaming = false; h.f.session.isIdle = true; h.f.session.model = undefined; h.editor.setText('FAILED_PREFLIGHT');
  await advances(() => h.key('\r')); assert.ok(h.input.events.some(e => e.type === 'prompt-error'));
  await h.key('\x1b'); const before = h.seen(text); for (let i = 0; i < 8; i++) await h.step(); assert.equal(h.seen(text), before);
});

test('steering stops late deltas of the old source while the next source retains full playback', async t => {
  const h = await harness(t); await h.start(); const before = h.seen(text);
  await h.key('INSERT_NEW_USER'); await h.key('\r');
  await h.emit({ type: 'message_update', message: thought(text + ' LATE_DELTA', [call]) });
  await h.end(text + ' LATE_DELTA');
  for (let i = 0; i < 8; i++) await h.step(); assert.equal(h.seen(text), before);
  h.f.session._steeringMessages.length = 0;
  await h.emit({ type: 'message_start', message: user('INSERT_NEW_USER') });
  await h.emit({ type: 'message_end', message: user('INSERT_NEW_USER') });
  const next = 'NEW_SOURCE fully plays after explicit interruption.', tool = { ...call, id: 'next-call', arguments: { command: 'printf NEW_COMMAND' } };
  await h.emit({ type: 'message_start', message: thought('') });
  await h.emit({ type: 'message_update', message: thought(next, [tool]) });
  await h.end(next, tool); await h.drain();
  assert.equal(h.seen(next), next);
  const receipt=h.samples.flatMap(s=>s.receipts).find(p=>!p.settled&&p.text===next);assert.ok(receipt);
  const endpoint=h.samples.flatMap(s=>s.receipts).find(p=>completedEndpoint(p,receipt));
  assert.ok(endpoint);
  assert.equal(endpoint.settled,true);
  assert.equal(endpoint.text,'settled');
});

test('four and eight row windows retain working status, caret and the accepted steering message', async t => {
  const h = await harness(t); await h.start();
  h.f.context.ui.setWidget('CROWD', () => ({ render: () => Array.from({ length: 30 }, (_, i) => `WIDGET_${i}`), invalidate() {} }), { placement: 'aboveEditor' });
  h.editor.setText(Array.from({ length: 25 }, (_, i) => `DRAFT_${i}`).join('\n'));
  await h.f.resize({ rows: 8 }); await h.draw();
  const assertVisible = (sample, queued) => {
    const host = sample.state, visible = sample.host.slice(host.previousViewportTop, host.previousViewportTop + host.previousHeight);
    const status = h.f.stripTerminalSequences(h.f.mode.activeStatusIndicator.renderInBorder(80)).trim();
    assert.ok(visible.some(row => row.includes(status)), 'native working marker and elapsed message remain visible');
    assert.ok(host.hardwareCursorRow >= host.previousViewportTop && host.hardwareCursorRow < host.previousViewportTop + host.previousHeight);
    if (queued) assert.ok(visible.some(row => row.includes('Steering: INSERT_NEW_USER')));
  };
  assertVisible(h.samples.at(-1), false);
  h.editor.setText(''); await h.draw(); const before = h.seen(text);
  await h.key('INSERT_NEW_USER'); await h.key('\r');
  for (const height of [4, 8]) { await h.f.resize({ rows: height }); assertVisible(await h.draw(), true); }
  assert.equal(h.input.events.filter(e => e.type === 'native-steer').length, 1);
  assert.equal(h.input.events.filter(e => e.type === 'native-abort').length, 0);
  for (let i = 0; i < 8; i++) await h.step(); assert.equal(h.seen(text), before);
});

test('three native CLI reloads retain one listener and one native abort per Escape', async t => {
  const h = await harness(t); await h.start(); const count = h.f.mode.extensionTerminalInputSubscriptions.size;
  for (let i = 0; i < 3; i++) {
    h.f.session.reload = async ({ beforeSessionStart }) => { await h.f.handlers.get('session_shutdown')({}, h.f.context); await beforeSessionStart(); await h.f.mode.rebindCurrentSession(); };
    await h.f.mode.handleReloadCommand(); await h.draw();
    assert.equal(h.f.mode.extensionTerminalInputSubscriptions.size, count); assert.equal(h.f.mode.editor, h.editor);
  }
  const next = 'RELOADED source still obeys the native Escape.';
  await h.emit({ type: 'message_start', message: thought('') }); await h.emit({ type: 'message_update', message: thought(next) });
  for (let i = 0; i < 12; i++) await h.step(); const before = h.seen(next);
  await h.key('\x1b'); for (let i = 0; i < 8; i++) await h.step();
  assert.equal(h.seen(next), before); assert.equal(h.input.events.filter(e => e.type === 'native-abort').length, 1);
});

test('acceptance from a disposed footer cannot interrupt a source created after reload', async t => {
  const h = await harness(t); await h.start();
  const prior = h.f.handlers.get('input'); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  h.f.handlers.set('input', async (...args) => { await prior(...args); await waiting; });
  h.editor.setText('DELAYED_STEER'); h.f.terminal.input('\r'); await Promise.resolve(); await Promise.resolve();
  await h.f.reload(); await h.draw();
  const next = 'AFTER_RELOAD this new source must continue to play.';
  await h.emit({ type: 'message_start', message: thought('') }); await h.emit({ type: 'message_update', message: thought(next) });
  for (let i = 0; i < 12; i++) await h.step(); const before = h.seen(next); assert.ok(before.length > 0);
  release(); await Promise.all(h.input.submissions); await Promise.resolve(); await h.draw();
  for (let i = 0; i < 8; i++) await h.step(); assert.ok(h.seen(next).length > before.length);
});

// After a session replacement the paint observer is installed inside the plugin's reprint; the
// first Ctrl+O after it must still reprint a held-back result (independent review of 1ays327o).
for (const command of [false, true]) test(`the first Ctrl+O after ${command ? 'the /reload command' : 'a session rebind'} reprints its held-back result`, async t => {
  const f = await createFixture({ height: 24 }), root = f.mode.renderer;
  t.after(() => f.close());
  const emit = async event => { await f.emit(event); await f.frame(); };
  const drain = async (n = 400) => { for (let i = 0; i < n; i++) await f.tick(25); };
  for (let i = 0; i < 6; i++) {
    const call = { type: 'toolCall', id: `c${i}`, name: 'bash', arguments: { command: `printf T${i}` } };
    const message = thought(`Turn ${i}\nline a\nline b`, [call]);
    await emit({ type: 'agent_start' }); await emit({ type: 'message_start', message: thought('') });
    await emit({ type: 'message_update', message }); await emit({ type: 'message_end', message });
    await emit({ type: 'tool_execution_start', toolCallId: `c${i}`, toolName: 'bash', args: call.arguments });
    await emit({ type: 'tool_execution_end', toolCallId: `c${i}`, isError: false,
      result: { content: [{ type: 'text', text: Array.from({ length: 12 }, (_, k) => `T${i} out ${k}`).join('\n') }], isError: false } });
    await emit({ type: 'agent_end', messages: [] }); await drain(120);
  }
  await drain();
  if (command) {
    // As native.mjs: the real command, with only resource loading replaced.
    f.session.reload = async ({ beforeSessionStart }) => { await beforeSessionStart();
      await f.handlers.get('session_shutdown')?.({}, f.context); await f.handlers.get('session_start')({ type: 'session_start', reason: 'reload' }, f.context); };
    await f.mode.handleReloadCommand();
  } else await f.reload();
  while (await f.frame()); await drain(40);
  const before = root.fullRedraws;
  f.mode.toggleToolOutputExpansion(); while (await f.frame()); await drain(200);
  assert.equal(root.fullRedraws, before + 1, 'one reprint');
  const shown = root.captureRenderState().previousLines.map(f.stripTerminalSequences);
  root.resetRenderState(); root.renderNow();
  assert.deepEqual(shown, root.captureRenderState().previousLines.map(f.stripTerminalSequences), 'the screen shows the expanded result');
});

// With quietStartup Pi's header does not expand, so nothing outside the sealed history is held
// back. Ctrl+O must still reach the sealed rows, and only when it changes them.
async function quiet(t) {
  const f = await createFixture({ height: 24, settings: { quietStartup: true } }), root = f.mode.renderer;
  t.after(() => f.close());
  const state = f.Container.prototype[Symbol.for('pi-compact-ui2tree/container-render-v1')];
  const emit = async event => { await f.emit(event); await f.frame(); };
  const drain = async (n = 400) => { for (let i = 0; i < n; i++) await f.tick(25); };
  const tools = async i => {
    const call = { type: 'toolCall', id: `c${i}`, name: 'bash', arguments: { command: `printf T${i}` } };
    const message = thought(`Turn ${i}\nline a\nline b`, [call]);
    await emit({ type: 'agent_start' }); await emit({ type: 'message_start', message: thought('') });
    await emit({ type: 'message_update', message }); await emit({ type: 'message_end', message });
    await emit({ type: 'tool_execution_start', toolCallId: `c${i}`, toolName: 'bash', args: call.arguments });
    await emit({ type: 'tool_execution_end', toolCallId: `c${i}`, isError: false,
      result: { content: [{ type: 'text', text: Array.from({ length: 12 }, (_, k) => `T${i} out ${k}`).join('\n') }], isError: false } });
    await emit({ type: 'agent_end', messages: [] }); await drain(120);
  };
  const prose = async i => {
    const message = { ...thought(''), content: [{ type: 'text', text: `Answer ${i}\nsecond line ${i}` }], stopReason: 'stop' };
    await emit({ type: 'agent_start' }); await emit({ type: 'message_start', message: { ...message, content: [] } });
    await emit({ type: 'message_update', message }); await emit({ type: 'message_end', message });
    await emit({ type: 'agent_end', messages: [] }); await drain(160);
  };
  const say = async text => { await emit({ type: 'message_start', message: user(text) }); await emit({ type: 'message_end', message: user(text) }); await drain(40); };
  // A tall user message scrolls the earlier turns out; the next message lets the seal grow over them.
  const scroll = async () => { await say(Array.from({ length: 40 }, (_, i) => `LATER_USER_${i}`).join('\n')); await say('next'); await drain(); };
  const seal = () => [...state.caches].map(ref => ref.deref()?.sealed?.block).find(Boolean);
  const toggle = async () => {
    const before = root.fullRedraws;
    f.mode.toggleToolOutputExpansion(); while (await f.frame()); await drain(200);
    const shown = root.captureRenderState().previousLines.map(f.stripTerminalSequences);
    const reprints = root.fullRedraws - before, sealed = seal();
    // The comparison draws a fresh frame, which ends the seal.
    root.resetRenderState(); root.renderNow();
    return { reprints, sealed, shown, fresh: root.captureRenderState().previousLines.map(f.stripTerminalSequences) };
  };
  return { tools, prose, say, scroll, seal, toggle };
}

test('quietStartup: Ctrl+O whose result lies wholly in sealed history reprints once, expanding and collapsing', async t => {
  const q = await quiet(t);
  await q.tools(0); await q.tools(1); await q.scroll();
  assert.ok(q.seal()?.rows.length > 0, 'the turns are sealed');
  const expand = await q.toggle();
  assert.equal(expand.reprints, 1); assert.deepEqual(expand.shown, expand.fresh, 'the screen shows the expanded result');
  await q.scroll();
  const collapse = await q.toggle();
  assert.equal(collapse.reprints, 1); assert.deepEqual(collapse.shown, collapse.fresh, 'the screen shows the collapsed result');
  // Straight after a reprint nothing is sealed yet: the seal must not take in the held-back blocks.
  const again = await q.toggle();
  assert.equal(again.reprints, 1); assert.deepEqual(again.shown, again.fresh, 'the screen shows the expanded result again');
});

// Guards the recheck in prepareTarget: 7f4edbc passes this too, since it never unsealed on Ctrl+O.
test('quietStartup: Ctrl+O over sealed rows it does not change keeps the seal and reprints nothing', async t => {
  const q = await quiet(t);
  await q.say('hello'); await q.prose(0); await q.say('again'); await q.prose(1); await q.scroll();
  const sealed = q.seal();
  assert.ok(sealed?.rows.length > 0, 'the turns are sealed');
  const r = await q.toggle();
  assert.equal(r.reprints, 0); assert.equal(r.sealed, sealed, 'the same sealed block'); assert.deepEqual(r.shown, r.fresh);
});
