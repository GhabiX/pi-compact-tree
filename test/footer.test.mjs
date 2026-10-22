import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { piRoot, pluginRoot } from "./pi-host.mjs";
import { formatCwd, renderFooter } from "../extensions/footer.ts";

const { loadThemeFromPath, Theme } = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/theme/theme.js")));
const palettes = [];
for (const name of ["dark", "light"]) for (const mode of ["truecolor", "256color"]) {
  palettes.push({ name, mode, theme: loadThemeFromPath(join(pluginRoot, `themes/spine-${name}.json`), mode) });
}
const regular = {
  cwd: "/home/test/project", home: "/home/test", model: { id: "gpt-6-astra", reasoning: true },
  thinkingLevel: "xhigh", context: { percent: 28 },
};
const plain = (snapshot, width, theme = palettes[0].theme) => stripTerminalSequences(renderFooter(snapshot, width, theme)[0]);

test("model then reasoning and directory, with exact remaining context at both widths", () => {
  for (const { theme } of palettes) for (const width of [40, 80]) {
    const line = plain(regular, width, theme);
    assert.match(line, /^  gpt-6-astra xhigh · ~/u);
    assert.ok(line.endsWith(width === 80 ? "72% context left " : "72% left "));
    assert.equal(visibleWidth(line), width);
    assert.doesNotMatch(line, /Total|Cached|CH|tok\/s|[$█░]/u);
  }
});

test("unknown context stays unknown and input objects remain untouched", () => {
  for (const context of [undefined, { percent: null }, { percent: NaN }, { percent: Infinity }, { percent: -Infinity }]) {
    const snapshot = Object.freeze({ ...regular, context });
    const line = plain(snapshot, 80);
    assert.doesNotMatch(line, /%|left/u);
    assert.equal(line, "  gpt-6-astra xhigh · ~/project");
    assert.equal(snapshot.context, context);
  }
  const snapshot = { ...regular, model: { id: "gpt", reasoning: true }, context: { percent: 28 } };
  const before = structuredClone(snapshot);
  renderFooter(snapshot, 80, palettes[0].theme);
  assert.deepEqual(snapshot, before);
});

test("context is clamped and rounded as remaining, not used", () => {
  for (const [used, remaining] of [[-9, 100], [0, 100], [7.8, 92], [28, 72], [99.9, 0], [100, 0], [130, 0]]) {
    const line = plain({ ...regular, context: { percent: used } }, 80);
    assert.ok(line.endsWith(`${remaining}% context left `));
  }
});

test("only reasoning models display effort and unavailable model is explicit", () => {
  assert.match(plain({ ...regular, model: { id: "plain", reasoning: false } }, 80), /^  plain · ~/u);
  assert.doesNotMatch(plain({ ...regular, model: { id: "plain" } }, 80), /xhigh/u);
  assert.match(plain({ ...regular, thinkingLevel: undefined }, 80), /^  gpt-6-astra off · ~/u);
  assert.match(plain({ ...regular, model: undefined }, 80), /^  no-model · ~/u);
});

test("home abbreviation does not include a sibling with the same prefix", () => {
  assert.equal(formatCwd("/home/test/project", "/home/test"), "~/project");
  assert.equal(formatCwd("/home/test", "/home/test"), "~");
  assert.equal(formatCwd("/home/test-next/project", "/home/test"), "/home/test-next/project");
  assert.equal(formatCwd("/work/project", "/home/test"), "/work/project");
});

test("ANSI and control metadata cannot inject rows or override footer colors", () => {
  const snapshot = {
    cwd: "/tmp/项目\n\x1b[31m实验\x1b[0m\t👩‍💻\u2028end",
    home: "/home/test", model: { id: "\x1b[32m模型\x1b[0m\r开发\x07", reasoning: true },
    thinkingLevel: "高\t速\u2029终", context: { percent: 28 },
  };
  const rows = renderFooter(snapshot, 160, palettes[0].theme);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(rows[0], /[\r\n\t\x07\u2028\u2029]/u);
  assert.doesNotMatch(rows[0], /\x1b\[(?:31|32)m/u);
  const line = stripTerminalSequences(rows[0]);
  assert.match(line, /模型 开发 高 速 终 · \/tmp\/项目 实验 👩‍💻 end/u);
  assert.ok(visibleWidth(line) <= 160);
});

test("long Unicode metadata remains a single grapheme-safe row at widths 1 through 120", () => {
  const unicode = {
    ...regular, cwd: "/tmp/项目/👩‍💻/🇨🇳/é/".repeat(20),
    model: { id: "模型👩‍💻é🇨🇳型号".repeat(8), reasoning: true }, thinkingLevel: "深度",
  };
  for (const { theme } of palettes) for (let width = 1; width <= 120; width++) {
    for (const snapshot of [unicode, { ...unicode, context: undefined }, regular]) {
      const rows = renderFooter(snapshot, width, theme);
      assert.equal(rows.length, 1);
      const line = stripTerminalSequences(rows[0]);
      assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
      assert.doesNotMatch(line, /[\r\n\t\x1b\ufffd]/u);
      assert.doesNotMatch(line, /[\ud800-\udfff]/u, "no split surrogate pair");
      if (line.includes("%")) assert.match(line, /\d+% (?:context )?left $/u, "no clipped context label");
    }
  }
});

test("long directory yields space to model and context, context hides below usable width", () => {
  const line = plain({ ...regular, cwd: "/data/projects/example-app/packages/web-client" }, 40);
  assert.match(line, /^  gpt-6-astra xhigh · \/data\/…/u);
  assert.ok(line.endsWith("72% left "));
  assert.equal(plain(regular, 1), "…");
  assert.equal(plain(regular, 2), " …");
  assert.doesNotMatch(plain(regular, 12), /%/u);
});

test("truecolor uses softened syntax roles and indexed/default colors stay in their selected mode", () => {
  const fg = { syntaxType: "#ff0000", syntaxString: "#00ff00", dim: "#222222", muted: "#666666", text: "#eeeeee", thinkingXhigh: "#ffffff" };
  const bg = { selectedBg: "#333333" };
  const truecolor = new Theme(fg, bg, "truecolor");
  const line = renderFooter(regular, 80, truecolor)[0];
  // Red luma=76 -> (228,11,11), green luma=149 -> (22,239,22).
  assert.ok(line.startsWith("  \x1b[38;2;228;11;11mgpt-6-astra xhigh\x1b[39m"));
  assert.ok(line.includes("\x1b[38;2;22;239;22m~/project\x1b[39m"));
  const indexed = new Theme({ ...fg, syntaxType: 42, syntaxString: 196 }, bg, "256color");
  const indexedLine = renderFooter(regular, 80, indexed)[0];
  assert.ok(indexedLine.includes("\x1b[38;5;42mgpt-6-astra xhigh"));
  assert.ok(indexedLine.includes("\x1b[38;5;196m~/project"));
  assert.doesNotMatch(indexedLine, /38;2;/u);
  const defaults = new Theme({ ...fg, syntaxType: "", syntaxString: "" }, bg, "truecolor");
  const defaultLine = renderFooter(regular, 80, defaults)[0];
  assert.ok(defaultLine.includes("\x1b[39mgpt-6-astra xhigh\x1b[39m"));
  assert.ok(defaultLine.includes("\x1b[39m~/project\x1b[39m"));
  assert.notEqual(renderFooter(regular, 80, palettes[0].theme)[0], renderFooter(regular, 80, palettes[2].theme)[0]);
});
