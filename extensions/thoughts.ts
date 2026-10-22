/** Full Thinking readback without rewriting regular-mode scrollback. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export async function showThoughts(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") return;
  // Read the current branch on demand. No second message store or signature data.
  const thoughts = ctx.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return [];
    const text = entry.message.content
      .filter((part) => part.type === "thinking")
      .map((part) => part.thinking)
      .join("\n\n");
    return text.trim() ? [stripTerminalSequences(text).replace(/\r\n?/gu, "\n").replace(/\t/gu, "    ")] : [];
  });
  if (!thoughts.length) {
    ctx.ui.notify("No saved Thinking in this session branch.", "info");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let index = thoughts.length - 1;
    let offset = 0;
    let page = 1;
    let cachedIndex = -1;
    let cachedWidth = -1;
    let lines: string[] = [];
    return {
      render(width) {
        const columns = Math.max(1, width);
        const height = Math.max(1, tui.terminal.rows);
        page = Math.max(1, height - 2);
        if (index !== cachedIndex || columns !== cachedWidth) {
          lines = wrapTextWithAnsi(thoughts[index], columns);
          cachedIndex = index;
          cachedWidth = columns;
        }
        offset = Math.min(Math.max(0, offset), Math.max(0, lines.length - page));
        const body = lines.slice(offset, offset + page);
        if (height < 3) return body.slice(0, height);
        const title = `Thinking ${index + 1}/${thoughts.length} · ${offset + 1}–${Math.min(lines.length, offset + page)}/${lines.length}`;
        const hint = "↑↓ / PgUp PgDn scroll · ←→ thought · Esc close";
        return [theme.fg("accent", truncateToWidth(title, columns, "")),
          ...body.map((line) => theme.fg("text", line)),
          ...Array<string>(page - body.length).fill(""),
          theme.fg("dim", truncateToWidth(hint, columns, ""))];
      },
      handleInput(data) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { done(); return; }
        if (matchesKey(data, "up")) offset -= 1;
        else if (matchesKey(data, "down")) offset += 1;
        else if (matchesKey(data, "pageUp")) offset -= page;
        else if (matchesKey(data, "pageDown")) offset += page;
        else if (matchesKey(data, "home")) offset = 0;
        else if (matchesKey(data, "end")) offset = Infinity;
        else if (matchesKey(data, "left") && index > 0) { index -= 1; offset = 0; }
        else if (matchesKey(data, "right") && index + 1 < thoughts.length) { index += 1; offset = 0; }
        else return;
        tui.requestRender();
      },
      invalidate() { cachedWidth = -1; },
    };
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } });
}
