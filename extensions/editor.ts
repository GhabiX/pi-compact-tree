/** Pi 1.1 CustomEditor display adapter; input state and loader ownership stay native. */
import { CURSOR_MARKER, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export type InputTheme = {
  fg(color: "userMessageText" | "muted", text: string): string;
  getFgAnsi(color: "userMessageText"): string;
  getBgAnsi(color: "userMessageBg"): string;
};

type NativeEditor = Component & {
  getText(): string;
  getPaddingX(): number;
  setPaddingX(value: number): void;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  renderTopBorder(width: number, hidden: number): string;
  renderBottomBorder(width: number, hidden: number): string;
  // Pi 1.1 runtime layout fields, not a public extension API. Only paddingX is
  // borrowed synchronously for native layout; input state is never changed here.
  paddingX: number;
  renderedVisibleLineCount: number;
  workingStatusIndicator?: { renderInBorder(width: number): string };
  embedWorkingStatus?: boolean;
};

export type InputStyle = { readonly statusRows: number; dispose(): void };
const STYLE = Symbol.for("pi-compact-ui2tree.input-style");
type StyledEditor = NativeEditor & { [STYLE]?: InputStyle };

/** Rows owned by the native indicator above the adapted editor panel. */
export function inputStatusRows(component: Component | undefined): number {
  return (component as StyledEditor | undefined)?.[STYLE]?.statusRows ?? 0;
}

function restore(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(object, key, descriptor);
  else Reflect.deleteProperty(object, key);
}

function withInputPadding<T>(editor: NativeEditor, read: () => T): T {
  const padding = Object.getOwnPropertyDescriptor(editor, "paddingX")!;
  // The public setter requests another render. Borrow just its layout value so
  // rendering stays passive and legitimate host invalidations remain intact.
  Object.defineProperty(editor, "paddingX", { ...padding, value: 1 });
  try { return read(); }
  finally { Object.defineProperty(editor, "paddingX", padding); }
}

/** Unsupported custom editors retain their own rendering and input semantics. */
export function installInputStyle(component: Component, getTheme: () => InputTheme): InputStyle | undefined {
  if (component.constructor.name !== "CustomEditor") return undefined;
  const editor = component as StyledEditor;
  const padding = Object.getOwnPropertyDescriptor(editor, "paddingX");
  if (typeof editor.getPaddingX !== "function" || typeof editor.setPaddingX !== "function" ||
      typeof editor.getText !== "function" || typeof editor.handleMouse !== "function" ||
      typeof editor.renderTopBorder !== "function" || typeof editor.renderBottomBorder !== "function" ||
      typeof editor.renderedVisibleLineCount !== "number" ||
      !padding?.writable || typeof padding.value !== "number") return undefined;

  // A previous installation may come from another module namespace after reload.
  editor[STYLE]?.dispose();
  const renderDescriptor = Object.getOwnPropertyDescriptor(editor, "render");
  const mouseDescriptor = Object.getOwnPropertyDescriptor(editor, "handleMouse");
  const styleDescriptor = Object.getOwnPropertyDescriptor(editor, STYLE);
  const originalRender = editor.render;
  const originalMouse = editor.handleMouse;
  let active = true;
  let prefixColumns = 0;
  let statusRows = 0;

  function render(width: number): string[] {
    if (!active) return originalRender.call(editor, width);
    const theme = getTheme();
    // Keep at least two native text cells for wide graphemes.
    const prefix = width >= 5 ? 1 : 0;
    const nativeWidth = Math.max(1, width - prefix);
    const status = editor.embedWorkingStatus ? editor.workingStatusIndicator?.renderInBorder(width) : undefined;
    const leading = status && visibleWidth(status) > 0 ? [status, ""] : [];
    const topDescriptor = Object.getOwnPropertyDescriptor(editor, "renderTopBorder");
    const bottomDescriptor = Object.getOwnPropertyDescriptor(editor, "renderBottomBorder");
    const border = (arrow: string, columns: number, hidden: number) => {
      const text = hidden > 0 ? truncateToWidth(` ${arrow} ${hidden} more `, columns, "") : "";
      return theme.fg("muted", text) + " ".repeat(Math.max(0, columns - visibleWidth(text)));
    };
    const top = (columns: number, hidden: number) => border("↑", columns, hidden);
    const bottom = (columns: number, hidden: number) => border("↓", columns, hidden);
    let native: string[];
    Object.defineProperty(editor, "renderTopBorder", { configurable: true, writable: true, value: top });
    Object.defineProperty(editor, "renderBottomBorder", { configurable: true, writable: true, value: bottom });
    try {
      native = withInputPadding(editor, () => originalRender.call(editor, nativeWidth));
    } finally {
      if (editor.renderTopBorder === top) restore(editor, "renderTopBorder", topDescriptor);
      if (editor.renderBottomBorder === bottom) restore(editor, "renderBottomBorder", bottomDescriptor);
    }
    const panelEnd = editor.renderedVisibleLineCount + 2;
    const bg = theme.getBgAnsi("userMessageBg");
    const fg = theme.getFgAnsi("userMessageText");
    const paint = (row: string) => bg + fg + row
      .replaceAll("\x1b[0m", `\x1b[0m${bg}${fg}`)
      .replaceAll("\x1b[49m", `\x1b[49m${bg}`)
      .replaceAll("\x1b[39m", `\x1b[39m${fg}`) + "\x1b[0m";
    const rows = native.map((row, index) => {
      if (index >= panelEnd) return (prefix ? " " : "") + row;
      if (index === 1 && prefix && editor.getText() === "") {
        const padding = Math.min(1, Math.max(0, Math.floor((nativeWidth - 1) / 2)));
        const text = truncateToWidth("Ask Pi to do anything", nativeWidth - padding * 2, "");
        // Keep the native caret at the first placeholder cell, never in the draft.
        const marker = row.includes(CURSOR_MARKER) ? CURSOR_MARKER : "";
        const placeholder = theme.fg("muted", `\x1b[7m${text[0]}\x1b[27m${text.slice(1)}`);
        row = " ".repeat(padding) + marker + placeholder;
        row += " ".repeat(Math.max(0, nativeWidth - visibleWidth(row)));
      }
      return paint((prefix ? index === 1 ? "›" : " " : "") + row);
    });
    prefixColumns = prefix;
    statusRows = leading.length;
    return [...leading, ...rows];
  }

  function handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!active) return originalMouse.call(editor, event);
    if (event.y < statusRows) return undefined;
    return withInputPadding(editor, () => originalMouse.call(editor, { ...event,
        x: event.x - prefixColumns, y: event.y - statusRows,
        width: Math.max(1, event.width - prefixColumns), height: Math.max(0, event.height - statusRows),
      }));
  }

  const handle: InputStyle = {
    get statusRows() { return active ? statusRows : 0; },
    dispose() {
      if (!active) return;
      active = false;
      // Preserve wrappers installed by another extension after this adapter.
      if (editor.render === render) restore(editor, "render", renderDescriptor);
      if (editor.handleMouse === handleMouse) restore(editor, "handleMouse", mouseDescriptor);
      if (editor[STYLE] === handle) restore(editor, STYLE, styleDescriptor);
    },
  };
  Object.defineProperty(editor, "render", { configurable: true, writable: true, value: render });
  Object.defineProperty(editor, "handleMouse", { configurable: true, writable: true, value: handleMouse });
  Object.defineProperty(editor, STYLE, { configurable: true, value: handle });
  return handle;
}
