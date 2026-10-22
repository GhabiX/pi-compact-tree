// Frame-by-frame checks of everything the plugin publishes:
//   order   an item first shows a row only when every item before it has settled (played, folded, grown in);
//           items entering together as one passage are published empty and grow one after another;
//   flow    a playing Thinking body grows by at most one row per frame and never shrinks;
//   motion  each motion path moves its block's height monotonically in even steps, keeps its first row,
//           and a fold of n rows settles within n sixteenths (150ms each, at most a bar);
//   frozen  every scrollback row equals a fresh full redraw of the final state (no intermediate frame frozen);
//   pop     an item or entering prose block appears with content and no motion bringing it in;
//   jump    such a block outside any motion and playback changes its rows (the host's own rows, such as
//           the prompt you typed, are immediate by design and not checked);
//   redraw  a cleared full redraw other than the one a Ctrl+O may need (support/reprint.mjs); that
//           reprint shows the result at once, so it and the frames it replaces are exempt from pop and jump;
//   cost    wall time of each redraw;   pace  characters a playing flow shows per 200ms, mean and variation.
import { ctrlOReprint } from './reprint.mjs';
const KEY = Symbol.for('pi-compact-ui2tree/container-render-v1');
const BOTTOM = 6;

export function frameChecker() {
  const violations = [], costs = [], last = new Map(), moves = new Map(), granted = {}, shown = new Set();
  const reprinted = ctrlOReprint();
  let frames = 0, intermediate = 0, finished = false, redraws, deferred = false;
  const frame = (f, label, ms) => {
    // The reference redraw in finish is not a frame of the scenario.
    if (finished) return;
    frames++; costs.push(ms);
    const root = f.mode.renderer, coordinator = f.Container.prototype[KEY].rootFrames.get(root).coordinator;
    const added = root.fullRedraws - (redraws ?? root.fullRedraws);
    redraws = root.fullRedraws;
    // The checker sees every frame, so a permitted reprint must also follow a frame with a deferred target.
    const reprint = reprinted({ toolsExpanded: f.mode.toolOutputExpanded, redraws: added, coordinator }) && deferred;
    deferred = coordinator.hasDeferred;
    if (added && !reprint) violations.push({ check: 'redraw', at: f.now, label, added });
    // The reprint replaces every frame drawn at the same instant (one event-loop turn), unseen.
    if (reprint) for (let i = violations.length - 1; i >= 0; i--)
      if (violations[i].at === f.now && (violations[i].check === 'pop' || violations[i].check === 'jump')) violations.splice(i, 1);
    const blocks = coordinator.readBlocks();
    const transcript = blocks.slice(0, Math.max(0, blocks.length - BOTTOM));
    if (transcript.some(b => b.playback || b.phase === 'pending' || b.phase === 'transition')) intermediate++;
    transcript.forEach((block, index) => {
      const rows = block.rows.map(r => f.stripTerminalSequences(r).trimEnd());
      const prev = last.get(block.id);
      const moving = block.phase === 'pending' || block.phase === 'transition';
      if (block.id.includes('/item:') && !shown.has(block.id) && rows.some(r => r.trim())) {
        shown.add(block.id);
        const busy = transcript.slice(0, index).filter(b => b.id.includes('/item:') && (b.playback || b.phase === 'pending' || b.phase === 'transition'));
        if (busy.length) violations.push({ check: 'order', at: f.now, block: block.id, busy: busy.map(b => b.id) });
      }
      const ours = block.id.includes('/item:') || block.enters;
      if (ours && frames > 1 && !reprint && !prev && !moving && !block.playback && rows.some(r => r.trim())) violations.push({ check: 'pop', at: f.now, block: block.id, rows: rows.slice(0, 2) });
      if (ours && !reprint && prev && !moving && !prev.moving && !block.playback && !prev.playback && rows.join('\n') !== prev.rows.join('\n'))
        violations.push({ check: 'jump', at: f.now, block: block.id, from: prev.rows.slice(-2), to: rows.slice(-2) });
      const flow = block.playback && block.phase === 'stable' && block.paint?.find(span => !span.settled);
      if (flow) (granted[block.id] ??= []).push([f.now, flow.text.length]);
      if (prev && block.id.includes(':thinking') && block.playback && prev.playback && !moving && block.phase === prev.phase) {
        const delta = rows.length - prev.rows.length;
        if (delta < 0 || delta > 1) violations.push({ check: 'flow', at: f.now, block: block.id, from: prev.rows.length, to: rows.length });
      }
      // A motion ends when its block stops moving or a new path starts (a new startedAt: retargeted).
      const open = moves.get(block.id);
      if (open && (!moving || open.startedAt !== block.startedAt)) {
        moves.delete(block.id);
        open.heights.push(rows.length);
        const steps = open.heights.slice(1).map((h, i) => h - open.heights[i]);
        const moved = steps.filter(s => s !== 0).map(Math.abs);
        if (moved.length && Math.max(...moved) - Math.min(...moved) > Math.ceil(Math.max(...moved) / 2)) violations.push({ check: 'motion-step', at: f.now, block: block.id, heights: open.heights });
        if (steps.some(s => s > 0) && steps.some(s => s < 0)) violations.push({ check: 'motion-monotone', at: f.now, block: block.id, heights: open.heights });
        const n = Math.abs(open.heights.at(-1) - open.heights[0]);
        if (!moving && f.now - open.startedAt > Math.min(16, Math.max(1, n)) * 150 + 200) violations.push({ check: 'motion-duration', at: f.now, block: block.id, ms: f.now - open.startedAt });
      }
      if (moving) {
        const move = moves.get(block.id) ?? { startedAt: block.startedAt, first: (prev ?? { rows })?.rows[0], heights: [prev?.rows.length ?? rows.length] };
        move.heights.push(rows.length);
        if (rows[0] !== undefined && move.first !== undefined && rows[0] !== move.first) violations.push({ check: 'motion-title', at: f.now, block: block.id, from: move.first, to: rows[0] });
        moves.set(block.id, move);
      }
      last.set(block.id, { rows, moving, playback: block.playback, phase: block.phase });
    });
  };
  const finish = (f) => {
    finished = true;
    const root = f.mode.renderer, host = root.captureRenderState();
    const top = host.previousViewportTop, held = host.previousLines.slice(0, top).map(r => f.stripTerminalSequences(r).trimEnd());
    root.resetRenderState(); root.renderNow();
    const fresh = root.captureRenderState().previousLines.map(r => f.stripTerminalSequences(r).trimEnd());
    held.forEach((row, i) => { if (row !== fresh[i]) violations.push({ check: 'frozen', row: i, held: row, fresh: fresh[i] }); });
    costs.sort((x, y) => x - y);
    let pace;
    for (const series of Object.values(granted)) {
      const grows = series.filter(([, n], k) => k && n > series[k - 1][1]);
      if (grows.length <= 2) continue;
      const [t0, t1] = [grows[0][0], grows.at(-1)[0]], windows = [];
      const at = ms => series.filter(([u]) => u <= ms).at(-1)?.[1] ?? 0;
      for (let t = t0; t + 200 <= t1; t += 200) windows.push((at(t + 200) - at(t)) * 5);
      if (!windows.length) continue;
      const mean = windows.reduce((a, b) => a + b, 0) / windows.length;
      const sd = Math.sqrt(windows.reduce((a, b) => a + (b - mean) ** 2, 0) / windows.length);
      const next = { charsPerS: Math.round(mean), cv: +(sd / mean).toFixed(2) };
      if (!pace || next.cv > pace.cv) pace = next;
    }
    return { frames, intermediate, scrollback: top, violations, pace,
      renderMs: { p50: +costs[costs.length >> 1].toFixed(2), p95: +costs[Math.floor(costs.length * 0.95)].toFixed(2), max: +costs.at(-1).toFixed(2) } };
  };
  return { frame, finish };
}

export const summary = (name, r) => `${name}: ${r.frames} frames (${r.intermediate} intermediate), scrollback ${r.scrollback}, violations ${r.violations.length}` +
  (r.violations.length ? ` (${[...new Set(r.violations.map(v => v.check))].join(', ')})` : '') +
  `, render p50 ${r.renderMs.p50}ms p95 ${r.renderMs.p95}ms` + (r.pace ? `, pace ${r.pace.charsPerS} chars/s cv ${r.pace.cv}` : '');
