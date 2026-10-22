import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOutputAssembler } from '../extensions/output-assembly.ts';

const processBlock = (id, rows, extra = {}) => ({ id, kind: 'structure', shape: id, rows, ...extra });
const nativeBlock = (id, rows) => ({ id, kind: 'native', shape: 'native', rows });
const rowsOf = (blocks) => blocks.flatMap(block => block.rows);
/** Each block's first host row. */
const starts = (blocks) => { let at = 0; return blocks.map(({ id, rows }) => { const start = { id, at }; at += rows.length; return start; }); };

test('output assembly preserves process gaps, paint offsets, and native ownership', () => {
  const output = createOutputAssembler();
  output.process([
    processBlock('first', ['FIRST']),
    processBlock('second', ['SECOND'], { paint: [{ id: 'second', text: 'S', from: 0, to: 1 }] }),
  ]);
  output.native({
    rows: ['', ' ', '\x1b[41m', 'NATIVE'],
    blocks: [nativeBlock('native', ['', ' ', '\x1b[41m', 'NATIVE'])],
  });
  const result = output.finish();
  assert.deepEqual(rowsOf(result), ['FIRST', 'SECOND', '', '\x1b[41m', 'NATIVE']);
  assert.deepEqual(starts(result), [
    { id: 'first', at: 0 }, { id: 'second', at: 1 }, { id: 'native', at: 2 },
  ]);
  assert.deepEqual(result[1].paint, [{ id: 'second', text: 'S', from: 0, to: 1 }]);
});

test('empty native and excluded mixed sources do not create rows or ownership', () => {
  const output = createOutputAssembler();
  output.process([]);
  output.process([processBlock('base', ['BASE'])]);
  output.native({ rows: ['', ' '], blocks: [nativeBlock('empty', ['', ' '])] });
  output.native({ mixed: true, excluded: true, rows: ['HIDDEN'], blocks: [nativeBlock('hidden', ['HIDDEN'])] });
  assert.deepEqual(output.finish(), [{ id: 'base', kind: 'structure', shape: 'base', sources: undefined,
    playback: undefined, paint: undefined, rows: ['BASE'] }]);
});

test('native rows before process remain contiguous and retain multiple block starts', () => {
  const output = createOutputAssembler();
  output.native({ rows: ['A', 'B'], blocks: [nativeBlock('a', ['A']), nativeBlock('b', ['B'])] });
  output.process([processBlock('process', ['P'])]);
  const result = output.finish();
  assert.deepEqual(rowsOf(result), ['A', 'B', '', 'P']);
  assert.deepEqual(starts(result), [
    { id: 'a', at: 0 }, { id: 'b', at: 1 }, { id: 'process', at: 2 },
  ]);
});

test('sealed prefix stays opaque while tail spans retain host offsets', () => {
  const output = createOutputAssembler();
  const sealedRows = ['H0', 'H1'];
  output.sealed({ id: 'sealed', kind: 'native', shape: 'sealed', sealed: true, rows: sealedRows }, false);
  output.process([processBlock('tail', ['T'], { paint: [{ id: 'p', text: 'T', from: 0, to: 1 }] })]);
  const result = output.finish();
  assert.deepEqual(rowsOf(result), ['H0', 'H1', '', 'T']);
  assert.deepEqual(starts(result), [
    { id: 'sealed', at: 0 }, { id: 'tail', at: 2 },
  ]);
  assert.equal(result[0].rows, sealedRows, 'the sealed rows are handed on, never copied');
});

test('discarded gap rows, excluded mixed blocks, and popped blank spans hand back their receipts', () => {
  const dropped = [];
  const output = createOutputAssembler(span => dropped.push([span.id, span.text]));
  output.process([processBlock('p1', [''], { paint: [{ id: 'settle:p1', text: 'settled', from: 0, to: 1, settled: true }] })]);
  output.process([processBlock('p2', ['VISIBLE'], { paint: [{ id: 'settle:p2', text: 'settled', from: 0, to: 1, settled: true }] })]);
  output.native({
    rows: [''],
    blocks: [{ ...nativeBlock('n1', ['']), paint: [{ id: 'prose:1', text: '\n', from: 0, to: 1 }] }],
  });
  output.native({
    mixed: true,
    excluded: true,
    rows: ['EXCLUDED'],
    blocks: [{ ...nativeBlock('n2', ['EXCLUDED']), paint: [{ id: 'prose:2', text: 'EXCLUDED', from: 0, to: 1 }] }],
  });
  output.native({
    rows: ['', 'BODY'],
    blocks: [{
      ...nativeBlock('n3', ['', 'BODY']),
      paint: [
        { id: 'prose:3-gap', text: '\n', from: 0, to: 1 },
        { id: 'prose:3-body', text: '\nBODY', from: 1, to: 2 },
      ],
    }],
  });
  const result = output.finish();
  assert.deepEqual(dropped, [
    ['settle:p1', 'settled'],
    ['prose:1', '\n'],
    ['prose:2', 'EXCLUDED'],
    ['prose:3-gap', '\n'],
  ]);
  assert.deepEqual(rowsOf(result), ['VISIBLE', '', 'BODY']);
  assert.deepEqual(result.find(s => s.id === 'n3')?.paint, [
    { id: 'prose:3-body', text: '\nBODY', from: 1, to: 2 },
  ]);
});
