import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTool } from "../extensions/format.ts";
import { fg256, spineSuccess } from "../extensions/colors.ts";

test("plugin colors use the fixed indexed palette", () => {
  assert.equal(spineSuccess("●"), "\x1b[38;5;35m●\x1b[39m");
  assert.equal(fg256("dim", "preview"), "\x1b[38;5;241mpreview\x1b[39m");
});

test("completed tool rendering uses indexed completion colors without consulting theme colors", () => {
  const theme = {
    fg() { throw new Error("plugin must own its colors"); },
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  for (const toolName of ["read", "bash"]) {
    const row = renderTool({ toolName, args: { path: "a.md", command: "pwd" }, status: "completed" }, { width: 120, theme, expanded: false, pulse: 0 })[0];
    assert.ok(row.includes("\x1b[38;5;35m●"));
    assert.ok(row.includes(theme.bold(toolName === "read" ? "Read" : "Bash")));
    assert.match(row, toolName === "read" ? /a\.md/ : /pwd/);
    assert.doesNotMatch(row, /\x1b\[38;2;/u);
  }
});
