// Display scenarios as Pi session events, drawn by real Pi InteractiveMode.
import { session } from './driver.mjs';

const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');
const THINK = '先看 format.ts 里标题是怎么拼出来的，再跑一遍测试确认现在的行为。**标题** 只在 formatTreeLine 里生成，计数来自 segmentCounts。' + ' 然后检查 projection 的段划分逻辑，确认 Thinking 的窗口什么时候收回。'.repeat(3);
const FILE = lines(454, i => `line ${i} of format.ts`);
const TEST_OUT = lines(43, i => `✔ test ${i} passes (${i}ms)`);
const DIFF = [' 129   }', ' 130 export function toolPreview(name: string) {', '-131   switch (name) {', '+131   switch (normalize(name)) {', '+132     case "sh":', ' 133     case "bash":'].join('\n');
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const text = (t, extra = {}) => ({ result: { content: [{ type: 'text', text: t }], details: extra } });

/** One session per scenario; `frame(f, label, renderMs)` runs after every Pi redraw. */
export async function play(name, height, frame) {
  const { f, drain, emit, turn, prompt } = await session(height, frame);
  const scenarios = {
    a: () => scenarios.thinkingTools(false),
    h: () => scenarios.thinkingTools(true),
    thinkingTools: async (ctrlO) => {
      await turn([{ type: 'thinking', thinking: THINK }, call('r1', 'read', { path: 'extensions/format.ts' }), call('b1', 'bash', { command: 'npm test' }), call('r2', 'read', { path: 'extensions/group.ts' })],
        [{ id: 'r1', name: 'read', args: { path: 'extensions/format.ts' }, ...text(FILE) },
         { id: 'b1', name: 'bash', args: { command: 'npm test' }, ...text(TEST_OUT) },
         { id: 'r2', name: 'read', args: { path: 'extensions/group.ts' }, ...text(lines(130, i => `g ${i}`)) }]);
      if (!ctrlO) return;
      // Ctrl+O there and back.
      f.mode.toggleToolOutputExpansion(); await drain(50);
      f.mode.toggleToolOutputExpansion(); await drain(50);
    },
    b: async () => {
      for (const [i, cmd] of ['ls extensions', 'grep -n segment extensions/format.ts', 'wc -l extensions/*.ts'].entries())
        await turn([call(`g${i}`, 'bash', { command: cmd })], [{ id: `g${i}`, name: 'bash', args: { command: cmd }, ...text(lines(6, j => `${cmd.split(' ')[0]} output ${j}`)) }]);
      await turn([{ type: 'text', text: '三个文件都看过了，format.ts 最长。' }]);
    },
    c: async () => {
      const code = 'const a = await tools.read({path:"missing.txt"});\nconst b = await tools.bash({command:"git status"});\nconsole.log(a, b);';
      const calls = [{ id: 'cm/?', name: 'read', args: 'path="missing.txt"', status: 'error', error: 'ENOENT: missing.txt' }, { id: 'cm/?', name: 'bash', args: 'command="git status"', status: 'running' }];
      await turn([{ type: 'thinking', thinking: THINK }, call('cm', 'codemode', { code })],
        [{ id: 'cm', name: 'codemode', args: { code }, partial: [''], partialDetails: { calls },
          result: { content: [{ type: 'text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' }, { type: 'text', text: 'SCRIPT_OUTPUT line 1\nSCRIPT_OUTPUT line 2' }],
            details: { calls: [calls[0], { ...calls[1], status: 'success' }] } } }]);
    },
    d: async () => {
      await turn([{ type: 'text', text: '我先读一下入口文件。' }, call('r1', 'read', { path: 'extensions/compact-ui2tree.ts' })],
        [{ id: 'r1', name: 'read', args: { path: 'extensions/compact-ui2tree.ts' }, ...text(lines(1147, i => `c ${i}`)) }]);
      await turn([{ type: 'thinking', thinking: '入口里 isThinking 看末尾 block 的类型。' }, { type: 'text', text: '找到了：364 行。接着看 group.ts。' }, call('r2', 'read', { path: 'extensions/group.ts' })],
        [{ id: 'r2', name: 'read', args: { path: 'extensions/group.ts' }, ...text(lines(130, i => `g ${i}`)) }]);
    },
    e: async () => {
      const chunks = Array.from({ length: 6 }, (_, k) => lines((k + 1) * 4, i => `✔ test ${i} passes`));
      await turn([call('b1', 'bash', { command: 'npm test' })],
        [{ id: 'b1', name: 'bash', args: { command: 'npm test' }, partial: chunks, ...text(chunks.at(-1)) }]);
    },
    f: async () => {
      const args = { path: 'extensions/format.ts', edits: [{ oldText: 'switch (name) {', newText: 'switch (normalize(name)) {\n    case "sh":' }] };
      await turn([call('e1', 'edit', args)], [{ id: 'e1', name: 'edit', args, ...text('Successfully replaced 1 block(s) in extensions/format.ts.', { diff: DIFF, firstChangedLine: 131 }) }]);
    },
    // A provider that sends Thinking in bursts: 150 characters every 600ms.
    i: async () => {
      await turn([{ type: 'thinking', thinking: THINK.repeat(3) }, call('r1', 'read', { path: 'extensions/format.ts' })],
        [{ id: 'r1', name: 'read', args: { path: 'extensions/format.ts' }, ...text(FILE) }], { chunk: 150, every: 24 });
    },
    // A plain answer, no tools: prose in bursts of 60 characters every 250ms.
    j: async () => {
      await turn([{ type: 'text', text: ('这一段是纯文本回答，没有调用工具。正文应该和 Thinking 一样按到达速度匀速流出来，' +
        '而不是一批一批地跳出来。'.repeat(2) + '\n\n').repeat(4) }], [], { chunk: 60, every: 10 });
    },
    // A turn that ends on tool calls: the run folds once the agent settles.
    k: async () => {
      await turn([{ type: 'thinking', thinking: THINK }, call('r1', 'read', { path: 'extensions/format.ts' }), call('b1', 'bash', { command: 'npm test' })],
        [{ id: 'r1', name: 'read', args: { path: 'extensions/format.ts' }, ...text(lines(40, i => `f ${i}`)) },
         { id: 'b1', name: 'bash', args: { command: 'npm test' }, ...text(TEST_OUT) }], { rest: 0 });
    },
    // Items arrive much faster than they play (400 characters a tick): the backlog enters in final form.
    l: async () => {
      const args = { path: 'extensions/format.ts', edits: [{ oldText: 'switch (name) {', newText: 'switch (normalize(name)) {' }] };
      await turn([{ type: 'thinking', thinking: THINK }, { type: 'text', text: '先改 toolPreview 的分支。'.repeat(20) }, call('e1', 'edit', args)],
        [{ id: 'e1', name: 'edit', args, ...text('Successfully replaced 1 block(s) in extensions/format.ts.', { diff: DIFF, firstChangedLine: 131 }) }], { chunk: 400, rest: 0 });
      await turn([{ type: 'thinking', thinking: THINK }, { type: 'text', text: '改好了，再跑一遍测试。'.repeat(20) }, call('b1', 'bash', { command: 'npm test' })],
        [{ id: 'b1', name: 'bash', args: { command: 'npm test' }, ...text(TEST_OUT) }], { chunk: 400, rest: 0 });
      await turn([{ type: 'text', text: '测试都过了。' }], [], { chunk: 400, rest: 0 });
    },
    // Two requests: the first request's items fold and move into scrollback while the second one plays.
    m: async () => {
      await turn([{ type: 'thinking', thinking: THINK }, call('r1', 'read', { path: 'extensions/format.ts' }), call('b1', 'bash', { command: 'npm test' })],
        [{ id: 'r1', name: 'read', args: { path: 'extensions/format.ts' }, ...text(lines(40, i => `f ${i}`)) },
         { id: 'b1', name: 'bash', args: { command: 'npm test' }, ...text(TEST_OUT) }]);
      await turn([{ type: 'text', text: '第一遍测试过了。' }]);
      await emit({ type: 'agent_end', messages: [] });
      await emit({ type: 'agent_settled' });
      await drain(200);
      await emit({ type: 'agent_start' });
      await prompt('改完再跑一遍');
      await turn([{ type: 'thinking', thinking: THINK }, call('r2', 'read', { path: 'extensions/group.ts' }), call('b2', 'bash', { command: 'npm test' })],
        [{ id: 'r2', name: 'read', args: { path: 'extensions/group.ts' }, ...text(lines(130, i => `g ${i}`)) },
         { id: 'b2', name: 'bash', args: { command: 'npm test' }, ...text(TEST_OUT) }]);
      await turn([{ type: 'text', text: lines(16, i => `- 第 ${i} 处改动已核对。`) + '\n\n第二遍测试也过了。' }]);
    },
    g: async () => {
      const tools = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, name: i % 3 ? 'read' : 'bash', args: i % 3 ? { path: `src/file${i}.ts` } : { command: `npm run step${i}` } }));
      await turn([{ type: 'thinking', thinking: THINK }, ...tools.map(t => call(t.id, t.name, t.args))], tools.map(t => ({ ...t, ...text(lines(5, j => `${t.id} out ${j}`)) })));
    },
  };
  await emit({ type: 'agent_start' });
  await prompt(`scenario ${name}`);
  await scenarios[name]();
  await emit({ type: 'agent_end', messages: [] });
  await emit({ type: 'agent_settled' });
  await drain(400);
  return f;
}
export const SCENARIOS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'];
/** The text of each scenario's last item: it must reach the screen once the scenario has drained. */
export const LAST = { b: '三个文件都看过了', k: 'Read 1 file', l: '测试都过了', m: '第二遍测试也过了' };
/** Text that must end above the viewport at 80x24: the scenario covers rows frozen in scrollback only if it gets there. */
export const SCROLLED = { m: '第一遍测试过了' };
