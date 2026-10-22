import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piRoot } from "./pi-host.mjs";
import { installInputStyle } from "../extensions/editor.ts";

const host = name => import(pathToFileURL(join(piRoot, 'dist', name)).href);
const { CustomEditor } = await host('modes/interactive/components/custom-editor.js');
const { InteractiveMode } = await host('modes/interactive/interactive-mode.js');
const { KeybindingsManager } = await host('core/keybindings.js');
const statusModule = await host('modes/interactive/components/status-indicator.js');
const themeModule = await host('modes/interactive/theme/theme.js');
const { Container, Text, TuiMainScreen, CURSOR_MARKER, stripTerminalSequences: strip, visibleWidth, CombinedAutocompleteProvider } = await import('@earendil-works/pi-tui');
themeModule.initTheme('dark', false);
const getTheme = () => themeModule.theme;
const tui = { terminal: { rows: 24 }, requestRender() {}, getClearOnShrink: () => false };
const make = (paddingX = 1, embedded = true) => {
  const editor = new CustomEditor(tui, themeModule.getEditorTheme(), new KeybindingsManager(), { paddingX, embedWorkingStatus: embedded });
  editor.focused = true;
  return editor;
};
const state = editor => ({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor(), lines: editor.getLines() });
const plain = rows => rows.map(strip);
const marker = rows => {
  const y = rows.findIndex(row => row.includes(CURSOR_MARKER));
  return y < 0 ? undefined : { y, x: visibleWidth(rows[y].slice(0, rows[y].indexOf(CURSOR_MARKER))) };
};
const event = (x, y, width, height, type = 'click') => ({ x, y, width, height, type, button: 'left', shift: false, alt: false, ctrl: false });
const own = (object, key) => Object.getOwnPropertyDescriptor(object, key);
const pending = () => new Promise(resolve => setImmediate(resolve));
const timers = new Map();
let timerId = 0;
beforeEach((t) => {
  themeModule.initTheme("dark", false);
  timers.clear();
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const id = ++timerId; timers.set(id, { callback, delay }); return id;
  });
  t.mock.method(globalThis, "clearInterval", (id) => timers.delete(id));
});
afterEach(() => {
  assert.equal(timers.size, 0, "native indicators release their timers");
  themeModule.initTheme("dark", false);
});

test('input panel uses the live theme and preserves the native caret at narrow widths', () => {
  for (const theme of ['dark', 'light']) {
    themeModule.initTheme(theme, false);
    for (const width of [1, 2, 3, 4, 5, 40, 80]) {
      const editor = make(3), before = state(editor), style = installInputStyle(editor, getTheme);
      assert.ok(style);
      const rows = editor.render(width);
      assert.equal(editor.getPaddingX(), 3, 'adapter preserves the configured native padding');
      assert.equal(rows.length, 3); assert.deepEqual(state(editor), before);
      assert.equal(rows.filter(row => row.includes(CURSOR_MARKER)).length, 1);
      assert.ok(rows.every(row => visibleWidth(row) <= width), `${theme}/${width} overflow`);
      assert.equal(marker(rows).x, width >= 5 ? 2 : Math.min(1, Math.floor((width - 1) / 2)));
      assert.ok(rows.every(row => row.startsWith(getTheme().getBgAnsi('userMessageBg')) && row.endsWith('\x1b[0m')));
      if (width >= 40) assert.ok(plain(rows)[1].startsWith('› Ask Pi to do anything'));
      style.dispose(); assert.equal(editor.getPaddingX(), 3);
    }
  }
  themeModule.initTheme('dark', false);
});

test('styled input preserves native Unicode wrapping and cursor navigation', () => {
  for (const width of [1, 2, 3, 4, 5, 40, 80]) for (const text of ['abcdef', '界🙂é'.repeat(12), 'line one\n第二行 👩🏽‍💻\nlast']) {
    const styled = make(), native = make(); styled.setText(text); native.setText(text);
    const handleInput = styled.handleInput, style = installInputStyle(styled, getTheme);
    assert.equal(styled.handleInput, handleInput);
    const shift = width >= 5 ? 1 : 0;
    for (const key of ['', '\x1b[D', '\x1b[A', '\x1b[B', '\x01', '\x05']) {
      if (key) { styled.handleInput(key); native.handleInput(key); }
      let expected;
      try { expected = native.render(Math.max(1, width - shift)); }
      catch (error) {
        assert.ok(width <= 3 && error instanceof RangeError, 'only the native tiny-column wide-grapheme limitation is permitted');
        assert.throws(() => styled.render(width), RangeError);
        break;
      }
      const actual = styled.render(width);
      assert.deepEqual(state(styled), state(native));
      assert.deepEqual(plain(actual).slice(1, -1).map(row => row.slice(shift)), plain(expected).slice(1, -1));
      const a = marker(actual), e = marker(expected);
      assert.deepEqual(a, { x: e.x + shift, y: e.y });
    }
    style.dispose();
  }
});

test('install, module replacement and disposal preserve paste, history and undo', async () => {
  const editor = make(2), input = editor.handleInput;
  editor.addToHistory('HISTORY native');
  const payload = Array.from({ length: 12 }, (_, i) => `line ${i} native payload`).join('\n');
  editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
  const before = state(editor), descriptors = ['render', 'handleMouse'].map(key => own(editor, key));
  const first = installInputStyle(editor, getTheme);
  editor.render(40); assert.deepEqual(state(editor), before);
  const { installInputStyle: reloadInstall } = await import('../extensions/editor.ts?reload=second');
  const second = reloadInstall(editor, getTheme), render = editor.render;
  first.dispose(); assert.equal(editor.render, render);
  editor.render(80); assert.equal(editor.getExpandedText(), payload); assert.equal(editor.handleInput, input);
  editor.insertTextAtCursor(' appended'); editor.handleInput('\x1f');
  assert.equal(editor.getExpandedText(), payload);
  editor.handleInput('\x1f'); assert.equal(editor.getText(), '');
  editor.render(80); editor.handleInput('\x1b[A'); assert.equal(editor.getText(), 'HISTORY native');
  second.dispose(); assert.equal(editor.getPaddingX(), 2);
  assert.deepEqual(['render', 'handleMouse'].map(key => own(editor, key)), descriptors);
  assert.equal(editor.getText(), 'HISTORY native');
});

test('scroll labels and mouse coordinates track the native editor layout', () => {
  const styled = make(), native = make(), style = installInputStyle(styled, getTheme);
  const text = Array.from({ length: 22 }, (_, index) => `row ${index} 界🙂 text`).join('\n');
  styled.setText(text); native.setText(text);
  let rows = styled.render(40), other = native.render(39);
  assert.match(strip(rows[0]), /↑ \d+ more/);
  for (let step = 0; step < 2; step++) { styled.handleInput('\x1b[5~'); native.handleInput('\x1b[5~'); }
  rows = styled.render(40); other = native.render(39);
  assert.match(strip(rows.at(-1)), /↓ \d+ more/);
  for (const x of [0, 2, 8, 12, 39]) {
    const a = styled.handleMouse(event(x, 2, 40, rows.length));
    const b = native.handleMouse(event(x - 1, 2, 39, other.length));
    assert.deepEqual(a, b); assert.deepEqual(state(styled), state(native));
    styled.render(40); native.render(39);
  }
  const before = state(styled);
  assert.equal(styled.handleMouse(event(4, 2, 40, rows.length, 'press')), undefined);
  assert.deepEqual(state(styled), before);
  style.dispose();
});

test('working, retry and compaction keep their native indicator and timer ownership', () => {
  const editor = make(), style = installInputStyle(editor, getTheme);
  editor.setText('native draft');
  const mode = Object.assign(Object.create(InteractiveMode.prototype), { editor, defaultEditor: editor, statusContainer: new Container(), ui: tui, options: { tuiMode: 'regular' } });
  for (const create of [() => new statusModule.WorkingStatusIndicator(tui, 'Working native'), () => new statusModule.RetryStatusIndicator(tui, 1, 3, 3000), () => new statusModule.CompactionStatusIndicator(tui, 'manual')]) {
    const indicator = create();
    mode.showStatusIndicator(indicator);
    const timerCount = timers.size, rows = editor.render(40);
    assert.equal(timerCount, indicator.kind === 'retry' ? 2 : 1);
    assert.equal(mode.activeStatusIndicator, indicator); assert.equal(editor.workingStatusIndicator, indicator);
    assert.equal(mode.statusContainer.children.length, 0);
    assert.equal(rows.length, 5); assert.equal(timers.size, timerCount);
    assert.equal(marker(rows).y, 3); assert.equal(strip(rows[1]), '');
    assert.ok(!rows[0].includes(getTheme().getBgAnsi('userMessageBg')));
    const before = state(editor); assert.equal(editor.handleMouse(event(5, 0, 40, rows.length)), undefined); assert.deepEqual(state(editor), before);
    editor.handleMouse(event(4, 3, 40, rows.length)); assert.equal(editor.getCursor().col, 2);
    const flat = plain(rows).join('\n');
    const label = indicator.kind === 'working' ? 'Working native' : indicator.kind === 'retry' ? 'Retrying' : 'Compacting';
    assert.equal(flat.split(label).length - 1, 1);
  }
  mode.clearStatusIndicator(); assert.equal(timers.size, 0); assert.equal(editor.render(40).length, 3);
  style.dispose();
  const separate = make(1, false), nonembed = installInputStyle(separate, getTheme);
  const indicator = new statusModule.WorkingStatusIndicator(tui, 'outside editor'); separate.setWorkingStatusIndicator(indicator);
  assert.equal(separate.render(40).length, 3); indicator.dispose(); nonembed.dispose();
});

test('completion clicks follow native rows while panel color stays out of the menu', async () => {
  const styled = make(), native = make();
  const style = installInputStyle(styled, getTheme);
  const commands = [{ name: 'alpha', description: 'first' }, { name: 'beta', description: 'second' }];
  for (const editor of [styled, native]) { editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, '/data', null)); editor.handleInput('/'); }
  await pending(); await pending();
  assert.equal(styled.isShowingAutocomplete(), true); assert.equal(native.isShowingAutocomplete(), true);
  const indicator = new statusModule.WorkingStatusIndicator(tui, 'Working native'); styled.setWorkingStatusIndicator(indicator);
  const rows = styled.render(40), other = native.render(39);
  const end = 2 + styled.renderedVisibleLineCount + 2;
  assert.equal(rows.length - end, other.length - (native.renderedVisibleLineCount + 2));
  assert.deepEqual(plain(rows.slice(end)).map(row => row.slice(1)), plain(other.slice(native.renderedVisibleLineCount + 2)));
  assert.ok(rows.slice(end).every(row => !row.includes(getTheme().getBgAnsi('userMessageBg'))));
  styled.handleMouse(event(6, end + 1, 40, rows.length));
  native.handleMouse(event(5, native.renderedVisibleLineCount + 3, 39, other.length));
  assert.deepEqual(state(styled), state(native)); assert.match(styled.getText(), /beta/);
  styled.setPaddingX(3); const padded = styled.render(40);
  assert.equal(styled.getPaddingX(), 3); assert.equal(marker(padded).x, visibleWidth(styled.getText()) + 2);
  indicator.dispose(); styled.setWorkingStatusIndicator(undefined);
  const oldBg = getTheme().getBgAnsi('userMessageBg'); themeModule.initTheme('light', false);
  const newRows = styled.render(40); assert.notEqual(oldBg, getTheme().getBgAnsi('userMessageBg'));
  assert.ok(newRows[1].startsWith(getTheme().getBgAnsi('userMessageBg')));
  // The native cursor is a zero-width APC marker pair; TuiMainScreen resolves it before terminal output.
  assert.ok(newRows[1].includes('\x1b_pi:fc\x07') && newRows[1].includes('\x1b_pi:/fc\x07'), 'native cursor is a fake-cursor marker');
  style.dispose(); themeModule.initTheme('dark', false);
});

test('render failures restore native options and disposal preserves later wrappers', () => {
  const editor = make(3), top = own(editor, 'renderTopBorder'), bottom = own(editor, 'renderBottomBorder');
  const padding = own(editor, 'paddingX');
  let fail = true;
  const badTheme = () => ({ ...getTheme(), getBgAnsi: getTheme().getBgAnsi.bind(getTheme()), getFgAnsi: getTheme().getFgAnsi.bind(getTheme()), fg(key, value) { if (fail) throw new Error('theme render failure'); return getTheme().fg(key, value); } });
  const before = state(editor), first = installInputStyle(editor, badTheme);
  assert.throws(() => editor.render(40), /theme render failure/);
  assert.deepEqual(own(editor, 'paddingX'), padding, 'failed native layout restores the configured descriptor');
  assert.deepEqual(own(editor, 'renderTopBorder'), top); assert.deepEqual(own(editor, 'renderBottomBorder'), bottom); assert.deepEqual(state(editor), before);
  fail = false; editor.render(40);
  const wrapped = editor.render, mouse = editor.handleMouse;
  const foreignRender = function(width) { return wrapped.call(this, width); };
  const foreignMouse = function(event) { return mouse.call(this, event); };
  editor.render = foreignRender; editor.handleMouse = foreignMouse; first.dispose();
  assert.equal(editor.render, foreignRender); assert.equal(editor.handleMouse, foreignMouse); assert.equal(editor.getPaddingX(), 3);
  assert.match(strip(editor.render(40)[0]), /─/);
  const second = installInputStyle(editor, getTheme); assert.equal(editor.render(40).length, 3); second.dispose(); assert.equal(editor.render, foreignRender);
  const third = installInputStyle(editor, getTheme); editor.setPaddingX(2); third.dispose(); assert.equal(editor.getPaddingX(), 2, 'later external padding is not overwritten');
});

test('native actions, submission and focus remain owned by the original editor', () => {
  const editor = make(), style = installInputStyle(editor, getTheme);
  const calls = [], submitted = [];
  editor.onAction('app.tools.expand', () => calls.push('expand'));
  editor.onEscape = () => calls.push('escape');
  editor.onCtrlD = () => calls.push('exit');
  editor.onPasteImage = () => calls.push('image');
  editor.onExtensionShortcut = value => value === 'X' ? (calls.push('extension'), true) : false;
  editor.onSubmit = text => submitted.push(text);
  for (const key of ['\x0f', '\x1b', '\x04', '\x16', 'X']) editor.handleInput(key);
  assert.deepEqual(calls, ['expand', 'escape', 'exit', 'image', 'extension']);
  assert.equal(editor.getText(), '');
  editor.focused = false; assert.equal(marker(editor.render(40)), undefined);
  editor.focused = true; assert.deepEqual(marker(editor.render(40)), { x: 2, y: 1 });
  editor.handleInput('hello'); editor.render(40); editor.handleInput('\r');
  assert.deepEqual(submitted, ['hello']);
  assert.equal(editor.getText(), '');
  style.dispose();
});

test('unsupported editor subclasses retain their own renderer', () => {
  const text = new Text('custom', 0, 0), render = text.render;
  assert.equal(installInputStyle(text, getTheme), undefined); assert.equal(text.render, render);
  class OtherEditor extends CustomEditor {}
  const other = new OtherEditor(tui, themeModule.getEditorTheme(), new KeybindingsManager());
  const before = other.render; assert.equal(installInputStyle(other, getTheme), undefined); assert.equal(other.render, before);
});

test('native scheduler becomes idle after styled input at every configured padding', async () => {
  for (const padding of [0, 1, 3]) {
    const writes = [];
    const screen = new TuiMainScreen({ columns: 40, rows: 24, write: value => writes.push(value),
      hideCursor() {}, showCursor() {}, start() {}, stop() {} }, false);
    const editor = new CustomEditor(screen, themeModule.getEditorTheme(), new KeybindingsManager(), { paddingX: padding });
    const configured = own(editor, 'paddingX');
    screen.addChild(editor);
    screen.setFocus(editor);
    const style = installInputStyle(editor, getTheme);
    const nativeDraw = screen.doRender, nativeRequest = screen.requestRender;
    let draws = 0, duringDraw = 0, drawing = false;
    screen.requestRender = function(...args) {
      if (drawing) duringDraw++;
      return nativeRequest.apply(this, args);
    };
    screen.doRender = function(...args) {
      drawing = true;
      try { return nativeDraw.apply(this, args); }
      finally { drawing = false; draws++; if (draws >= 6) screen.stop(); }
    };
    async function settle(action) {
      const before = draws;
      action();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(draws - before, 1, `padding ${padding}: one requested draw then idle`);
      assert.equal(duringDraw, 0, 'display preparation must not schedule a new frame');
      assert.equal(screen.renderRequested, false);
      assert.equal(screen.renderTimer, undefined);
      assert.equal(editor.getPaddingX(), configured.value);
      assert.deepEqual(own(editor, 'paddingX'), configured);
    }
    try {
      await settle(() => screen.requestRender());
      await settle(() => screen.handleTerminalInput('界 native'));
      assert.equal(editor.getText(), '界 native');
      assert.match(strip(screen.captureRenderState().previousLines.join('\n')), /界 native/);
      assert.ok(writes.length > 0, 'the real terminal diff renderer ran');
      // A public setting change still schedules a legitimate frame; render does not undo the preference.
      configured.value = padding === 3 ? 0 : 3;
      await settle(() => editor.setPaddingX(configured.value));
      editor.handleMouse(event(2, 1, 40, 3));
      assert.equal(editor.getCursor().col, 0);
      assert.deepEqual(own(editor, 'paddingX'), configured);
    } finally { style.dispose(); screen.stop(); }
  }
});
