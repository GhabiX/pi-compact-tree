import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  basename, isSpawnTool, isVisibleNativeRows, thinkingFlowLimit, statusMarker,
  stripAnsi, toolCallText, toolLabel, toolPreview, thinkingTitle, renderThinking,
  renderTool, renderRun, runSummary, MAX_COLUMNS, proseFlowLimit, pacedRows, rowText, BODY_ROWS, DIFF_ROWS,
} from '../extensions/format.ts';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { fg256 } from '../extensions/colors.ts';

const card = (toolName, args = {}, status = 'completed', output) => ({ toolName, args, status, output });
const opts = (extra = {}) => ({ width: 80, theme: false, expanded: false, pulse: 0, ...extra });
const thinking = text => ({ ...card('thinking'), detail: text });
const plain = rows => rows.map(stripTerminalSequences);

test('run summaries count verbs and nouns in first-appearance order and combine shell aliases', () => {
  assert.equal(runSummary([card('read'), card('bash'), card('read'), card('powershell'), card('ls'), card('ls'), card('web_search'), card('web_search'), card('custom_tool')]),
    'Read 2 files, ran 2 shell commands, listed 2 directories, searched the web for 2 queries, called Custom Tool 1 time');
  assert.equal(runSummary([card('grep'), card('find'), card('codemode')]), 'Searched for 1 pattern, searched for 1 file pattern, ran 1 script');
});
test('a folded run is one summary plus each failed call, including codemode inner failures', () => {
  const cards = [card('read', { path: 'good' }), card('bash', { command: 'bad' }, 'errored', 'Error: failed'),
    { ...card('codemode'), calls: [{ name: 'read', args: '{"path":"missing"}', status: 'error', error: 'ENOENT' }] }];
  assert.deepEqual(renderRun(cards, opts({ current: false })), [
    ' ● Read 1 file, ran 1 shell command, ran 1 script',
    '   ⎿  Bash(bad) · Error: failed',
    '   ⎿  Read(missing) · Error: ENOENT',
  ]);
  const cancelled = { ...card('codemode'), calls: [{ name: 'bash', args: '{"command":"slow"}', status: 'cancelled' }] };
  assert.match(renderRun([cancelled], opts({ current: false })).join('\n'), /Bash\(slow\) · Cancelled/);
});
test('a script gets a failure row per failed inner call, and its own row only when none failed', () => {
  const calls = [{ name: 'read', args: '{"path":"a"}', status: 'error', error: 'MISSING_A' },
    { name: 'bash', args: '{"command":"false"}', status: 'error', error: 'FAILED_B' },
    { name: 'bash', args: '{"command":"sleep 9"}', status: 'cancelled' }];
  const script = status => ({ toolName: 'codemode', args: { code: 'x' }, status, output: 'outer failure', calls });
  for (const status of ['completed', 'errored']) {
    const rows = renderRun([script(status)], { width: 80, theme: false, expanded: false, pulse: 0, current: false });
    assert.equal(rows.length, 4, rows.join('\n'));
    assert.match(rows[1], /MISSING_A/); assert.match(rows[2], /FAILED_B/); assert.match(rows[3], /Cancelled/);
  }
  const outer = renderRun([{ ...script('errored'), calls: [] }], { width: 80, theme: false, expanded: false, pulse: 0, current: false });
  assert.equal(outer.length, 2); assert.match(outer[1], /Error: outer failure/);
});
test('current run call shows output until folded and Ctrl+O includes every call', () => {
  const cards = [card('bash', { command: 'first' }, 'completed', 'FIRST'), card('bash', { command: 'next' }, 'running', 'NEXT')];
  assert.deepEqual(renderRun(cards, opts({ current: true })), [' ● Ran 2 shell commands', '   ⎿  Bash(next)', '      NEXT']);
  assert.deepEqual(renderRun(cards, opts({ current: false })), [' ● Ran 2 shell commands']);
  assert.match(renderRun(cards, opts({ current: false, expanded: true })).join('\n'), /FIRST[\s\S]*NEXT/);
});
test('Thinking title is its first clause, skips leading Markdown and adds ellipsis only for word truncation', () => {
  for (const text of ['**Inspect files**. Then run tests.', '# Inspect files\nThen run tests.', 'Inspect files，then run tests']) {
    const title = thinkingTitle(text);
    assert.equal(text.slice(title.start, title.end), 'Inspect files');
    assert.equal(title.cut, false);
    assert.equal(renderThinking(thinking(text), opts({ text, window: false })).rows[0], ' ● Inspect files');
  }
  const words = Array.from({ length: 11 }, (_, i) => 'word' + i);
  const text = words.join(' ');
  const title = thinkingTitle(text);
  assert.equal(text.slice(title.start, title.end), words.slice(0, 10).join(' '));
  assert.equal(title.cut, true);
  assert.equal(renderThinking(thinking(text), opts({ text, window: false })).rows[0], ' ● ' + words.slice(0, 10).join(' ') + '…');
  const exact = words.slice(0, 10).join(' ');
  assert.equal(thinkingTitle(exact).cut, false);
});
test('Thinking first-clause parsing handles punctuation inside a bold heading', () => {
  const text = '**Inspect files.** Then run tests.';
  const title = thinkingTitle(text);
  assert.equal(text.slice(title.start, title.end), 'Inspect files');
  assert.equal(renderThinking(thinking(text), opts({ text, window: false })).rows[0], ' ● Inspect files');
});
test('Thinking title respects CJK clauses, Unicode words and terminal widths', () => {
  const text = '**检查实现逻辑，保留当前语义。** 屏幕宽度变化时，需要正确显示中文和 English words，以及 emoji 👩‍💻。';
  const title = thinkingTitle(text);
  assert.equal(text.slice(title.start, title.end), '检查实现逻辑');
  for (const width of [1, 5, 12, 20, 40, 80, 300]) {
    const rows = renderThinking(thinking(text), opts({ width, text, window: false })).rows;
    assert.equal(rows.length, 1);
    assert.ok(visibleWidth(rows[0]) <= Math.max(0, Math.min(width - 2, MAX_COLUMNS)));
    assert.doesNotMatch(rows[0], /\*\*|\n|\uFFFD/);
  }
});
test('Thinking streams up to eight body rows without a top omission row; Ctrl+O shows its first eight', () => {
  const text = Array.from({ length: 21 }, (_, i) => 'line ' + i).join('\n');
  const compact = renderThinking(thinking(text), opts({ text, window: true }));
  assert.equal(compact.rows.length, 9);
  assert.equal(compact.rows[0], ' ● line 0');
  assert.equal(compact.rows[1], '   line 13');
  assert.equal(compact.rows.at(-1), '   line 20');
  assert.deepEqual(compact.paced, { from: 0, to: 9 });
  assert.equal(BODY_ROWS, 8);
  assert.deepEqual(renderThinking(thinking(text), opts({ text, window: false, expanded: true })).rows,
    [' ● line 0', ...Array.from({ length: 8 }, (_, i) => '   line ' + (i + 1)), '   … +12 lines']);
  // A playing window keeps its paced newest rows under Ctrl+O.
  assert.deepEqual(renderThinking(thinking(text), opts({ text, window: true, expanded: true })).rows, compact.rows);
});
test('Thinking title prefix grows literally during playback and stays fixed while folding', () => {
  const text = 'Inspect renderer.\nMore detail';
  const c = thinking(text);
  assert.deepEqual(renderThinking(c, opts({ text: 'Ins', window: true })).rows, [' ● Ins']);
  assert.equal(renderThinking(c, opts({ text, window: true })).rows[0], renderThinking(c, opts({ text, window: false })).rows[0]);
  // A title cut at the word limit gets its ellipsis once written out, and keeps it through the fold.
  const long = Array.from({ length: 12 }, (_, i) => 'w' + i).join(' '), cut = thinking(long);
  assert.equal(renderThinking(cut, opts({ text: 'w0 w1', window: true })).rows[0], ' ● w0 w1');
  assert.equal(renderThinking(cut, opts({ text: long, window: true })).rows[0], renderThinking(cut, opts({ text: long, window: false })).rows[0]);
  assert.match(renderThinking(cut, opts({ text: long, window: true })).rows[0], /w9…$/);
});
test('running output keeps four tail rows; completed output keeps three head rows plus omitted count', () => {
  const output = Array.from({ length: 10 }, (_, i) => 'line ' + i).join('\n');
  assert.deepEqual(renderTool(card('bash', { command: 'cmd' }, 'running', output), opts()), [
    ' ● Bash(cmd)', '   ⎿  … +6 lines', '      line 6', '      line 7', '      line 8', '      line 9']);
  assert.deepEqual(renderTool(card('bash', { command: 'cmd' }, 'completed', output), opts()), [
    ' ● Bash(cmd)', '   ⎿  line 0', '      line 1', '      line 2', '      … +7 lines']);
});
test('read and write summaries count lines and edit diffs retain two context rows with one skipped-stretch marker', () => {
  assert.deepEqual(renderTool(card('read', { path: 'a' }, 'completed', 'a\nb'), opts()), [' ● Read(a)', '   ⎿  Read 2 lines']);
  assert.deepEqual(renderTool(card('write', { path: 'a', content: 'one\ntwo' }), opts()), [' ● Write(a)', '   ⎿  Wrote 2 lines to a']);
  const diff = Array.from({ length: 18 }, (_, i) => (i === 3 || i === 14 ? '+' : ' ') + 'line' + i).join('\n');
  const rows = renderTool({ ...card('edit', { path: 'a' }), diff }, opts());
  assert.deepEqual(rows.slice(2).map(r => r.slice(6)), [' line1', ' line2', '+line3', ' line4', ' line5', '     ⋯', ' line12', ' line13', '+line14', ' line15', ' line16']);
  assert.equal(rows[1], '   ⎿  Updated a with 2 additions and 0 removals');
  const many = renderTool({ ...card('edit', { path: 'a' }), diff: Array.from({ length: 30 }, (_, i) => '+' + i).join('\n') }, opts());
  assert.equal(many.length, 23);
  assert.equal(many.at(-1), '      … +10 lines');
});
test('Ctrl+O preserves multiline shell input, blank lines, tabs, Unicode and extra arguments up to BODY_ROWS rows', () => {
  const command = "python3 - <<'PY'\n\tvalue = '中文é👩‍💻'\n\nprint(value)\nPY";
  const c = card('bash', { command, timeout: 1000 });
  assert.equal(toolCallText(c), command + '\n\nArguments:\n{\n  "timeout": 1000\n}');
  const rows = renderTool(c, opts({ width: 120, expanded: true }));
  assert.deepEqual(rows.slice(1), ["   ⎿  python3 - <<'PY'", "         value = '中文é👩‍💻'", '      ', '      print(value)', '      PY', '      ',
    '      Arguments:', '      {', '      … +2 lines']);
  const short = renderTool(card('bash', { command: 'cmd', timeout: 1000 }), opts({ width: 120, expanded: true }));
  assert.match(short.join('\n'), /"timeout": 1000/);
});
test('Ctrl+O shows each tool in at most BODY_ROWS rows: running keeps the tail, completed the head; diffs keep DIFF_ROWS', () => {
  const output = Array.from({ length: 12 }, (_, i) => 'out ' + i).join('\n');
  assert.deepEqual(renderTool(card('bash', { command: 'cmd' }, 'running', output), opts({ expanded: true })),
    [' ● Bash(cmd)', '   ⎿  … +5 lines', ...Array.from({ length: 8 }, (_, i) => '      out ' + (i + 4))]);
  assert.deepEqual(renderTool(card('bash', { command: 'cmd' }, 'completed', output), opts({ expanded: true })),
    [' ● Bash(cmd)', '   ⎿  cmd', ...Array.from({ length: 7 }, (_, i) => '      out ' + i), '      … +5 lines']);
  // One row over the limit shows in full rather than as an omission row.
  assert.equal(renderTool(card('bash', { command: 'cmd' }, 'completed', Array.from({ length: 8 }, (_, i) => 'o' + i).join('\n')), opts({ expanded: true })).length, 10);
  // Wrapped rows count: a long output line takes the rows it occupies.
  const wide = renderTool(card('bash', { command: 'cmd' }, 'completed', 'x'.repeat(30 * 12)), opts({ width: 40, expanded: true }));
  assert.equal(wide.length, 1 + BODY_ROWS + 1);
  assert.match(wide.at(-1), /… \+\d+ lines$/);
  const diff = Array.from({ length: 30 }, (_, i) => '+' + i).join('\n');
  const edit = renderTool({ ...card('edit', { path: 'a' }), diff }, opts({ expanded: true }));
  assert.deepEqual(edit.slice(1, 4), ['   ⎿  {', '        "path": "a"', '      }']);
  assert.equal(edit.length, 4 + DIFF_ROWS + 1);
  assert.equal(edit.at(-1), '      … +10 lines');
});
test('spawn exclusion, labels and preview normalization preserve semantic arguments', () => {
  assert.equal(isSpawnTool('spine_spawn'), true);
  assert.equal(isSpawnTool('spine_open'), false);
  assert.equal(isSpawnTool('bash'), false);
  for (const [name, args, expected] of [
    ['read', { path: '/tmp/foo/bar.ts' }, '/tmp/foo/bar.ts'],
    ['bash', { command: 'git status' }, 'git status'],
    ['spine_open', { goal: 'inspect renderer' }, 'inspect renderer'],
    ['spine_close', { memory: 'done' }, ''],
    ['grep', { pattern: 'ToolExecutionComponent' }, 'ToolExecutionComponent'],
    ['web_search', { queries: ['pi tui flicker'] }, 'pi tui flicker'],
    ['thinking', { thinking: 'secret' }, 'secret'],
    ['spine_next', { summary: 'next branch' }, 'next branch'],
  ]) assert.equal(toolPreview(name, args), expected);
  for (const [name, label] of [['spine_open','Open'],['spine_close','Close'],['powershell','Powershell'],['web_search','Web Search'],['custom_tool','Custom Tool']]) assert.equal(toolLabel(name), label);
  for (const [path, base] of [['.','.'],['~','~'],['/a/b/c','c']]) assert.equal(basename(path), base);
  assert.equal(toolPreview('bash', { command: 'set -e\n pwd' }), 'set -e pwd');
  const preview = toolPreview('notice', { text: '\x1b[33mCache miss\x1b[39m' });
  assert.equal(stripAnsi(preview), preview);
  assert.doesNotMatch(preview, /\x1b/);
});
test('tool rows use flat dots and cap process text at 100 columns with a two-column gutter', () => {
  for (const status of ['running', 'completed', 'errored']) assert.equal(statusMarker(status), '●');
  assert.equal(statusMarker('notice'), '!');
  for (const width of [0, 1, 12, 32, 85, 190, 400]) {
    const rows = renderTool(card('bash', { command: '查看 '.repeat(100) }, 'completed', '日志'.repeat(100)), opts({ width }));
    assert.ok(rows.every(row => visibleWidth(row) <= Math.max(0, Math.min(width - 2, MAX_COLUMNS))));
    assert.ok(rows.every(row => !/[\n\uFFFD]/u.test(row)));
  }
});
test('notice and provider errors retain complete diagnostic text in their own rows', () => {
  assert.deepEqual(renderTool(card('cache_miss', { text: 'Cache miss: 59k tokens re-billed' }, 'notice'), opts()), [' ! Cache miss: 59k tokens re-billed']);
  assert.deepEqual(renderTool(card('provider_error', { text: 'Error: failed' }, 'errored'), opts()), [' ● Error: failed']);
  const rows = renderTool(card('cache_miss', { text: 'Cache miss' }, 'notice'), opts({ theme: { bold: t => t } }));
  assert.ok(rows[0].includes(fg256('warning', 'Cache miss')));
});
test('OSC-only native rows are invisible successors; substantive text is visible', () => {
  for (const row of ['', '   ', '\x1b]133;A\x07']) assert.equal(isVisibleNativeRows([row]), false);
  assert.equal(isVisibleNativeRows(['later']), true);
});
test('Thinking grants one line at a time, grants newline separately and preserves graphemes', () => {
  const full = 'abcd\nefgh\n';
  assert.equal(thinkingFlowLimit(full, '', 12), 'abcd');
  assert.equal(thinkingFlowLimit(full, 'abcd', 12), 'abcd\n');
  assert.equal(thinkingFlowLimit(full, 'abcd\n', 12), 'abcd\nefgh');
  assert.equal(thinkingFlowLimit('中文👍🏽tail', '', 9), '中文');
  const giant = 'e' + '\u0301'.repeat(100);
  assert.equal(thinkingFlowLimit(giant + 'next', '', 1), giant);
});
for (const width of [20,40,80]) test(`Thinking grants respect word wrapping at ${width} columns`, () => {
  const text = 'Inspect files.\n' + '**renderer** longwordlongword 中英文 👩‍💻 next step '.repeat(12);
  let shown = '', height = 1;
  while (shown !== text) {
    const next = thinkingFlowLimit(text, shown, width);
    assert.ok(next.length > shown.length && text.startsWith(next));
    const rows = renderThinking(thinking(text), opts({ width, text: next, window: true })).rows;
    assert.ok(rows.length - height <= 1, `grant ${shown.length} to ${next.length} gained multiple rows`);
    assert.ok(rows.length >= height);
    shown = next; height = rows.length;
  }
});
test('prose grants through the next row and paced rows retain ANSI and terminal cell widths', () => {
  assert.equal(proseFlowLimit('abc\ndef\nghi', ''), 'abc\n');
  assert.equal(proseFlowLimit('abc\ndef\nghi', 'abc\n'), 'abc\ndef\n');
  assert.equal(proseFlowLimit('abc', ''), 'abc');
  const rows = ['\x1b[31m中文\x1b[39m  ', 'tail'];
  assert.equal(rowText(rows[0]), '中文');
  assert.deepEqual(pacedRows(rows, ''), []);
  assert.deepEqual(plain(pacedRows(rows, '中')), ['中']);
  assert.deepEqual(pacedRows(rows, '中文\ntail'), rows);
});
test('no row is wider than a very narrow screen', () => {
  for (let width = 0; width <= 6; width++) {
    const rows = [
      ...renderThinking(thinking('Title.\nBody of the thought'), opts({ width, text: 'Title.\nBody of the thought', window: true })).rows,
      ...renderThinking(thinking('Title.\nBody of the thought'), opts({ width, text: 'Title.\nBody of the thought', window: false, expanded: true })).rows,
      ...renderTool(card('bash', { command: 'ls' }, 'completed', 'a\nb'), opts({ width, expanded: true })),
      ...renderTool(card('bash', { command: 'ls' }, 'completed', 'a\nb'), opts({ width })),
    ];
    for (const row of rows) assert.ok(visibleWidth(row) <= width, `width ${width}: ${JSON.stringify(row)}`);
  }
});
