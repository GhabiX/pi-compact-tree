// Drives real Pi InteractiveMode with session events on a deterministic clock; Pi decides when to draw.
import { createFixture } from '../replay/fixture.mjs';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const assistant = (content, stopReason = 'toolUse') => ({ role: 'assistant', api: 'openai-responses', provider: 'fixture', model: 'fixture-model', content, stopReason, timestamp: 1, usage });
export const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });

/** `frame(f, label, renderMs)` runs after every redraw; `label` names what the driver was doing. */
export async function session(height, frame) {
  const f = await createFixture({ width: 80, height });
  let label = 'setup';
  f.onRender(ms => frame?.(f, label, ms));
  const tick = (ms = 25, as = 'tick') => { label = as; return f.tick(ms); };
  const drain = async (n = 200) => { for (let i = 0; i < n; i++) await tick(25); };
  const emit = e => { label = e.type; return f.emit(e); };
  /** One assistant message streamed in `chunk`-character deltas every `every` ticks, then its tools run in order. */
  async function turn(content, tools = [], { chunk = 12, every = 1, toolTicks = 1, rest = 200 } = {}) {
    // Pi starts every turn with turn_start: it shows the working status and its Loader.
    await emit({ type: 'turn_start' });
    await emit({ type: 'message_start', message: assistant([]) });
    const partial = [];
    for (const block of content) {
      const field = block.type === 'thinking' ? 'thinking' : block.type === 'text' ? 'text' : undefined;
      if (field) for (let at = chunk; at < block[field].length; at += chunk) {
        await emit({ type: 'message_update', message: assistant([...partial, { ...block, [field]: block[field].slice(0, at) }]) });
        for (let k = 0; k < every; k++) await tick(25);
      }
      partial.push(block);
      await emit({ type: 'message_update', message: assistant([...partial]) });
      await tick(25);
    }
    await emit({ type: 'message_end', message: assistant(content, tools.length ? 'toolUse' : 'stop') });
    for (const t of tools) {
      await emit({ type: 'tool_execution_start', toolCallId: t.id, toolName: t.name, args: t.args });
      await tick(25);
      for (const p of t.partial ?? []) {
        await emit({ type: 'tool_execution_update', toolCallId: t.id, toolName: t.name, args: t.args, partialResult: { content: [{ type: 'text', text: p }], details: t.partialDetails ?? {} } });
        await tick(200, 'running');
      }
      for (let k = 1; k < toolTicks; k++) await tick(25);
      await emit({ type: 'tool_execution_end', toolCallId: t.id, toolName: t.name, result: t.result, isError: !!t.isError });
      await tick(25);
    }
    await drain(rest);
  }
  async function prompt(text) {
    await emit({ type: 'message_start', message: user(text) });
    await emit({ type: 'message_end', message: user(text) });
  }
  return { f, tick, drain, emit, turn, prompt };
}
