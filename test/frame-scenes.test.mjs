import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { configure } from './replay/source.mjs';

// Install the isolated InteractiveMode loader before importing the real host.
const source = configure();
const { frameChecker } = await import('./support/checks.mjs');
const { play, SCENARIOS, LAST, SCROLLED } = await import('./support/scenes.mjs');
after(() => { source.verify(); source.hook.deregister(); });

test('frame checker rejects unordered admission and unanimated jumps (negative controls)', () => {
  const checker = frameChecker(), KEY = Symbol.for('pi-compact-ui2tree/container-render-v1');
  const renderer = { captureRenderState: () => ({previousViewportTop: 0, previousLines: []}), resetRenderState() {}, renderNow() {} };
  let blocks = [];
  const Container = { prototype: { [KEY]: { rootFrames: new Map([[renderer, {coordinator: {readBlocks: () => blocks}}]]) } } };
  const f = {Container, mode: {renderer}, stripTerminalSequences: text => text, now: 0};
  const bottom = Array.from({length: 6}, (_, i) => ({id: 'bottom' + i, rows: []}));
  blocks = [{id: 'chat/item:a', rows: ['A'], phase: 'stable', playback: true}, ...bottom];
  checker.frame(f, 'initial', 1);
  f.now = 25;
  blocks = [blocks[0], {id: 'chat/item:b', rows: ['B'], phase: 'stable'}, ...bottom];
  checker.frame(f, 'invalid admission', 1);
  f.now = 50;
  blocks = [blocks[0], {id: 'chat/item:b', rows: ['changed'], phase: 'stable'}, ...bottom];
  checker.frame(f, 'invalid jump', 1);
  const checks = checker.finish(f).violations.map(v => v.check);
  assert.ok(checks.includes('order'));
  assert.ok(checks.includes('pop'));
  assert.ok(checks.includes('jump'));
});

for (const name of SCENARIOS) for (const height of [24, 40]) {
  test(`scenario ${name} at 80x${height} has no frame violations`, async () => {
    const checker = frameChecker();
    const f = await play(name, height, checker.frame);
    try {
      const result = checker.finish(f);
      assert.ok(result.intermediate > 0, 'the scenario must draw its intermediate frames');
      assert.deepEqual(result.violations, [], JSON.stringify(result.violations));
      const { previousLines, previousViewportTop } = f.mode.renderer.captureRenderState();
      const rows = previousLines.map(row => f.stripTerminalSequences(row));
      if (LAST[name]) assert.ok(rows.some(row => row.includes(LAST[name])), `the last item "${LAST[name]}" must reach the screen`);
      if (SCROLLED[name] && height === 24) assert.ok(rows.slice(0, previousViewportTop).some(row => row.includes(SCROLLED[name])), `"${SCROLLED[name]}" must end in scrollback`);
    } finally {
      assert.equal(f.close().remainingTimers, 0);
    }
  });
}
