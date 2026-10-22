// The receipt compares rows in the form Pi writes them; Pi's own normalizer is not exported, so check against it here.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { configure } from './replay/source.mjs';

const source = configure();
after(() => { source.verify(); source.hook.deregister(); });
const { hostRow, hostText } = await import('../extensions/compact-ui2tree.ts');
const { normalizeTerminalOutput, stripTerminalSequences } = await import(new URL('./utils.js', import.meta.resolve('@earendil-works/pi-tui')));

test('hostRow is the row Pi writes and hostText its text; both stay put on rows Pi already wrote', () => {
  for (const row of ['plain', '\tindented\tcode', '\x1b[31m\tred\x1b[0m', 'คำ ລຳ', 'tail spaces   ', '\x1b]8;;https://x\x07link\x1b]8;;\x07\t']) {
    const written = normalizeTerminalOutput(row);
    assert.equal(hostRow(row), written, JSON.stringify(row));
    assert.equal(hostRow(written), written, JSON.stringify(row));
    assert.equal(hostText(row), stripTerminalSequences(written).trimEnd(), JSON.stringify(row));
    assert.equal(hostText(written), hostText(row), JSON.stringify(row));
  }
});
