/** Pi's six native bottom regions: pending, status, above, editor, below, footer. */
export type BottomSlice = { rows: readonly string[]; start: number; sourceHeight: number; prefix?: number };

/** Keep the editor caret and footer visible before spending space on auxiliary rows. */
export function fitBottom(regions: readonly (readonly string[])[], height: number, cursorMarker: string, editorStatusRows = 0): BottomSlice[] {
  const budgets = regions.map((rows) => rows.length);
  if (budgets.reduce((sum, count) => sum + count, 0) > height) {
    budgets.fill(0);
    let remaining = height;
    const editorMinimum = regions[3].length ? 1 : 0;
    // A one-row terminal can show the caret or footer, not both. Editing wins.
    budgets[5] = Math.min(regions[5].length, Math.max(0, remaining - editorMinimum));
    remaining -= budgets[5];
    // Accepted user messages must remain visible ahead of widgets and extra
    // draft rows. Keep a caret plus the native status before this reservation.
    const editorPriority = Math.min(regions[3].length, editorStatusRows ? 2 : 1);
    budgets[0] = Math.min(regions[0].length, Math.max(0, remaining - editorPriority));
    remaining -= budgets[0];
    budgets[3] = Math.min(regions[3].length, remaining);
    remaining -= budgets[3];
    for (const index of [1, 2, 4]) {
      budgets[index] = Math.min(regions[index].length, remaining);
      remaining -= budgets[index];
    }
  }
  return regions.map((rows, index) => {
    const count = budgets[index];
    const caret = index === 3 ? rows.findIndex((row) => row.includes(cursorMarker)) : -1;
    // Preserve the one-line native status before the caret slice. A screen
    // that fits only the caret still favors editing; no indicator is invented.
    const prefix = index === 3 && editorStatusRows > 0 && count > 1 && count < rows.length ? 1 : 0;
    if (prefix) {
      const tailCount = count - prefix;
      const start = Math.max(editorStatusRows, Math.min(rows.length - tailCount, caret - Math.floor((tailCount - 1) / 2)));
      return { rows: [...rows.slice(0, prefix), ...rows.slice(start, start + tailCount)], start, sourceHeight: rows.length, prefix };
    }
    // Pi's pending region ends with an edit hint. When cropped, show the
    // latest queued message before that hint instead of the hint alone.
    const start = index === 0 && count < rows.length
      ? Math.max(0, rows.length - 1 - count)
      : caret >= 0
      ? Math.max(0, Math.min(rows.length - count, caret - Math.floor((count - 1) / 2)))
      : index === 4 ? 0 : Math.max(0, rows.length - count);
    return { rows: count === rows.length ? rows : rows.slice(start, start + count), start, sourceHeight: rows.length };
  });
}
