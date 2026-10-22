/** Test-only observer: records actual-host DONE and completion of all pending publication/receipts. */
import { Container, stripTerminalSequences } from '@earendil-works/pi-tui';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function receiptTiming(pi: any) {
  const records: Record<string, { inputAt: number; doneAt?: number; stableAt?: number }> = {};
  let tag = '', stablePolls = 0, agentRunning = false, timer: ReturnType<typeof setInterval> | undefined;
  // The runner polls this file; a rename never shows it a half-written one.
  const file = join(process.env.PI_CODING_AGENT_DIR!, 'receipt-timings.json');
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(records)); renameSync(`${file}.tmp`, file); };
  pi.on('input', (event: any) => {
    const match = /^E2E:tools (\S+)/.exec(event.text);
    if (match) { tag = match[1]; records[tag] = { inputAt: Date.now() }; stablePolls = 0; save(); }
  });
  pi.on('agent_start',()=>{ agentRunning = true; });
  pi.on('agent_end',()=>{ agentRunning = false; });
  pi.on('session_start', () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!tag || records[tag].stableAt) return;
      const state = (Container.prototype as any)[Symbol.for('pi-compact-ui2tree/container-render-v1')];
      const frames = [...(state?.roots ?? [])].map((ref: any) => ref.deref()).filter(Boolean);
      const frame = frames.find((frame: any) => frame.host && frame.container.deref()?.captureRenderState);
      if (!frame) return;
      const root = frame.container.deref(), host = root.captureRenderState();
      const done = host.previousLines.some((row: string) => stripTerminalSequences(row).trim() === `DONE ${tag}`);
      if (!done) return;
      if (!records[tag].doneAt) { records[tag].doneAt = Date.now(); save(); }
      const pending = agentRunning || root.hasOverlay() || frame.coordinator.hasPending || [...state.caches].some((ref: any) => {
        const cache = ref.deref();
        // ticking: an item is still playing, moving or resting before the next may enter.
        return cache?.ticking || cache?.blocks?.some((block: any) => block.playback || block.paint?.length);
      });
      stablePolls = pending ? 0 : stablePolls + 1;
      if (stablePolls >= 2) { records[tag].stableAt = Date.now(); save(); }
    }, 25);
  });
  pi.on('session_shutdown', () => { if (timer) clearInterval(timer); timer = undefined; });
}
