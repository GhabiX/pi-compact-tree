import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { renderTool, renderThinking, renderRun, toolLabel } from '../extensions/format.ts';
import { fg256, pulse256 } from '../extensions/colors.ts';
import { renderTreeLines } from './support/reference-tree.mjs';
const theme = { bold: text => `\x1b[1m${text}\x1b[22m`, fg() { assert.fail('indexed palette owns process colors'); } };
const options = { width: 120, theme, expanded: false, pulse: 0 };
test('completed flat dots are green and tool titles retain bold text', () => {
  for (const toolName of ['bash','read','spine_open','exec']) {
    const card = { toolName, args: { command: 'pwd', path: 'a.md', goal: 'inspect', code: 'return 1' }, status: 'completed' };
    const row = renderTool(card, options)[0];
    assert.ok(row.includes(fg256('success', '●')));
    assert.ok(row.includes(theme.bold(toolLabel(toolName))));
    assert.doesNotMatch(row, /\x1b\[38;2;/u);
    assert.equal(stripTerminalSequences(row), renderTool(card, { ...options, theme: false })[0]);
  }
  const card = { toolName: 'thinking', args: {}, status: 'completed', detail: 'Inspect files. More detail' };
  const row = renderThinking(card, { ...options, text: card.detail, window: false }).rows[0];
  assert.ok(row.includes(fg256('dim', '●')));
  assert.ok(row.includes(theme.bold('Inspect files')));
});
test('run expansion keeps text, fixed colors and active breathing markers', () => {
  const cards = ['first','second'].map(command => ({ toolName: 'bash', args: {command}, status: 'completed', output: command }));
  for (const expanded of [false, true]) for (const width of [20,40,120]) {
    const rows = renderTreeLines(cards, theme, width, expanded);
    assert.deepEqual(rows.map(stripTerminalSequences), renderTreeLines(cards, false, width, expanded).map(stripTerminalSequences));
    assert.ok(rows.filter(row => row.includes('●')).every(row => row.includes(fg256('success','●'))));
  }
  for (const [status, expected] of [['running', pulse256(0, '●')], ['errored', fg256('error','●')], ['notice',fg256('warning','!')]]) {
    assert.ok(renderTool({ ...cards[0], status }, options)[0].includes(expected));
  }
  const mixed = renderRun([cards[0], { ...cards[1], status: 'running' }], { ...options, current: true });
  assert.ok(mixed[0].includes(pulse256(0,'●')));
});
