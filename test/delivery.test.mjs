// Everything an agent sends reaches the screen, and a rest ends on its beat: the frame checks
// (frame-scenes) prove each frame is smooth, these prove the end state arrives.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { configure } from './replay/source.mjs';

const source = configure();
const { createFixture } = await import('./replay/fixture.mjs');
const { session, assistant, user } = await import('./support/driver.mjs');
const { HostRowsCache } = await import('./host-rows.mjs');
const { attachMotionScheduler, stopMotion } = await import('../extensions/motion.ts');
const { restEnd } = await import('../extensions/snapshot.ts');
after(() => { source.verify(); source.hook.deregister(); });

for (const height of [24, 40]) test(`live prose taller than the ${height}-row screen plays to its last line`, async () => {
  const { f, emit, turn, prompt, drain } = await session(height);
  try {
    const screen = () => f.mode.renderer.captureRenderState().previousLines.map(f.stripTerminalSequences).join('\n');
    await emit({ type: 'agent_start' });
    await prompt('long prose');
    const text = Array.from({ length: 60 }, (_, i) => `ROW_${i} prose that scrolls into history.`).join('\n') + '\nFINAL_SENTINEL';
    await turn([{ type: 'text', text }], [], { chunk: 100000, rest: 0 });
    await emit({ type: 'agent_end', messages: [] });
    await drain(1200);
    assert.ok(f.mode.renderer.captureRenderState().previousViewportTop > 0, 'the prose scrolled past the screen');
    assert.match(screen(), /FINAL_SENTINEL/);
  } finally {
    assert.equal(f.close().remainingTimers, 0);
  }
});

// Two finished live writes: the second enters when the first's rest ends, however rarely the screen is prepared.
for (const [label, every] of [['every 25ms', 25], ['only every 1200ms', 1200]]) test(`a rest ends on its beat when prepared ${label}`, () => {
  let now = 0;
  attachMotionScheduler(() => {}, { now: () => now, setInterval: () => 1, clearInterval() {} });
  const cache = new HostRowsCache();
  try {
    const children = ['first', 'second'].map(path => ({ toolName: 'write', args: { path, content: 'a' }, playbackSource: true,
      result: { content: [], isError: false }, render: () => [] }));
    const options = { classify: c => c, renderNative: c => c.render(), theme: false, expanded: false, styleEpoch: 0, confirmPaint: true, layoutId: 'chat' };
    for (const block of cache.prepare(children, 80, options).blocks) for (const span of block.paint ?? []) cache.acknowledge(span.id, span.text);
    const due = restEnd(0);
    let entered;
    for (now = every; now <= 12000 && entered === undefined; now += every) {
      if (cache.prepare(children, 80, options).rows.some(row => row.includes('second'))) entered = now;
    }
    assert.equal(entered, Math.ceil(due / every) * every);
  } finally {
    cache.dispose(); stopMotion();
  }
});

// Items that went straight to their final form hold no receipt once drawn: a held receipt keeps the
// bottom reserving room for it and the clock running, and the screen never counts as settled.
test('a backlog that entered in its final form leaves no pending receipt once drawn', async () => {
  const { f, emit, turn, prompt, drain } = await session(40);
  try {
    const KEY = Symbol.for('pi-compact-ui2tree/container-render-v1');
    await emit({ type: 'agent_start' });
    await prompt('backlog');
    for (let i = 0; i < 4; i++) await turn([{ type: 'thinking', thinking: `Step ${i} of the plan.` },
      { type: 'toolCall', id: `w${i}`, name: 'write', arguments: { path: `f${i}.md`, content: 'x' } }],
      [{ id: `w${i}`, name: 'write', args: { path: `f${i}.md`, content: 'x' }, result: { content: [{ type: 'text', text: 'ok' }], details: {} } }], { rest: 0 });
    await turn([{ type: 'text', text: 'BACKLOG_DONE' }], [], { rest: 0 });
    await emit({ type: 'agent_end', messages: [] }); await emit({ type: 'agent_settled' });
    await drain(400);
    const state = f.Container.prototype[KEY];
    const blocks = state.rootFrames.get(f.mode.renderer).coordinator.readBlocks();
    assert.deepEqual(blocks.filter(block => block.paint?.length || block.playback).map(block => block.id), []);
    assert.ok([...state.caches].every(ref => !ref.deref()?.ticking));
  } finally {
    assert.equal(f.close().remainingTimers, 0);
  }
});

// Review ki4hq9du: an omitted agentSettled means no agent run, and empty final prose cannot hold back what follows.
test('without agentSettled a finished live run folds, and empty final prose lets its successor in', () => {
  let now = 0;
  attachMotionScheduler(() => {}, { now: () => now, setInterval: () => 1, clearInterval() {} });
  const cache = new HostRowsCache();
  try {
    const bash = { toolName: 'bash', args: { command: 'last' }, playbackSource: true, playbackEnded: true, executionStarted: true,
      result: { content: [{ type: 'text', text: 'ok' }], isError: false }, render: () => [] };
    const prose = { kind: 'prose', render: () => [] };
    const options = { classify: c => c.kind === 'prose' ? undefined : c, renderNative: c => c.render(), theme: false, expanded: false,
      styleEpoch: 0, confirmPaint: true, layoutId: 'chat', prose: c => c.kind === 'prose' ? { ended: true } : undefined };
    const drawAll = children => { for (let i = 0; i < 200; i++) { now += 25;
      for (const block of cache.prepare(children, 80, options).blocks) for (const span of block.paint ?? []) cache.acknowledge(span.id, span.text); } };
    drawAll([bash]);
    assert.deepEqual(cache.prepare([bash], 80, options).rows.filter(row => row.trim()), [' ● Ran 1 shell command']);
    const write = { toolName: 'write', args: { path: 'after.md', content: 'a' }, playbackSource: true, playbackEnded: true,
      result: { content: [], isError: false }, render: () => [] };
    drawAll([bash, prose, write]);
    assert.ok(cache.prepare([bash, prose, write], 80, options).rows.some(row => row.includes('after.md')));
  } finally {
    cache.dispose(); stopMotion();
  }
});

// CE1A & real-world streaming trigger paths: single-turn [thinking, text, toolCall] after message_start
// (both coalesced thinking+text render and sequential deltas with queued tool) delivers prose and tool and stops the clock.
for (const [label, playTurn] of [
  ['coalesced thinking+text render (CE1A / COND1)', async ({ emit, step }) => {
    await emit({ type: 'message_start', message: assistant([]) });
    // No tick in between: Pi's render throttle draws both updates in one frame.
    await emit({ type: 'message_update', message: assistant([{ type: 'thinking', thinking: 'Short thought.' }]) });
    await emit({ type: 'message_update', message: assistant([{ type: 'thinking', thinking: 'Short thought.' }, { type: 'text', text: 'Here is ' }]) });
    await step(4);
    const call = { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'ce1a.txt', content: 'ok' } };
    const msg = assistant([{ type: 'thinking', thinking: 'Short thought.' }, { type: 'text', text: 'Here is prose before tool.' }, call], 'toolUse');
    await emit({ type: 'message_update', message: msg });
    await step(20);
    await emit({ type: 'message_end', message: msg });
    await emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: call.arguments });
    await emit({ type: 'tool_execution_end', toolCallId: 'call-1', result: { content: [{ type: 'text', text: 'ok' }], isError: false }, isError: false });
  }],
  ['sequential deltas where thinking folds before tool_execution_start (COND2)', async ({ emit, step }) => {
    await emit({ type: 'message_start', message: assistant([]) });
    await emit({ type: 'message_update', message: assistant([{ type: 'thinking', thinking: 'Short thought.' }]) });
    await step(4);
    await emit({ type: 'message_update', message: assistant([{ type: 'thinking', thinking: 'Short thought.' }, { type: 'text', text: 'Here is prose before tool.' }]) });
    await step(4);
    const call = { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'ce1a.txt', content: 'ok' } };
    const msg = assistant([{ type: 'thinking', thinking: 'Short thought.' }, { type: 'text', text: 'Here is prose before tool.' }, call], 'toolUse');
    await emit({ type: 'message_update', message: msg });
    await emit({ type: 'message_end', message: msg });
    await step(60);
    await emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: call.arguments });
    await emit({ type: 'tool_execution_end', toolCallId: 'call-1', result: { content: [{ type: 'text', text: 'ok' }], isError: false }, isError: false });
  }],
]) test(`single-turn [thinking, text, toolCall] delivers prose and tool with bounded clock: ${label}`, async () => {
  const f = await createFixture({ width: 80, height: 24 });
  try {
    const emit = (e) => f.emit(e);
    const step = async (n = 1) => { for (let i = 0; i < n; i++) await f.tick(25); };
    await emit({ type: 'message_start', message: user('hi') });
    await emit({ type: 'message_end', message: user('hi') });
    await emit({ type: 'agent_start' });
    await emit({ type: 'turn_start' });
    await playTurn({ emit, step });
    await emit({ type: 'agent_end', messages: [] });
    await emit({ type: 'agent_settled' });
    let idleTick = -1;
    for (let i = 0; i < 600; i++) {
      await step();
      if ([...f.intervals.values()].filter(t => t.owner === 'motion').length === 0) { idleTick = i; break; }
    }
    const screen = f.mode.renderer.captureRenderState().previousLines.map(f.stripTerminalSequences).join('\n');
    assert.ok(idleTick >= 0, 'motion clock stops within bounded ticks');
    assert.match(screen, /Here is prose before tool\./);
    assert.match(screen, /ce1a\.txt/);
  } finally {
    assert.equal(f.close().remainingTimers, 0);
  }
});

// CE1B & COND4: two turns where Turn 1 settles a process item and Turn 2 streams [text, toolCall].
test('two-turn [text, toolCall] after a process item delivers second-turn prose and tool with bounded clock (CE1B)', async () => {
  const f = await createFixture({ width: 80, height: 24 });
  try {
    const emit = (e) => f.emit(e);
    const step = async (n = 1) => { for (let i = 0; i < n; i++) await f.tick(25); };
    await emit({ type: 'message_start', message: user('hi') });
    await emit({ type: 'message_end', message: user('hi') });
    await emit({ type: 'agent_start' });
    await emit({ type: 'turn_start' });
    const call1 = { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'a.txt', content: 'hello' } };
    const msg1 = assistant([call1], 'toolUse');
    await emit({ type: 'message_start', message: assistant([]) });
    await emit({ type: 'message_update', message: msg1 });
    await emit({ type: 'message_end', message: msg1 });
    await emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: call1.arguments });
    await emit({ type: 'tool_execution_end', toolCallId: 'call-1', result: { content: [{ type: 'text', text: 'wrote' }], isError: false }, isError: false });
    await step(60);
    const call2 = { type: 'toolCall', id: 'call-2', name: 'write', arguments: { path: 'b.txt', content: 'second' } };
    await emit({ type: 'message_start', message: assistant([]) });
    await emit({ type: 'message_update', message: assistant([{ type: 'text', text: 'Second prose after write.' }]) });
    const msg2 = assistant([{ type: 'text', text: 'Second prose after write.' }, call2], 'toolUse');
    await emit({ type: 'message_update', message: msg2 });
    await step(10);
    await emit({ type: 'message_end', message: msg2 });
    await emit({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'write', args: call2.arguments });
    await emit({ type: 'tool_execution_end', toolCallId: 'call-2', result: { content: [{ type: 'text', text: 'second' }], isError: false }, isError: false });
    await emit({ type: 'agent_end', messages: [] });
    await emit({ type: 'agent_settled' });
    let idleTick = -1;
    for (let i = 0; i < 600; i++) {
      await step();
      if ([...f.intervals.values()].filter(t => t.owner === 'motion').length === 0) { idleTick = i; break; }
    }
    const screen = f.mode.renderer.captureRenderState().previousLines.map(f.stripTerminalSequences).join('\n');
    assert.ok(idleTick >= 0, 'motion clock stops within bounded ticks');
    assert.match(screen, /Second prose after write\./);
    assert.match(screen, /b\.txt/);
  } finally {
    assert.equal(f.close().remainingTimers, 0);
  }
});

// CE1C: excluded mixed component does not start an unacknowledgeable prose flow or block subsequent items.
test('excluded mixed component does not strand a prose flow or block subsequent items (CE1C)', () => {
  let now = 0, armed = 0, tickFn;
  attachMotionScheduler(() => {}, {
    now: () => now,
    setInterval: (fn) => { armed++; tickFn = fn; return 1; },
    clearInterval: () => { armed--; },
  });
  const cache = new HostRowsCache();
  try {
    const mixedComp = {
      toolName: 'thinking', args: { thinking: 'Title' }, isStreaming: false,
      playbackSource: true, playbackEnded: true, nativePlacement: 'after',
      lastMessage: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Title' }, { type: 'text', text: 'Prose body' }] },
    };
    const afterEdit = {
      toolName: 'edit', args: { path: 'after-excluded.ts' }, result: { isError: false, content: [] },
      playbackSource: true, playbackEnded: true, setExpanded() {}, updateResult() {},
    };
    const opts = {
      classify: c => c, prose: c => c === mixedComp ? { ended: true } : undefined, renderNative: () => ['Prose body'],
      excludedComponents: new Set([mixedComp]), confirmPaint: true, expanded: false, styleEpoch: 0, layoutId: 'L',
    };
    for (let i = 0; i < 40; i++) {
      now += 25;
      if (armed > 0) tickFn?.();
      const res = cache.prepare([mixedComp, afterEdit], 80, opts);
      for (const b of res.blocks ?? []) for (const p of b.paint ?? []) cache.acknowledge(p.id, p.text);
    }
    const finalRes = cache.prepare([mixedComp, afterEdit], 80, opts);
    assert.equal(cache.gate.flows.size, 0);
    assert.equal(cache.ticking, false);
    assert.equal(armed, 0);
    assert.ok(finalRes.rows.some(r => r.includes('after-excluded.ts')));
  } finally {
    cache.dispose(); stopMotion();
  }
});

// CE1D: width <= 2 gap-row passages confirm popped receipts and disarm the clock.
test('width <= 2 passage confirms popped gap-row receipts and disarms the clock (CE1D)', () => {
  let now = 0, armed = 0, tickFn;
  attachMotionScheduler(() => {}, {
    now: () => now,
    setInterval: (fn) => { armed++; tickFn = fn; return 1; },
    clearInterval: () => { armed--; },
  });
  const cache = new HostRowsCache();
  try {
    const makeEdit = (path) => ({
      toolName: 'edit', args: { path }, result: { isError: false, content: [] },
      playbackSource: true, playbackEnded: true, setExpanded() {}, updateResult() {},
    });
    const children = [makeEdit('a.ts'), makeEdit('b.ts'), makeEdit('c.ts')];
    const zeroOpts = { classify: c => c, renderNative: () => [], confirmPaint: true, expanded: false, styleEpoch: 0, layoutId: 'L' };
    for (let i = 0; i < 100; i++) {
      now += 25;
      if (armed > 0) tickFn?.();
      const res = cache.prepare(children, 0, zeroOpts);
      for (const b of res.blocks ?? []) for (const p of b.paint ?? []) cache.acknowledge(p.id, p.text);
    }
    cache.prepare(children, 0, zeroOpts);
    assert.equal(cache.ticking, false);
    assert.equal(armed, 0);
    for (const id of ['settle:card:1:edit', 'settle:card:2:edit', 'settle:card:3:edit']) {
      assert.ok(cache.gate.settled.has(id), `${id} is settled`);
    }
  } finally {
    cache.dispose(); stopMotion();
  }
});

// CE1E: tiny terminal height (height = 2) where bottom regions occupy the viewport and document rows sit above previousViewportTop.
test('tiny terminal height (rows = 2) confirms scrolled-out receipts, admits subsequent tools, and stops the clock (CE1E)', async () => {
  const f = await createFixture({ width: 80, height: 2 });
  try {
    const emit = (e) => f.emit(e);
    const step = () => f.tick(25);
    await emit({ type: 'agent_start' });
    await emit({ type: 'turn_start' });
    const call = { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'tiny.txt', content: 'x' } };
    const msg = assistant([{ type: 'thinking', thinking: 'One line thought.' }, call], 'toolUse');
    await emit({ type: 'message_start', message: assistant([]) });
    await emit({ type: 'message_update', message: msg });
    await emit({ type: 'message_end', message: msg });
    await emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: call.arguments });
    await emit({ type: 'tool_execution_end', toolCallId: 'call-1', result: { content: [{ type: 'text', text: 'ok' }], isError: false }, isError: false });
    await emit({ type: 'agent_end', messages: [] });
    await emit({ type: 'agent_settled' });
    let idleTick = -1;
    for (let i = 0; i < 600; i++) {
      await step();
      if ([...f.intervals.values()].filter(t => t.owner === 'motion').length === 0) { idleTick = i; break; }
    }
    const adapter = f.Container.prototype[Symbol.for('pi-compact-ui2tree/container-render-v1')];
    const settled = [...adapter.caches].map(r => r.deref()).filter(Boolean).flatMap(c => [...c.gate.settled.keys()]);
    // At height 2 the editor and footer fill the screen: every document row is written once, above
    // the viewport, while its item still enters, so the screen keeps the entry placeholder. The
    // write is checked where it lives, in the document.
    const doc = f.mode.documentContainer.render(80).map(f.stripTerminalSequences).join('\n');
    assert.ok(idleTick >= 0, 'motion clock stops within bounded ticks at height = 2');
    assert.ok(settled.some(k => k.endsWith(':thinking')), 'thinking item settled');
    assert.ok(settled.some(k => k.endsWith(':write')), 'subsequent write item entered and settled');
    assert.match(doc, / ● Write\(tiny\.txt\)/);
  } finally {
    assert.equal(f.close().remainingTimers, 0);
  }
});

// Pi writes tabs as three spaces and decomposes the Thai/Lao AM vowels; a receipt for such a row
// is still confirmed, so what follows it enters and the clock stops.
for (const [label, content, tools] of [
  ['an edit whose diff has a tab', [], [{ id: 'e1', name: 'edit', args: { path: 'Makefile', edits: [{ oldText: 'a', newText: '\tgcc' }] },
    result: { content: [{ type: 'text', text: 'ok' }], details: { diff: '+1 \tgcc -o main main.c' }, isError: false } }]],
  ['a Thinking title with a tab and prose with ำ', [{ type: 'thinking', thinking: 'Inspect\tMakefile.\nThen write.' },
    { type: 'text', text: 'Writing PROSE_MARKER (คำ).' }], []],
]) test(`${label}: its receipt is confirmed and the next item enters`, async () => {
  const { f, emit, turn, prompt, drain } = await session(24);
  try {
    const screen = () => f.mode.renderer.captureRenderState().previousLines.map(f.stripTerminalSequences).join('\n');
    await emit({ type: 'agent_start' });
    await prompt('normalized rows');
    const write = { id: 'w1', name: 'write', args: { path: 'TOOL_MARKER.txt', content: 'ok' }, result: { content: [{ type: 'text', text: 'ok' }], isError: false } };
    await turn([...content, ...[...tools, write].map(t => ({ type: 'toolCall', id: t.id, name: t.name, arguments: t.args }))], [...tools, write], { chunk: 100000, rest: 0 });
    await emit({ type: 'agent_end', messages: [] });
    await drain(400);
    assert.match(screen(), /TOOL_MARKER\.txt/);
    if (content.length) assert.match(screen(), /PROSE_MARKER/);
  } finally {
    assert.equal(f.close().remainingTimers, 0, 'the motion clock stopped');
  }
});

// Prose is the host's rows folded at the current width. Once it ended and was all drawn, a narrower
// screen lays the same text out again: it does not play again, and what came after it stays.
test('finished prose stays finished when the width changes', async () => {
  const { f, emit, turn, prompt, drain, tick } = await session(24);
  try {
    const screen = () => f.mode.renderer.captureRenderState().previousLines.map(f.stripTerminalSequences).join('\n');
    await emit({ type: 'agent_start' });
    await prompt('resize');
    const text = Array.from({ length: 22 }, (_, i) => `Line ${i + 1}: a sixty-five column prose sentence that wraps when narrow.`).join('\n\n') +
      '\n\nFinal paragraph with PROSE_END_MARKER.';
    const write = { id: 'w1', name: 'write', args: { path: 'AFTER_PROSE.txt', content: 'ok' }, result: { content: [{ type: 'text', text: 'ok' }], isError: false } };
    await turn([{ type: 'text', text }, { type: 'toolCall', id: 'w1', name: 'write', arguments: write.args }], [write], { chunk: 200, rest: 0 });
    await emit({ type: 'agent_end', messages: [] });
    const moving = () => [...f.intervals.values()].some(timer => timer.owner === 'motion');
    for (let i = 0; i < 600 && moving(); i++) await tick(25);
    assert.equal(moving(), false, 'settled before the resize');
    assert.match(screen(), /PROSE_END_MARKER[\s\S]*AFTER_PROSE\.txt/);
    f.terminal.columns = 40;
    f.terminal.resize();
    for (let i = 0; i < 40; i++) {
      await tick(25);
      assert.match(screen(), /PROSE_END_MARKER[\s\S]*AFTER_PROSE\.txt/, `frame ${i} at the new width`);
      assert.equal(moving(), false, `frame ${i}: nothing plays again`);
    }
  } finally {
    assert.equal(f.close().remainingTimers, 0, 'the motion clock stopped');
  }
});
