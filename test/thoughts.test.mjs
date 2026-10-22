import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { configure } from './replay/source.mjs';
const source = configure();
const { createFixture } = await import('./replay/fixture.mjs');
const { wrapTextWithAnsi } = await import('@earendil-works/pi-tui');
const { showThoughts } = await import('../extensions/thoughts.ts');
after(() => { source.verify(); source.hook.deregister(); });
const saved = parts => ({ role: 'assistant', content: parts.map(thinking => ({ type: 'thinking', thinking })), stopReason: 'stop', timestamp: 1 });

for (const width of [40, 80]) test(`/thoughts pages all saved blocks over frozen history and preserves the editor at ${width} columns`, async t => {
  const f = await createFixture({ width }), root = f.mode.renderer, strip = f.stripTerminalSequences;
  t.after(() => { if (root.hasOverlay()) root.hideOverlay(); assert.equal(f.close().remainingTimers, 0); });
  assert.deepEqual([...f.commands.keys()], ['thoughts'], 'Pi /thinking is not replaced');
  const blocks = [0, 1].map(block => Array.from({ length: 24 }, (_, i) => `ROW_${block * 24 + i} 中文 source words END_${block * 24 + i}`).join('\n'));
  f.sessionManager.appendMessage(saved(['EARLY_THOUGHT retained.'])); f.sessionManager.appendMessage(saved(blocks));
  const user = { role: 'user', content: [{ type: 'text', text: Array.from({ length: 40 }, (_, i) => `LATER_USER_${i}`).join('\n') }], timestamp: 2 };
  await f.emit({ type: 'message_start', message: user }); await f.emit({ type: 'message_end', message: user }); await f.frame();
  const editor = f.mode.editor;
  editor.handleInput('\x1b[200~' + Array.from({ length: 20 }, (_, i) => `PASTED_${i}`).join('\n') + '\x1b[201~'); await f.frame();
  const draft = editor.getText(), expanded = editor.getExpandedText(), before = root.captureRenderState();
  assert.ok(before.previousViewportTop > 0);
  const promise = f.commands.get('thoughts').handler('', f.context); await Promise.resolve(); await Promise.resolve(); await f.frame();
  assert.equal(root.hasOverlay(), true);
  const expected = wrapTextWithAnsi(blocks.join('\n\n'), width), seen = new Set();
  let done = false;
  for (let page = 0; page < 20 && !done; page++) {
    const host = root.captureRenderState(), rows = host.previousLines.slice(host.previousViewportTop, host.previousViewportTop + f.terminal.rows).map(strip);
    assert.match(rows[0], /^Thinking 2\/2/);
    const [, first, last, total] = rows[0].match(/· (\d+)–(\d+)\/(\d+)/);
    assert.equal(+total, expected.length);
    assert.deepEqual(rows.slice(1, 1 + (+last - +first + 1)).map(row => row.trimEnd()), expected.slice(+first - 1, +last).map(row => row.trimEnd()));
    for (let line = +first - 1; line < +last; line++) seen.add(line);
    assert.deepEqual(host.previousLines.slice(0, before.previousViewportTop), before.previousLines.slice(0, before.previousViewportTop), 'overlay leaves frozen bytes intact');
    done = +last === +total;
    if (!done) { f.terminal.input('\x1b[6~'); await f.frame(); }
  }
  assert.ok(done); assert.equal(seen.size, expected.length, 'every saved line was actually displayed');
  f.terminal.input('\x1b[D'); await f.frame(); assert.ok(root.captureRenderState().previousLines.some(row => strip(row).includes('EARLY_THOUGHT')));
  f.terminal.input('\x1b[C'); f.terminal.input('\x1b[F'); await f.frame(); assert.ok(root.captureRenderState().previousLines.some(row => strip(row).includes('END_47')));
  await f.resize({ columns: width === 40 ? 80 : 40 }); await f.frame(); f.terminal.input('\x1b[H'); await f.frame();
  assert.ok(root.captureRenderState().previousLines.some(row => strip(row).includes('ROW_0')));
  f.terminal.input('\x1b'); await promise; await f.frame();
  assert.equal(root.hasOverlay(), false); assert.equal(f.mode.editor, editor); assert.equal(root.getFocusedComponent(), editor);
  assert.equal(editor.getText(), draft); assert.equal(editor.getExpandedText(), expanded, 'large paste map is preserved by closing overlay');
});

test('Thinking readback does not open a viewer outside TUI or without saved Thinking', async () => {
  await showThoughts({ mode: 'rpc', sessionManager: { getBranch() { assert.fail('RPC does not read session content'); } } });
  const notices = [];
  await showThoughts({ mode: 'tui', sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: [] } }] },
    ui: { notify: (...args) => notices.push(args), custom() { assert.fail('empty branch opens no overlay'); } } });
  assert.deepEqual(notices, [['No saved Thinking in this session branch.', 'info']]);
});
