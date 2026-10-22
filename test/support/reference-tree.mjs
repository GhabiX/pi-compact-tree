// Uncached, playback-free composition: items and runs in source order.
// Deliberately shares only the pure formatters; never uses ProjectionCache.
import { renderThinking, renderTool, renderRun, isRunTool, isVisibleNativeRows } from '../../extensions/format.ts';
import { toTreeCard } from '../../extensions/group.ts';
import { createOutputAssembler } from '../../extensions/output-assembly.ts';

function itemRows(cards, theme, width, expanded, successor) {
  const parts = [];
  for (const card of cards) {
    if (isRunTool(card) && parts.at(-1)?.run) parts.at(-1).run.push(card);
    else parts.push(isRunTool(card) ? { run: [card] } : { card });
  }
  const options = { width, theme, expanded, pulse: 0 };
  return parts.map((part, index) => {
    if (part.run) return renderRun(part.run, { ...options, current: index === parts.length - 1 && !successor });
    if (part.card.toolName === 'thinking') return renderThinking(part.card, { ...options, text: part.card.detail ?? '', window: false }).rows;
    return renderTool(part.card, options);
  });
}
export function renderTreeLines(cards, theme, width = 120, expanded = false) {
  return itemRows(cards, theme, width, expanded, false).flatMap((rows, i) => [...(i ? [''] : []), ...rows]);
}
export function renderProcessChildren(children, project, renderNative, theme, width = 120, expanded = false) {
  const assembler = createOutputAssembler();
  let cards = [], id = 0;
  const flush = (successor = false) => {
    if (!cards.length) return;
    for (const rows of itemRows(cards, theme, width, expanded, successor))
      assembler.process([{ id: `reference-${id++}`, kind: 'structure', shape: 'item', rows }]);
    cards = [];
  };
  const native = child => {
    const rows = renderNative(child);
    if (isVisibleNativeRows(rows)) flush(true);
    assembler.native({ rows, blocks: [{ id: `native-${id++}`, kind: 'native', shape: 'native', rows }] });
  };
  for (const child of children) {
    const item = project(child, expanded);
    if (item === 'spacer' || item === 'hidden') continue;
    if (!item) { native(child); continue; }
    if (item.nativePlacement === 'before') native(child);
    for (const duck of [item, ...(item.companions ?? [])]) {
      const card = toTreeCard(duck);
      if (card) cards.push(card);
    }
    if (item.nativePlacement === 'after') native(child);
  }
  flush();
  return assembler.finish().flatMap(block => block.rows);
}
