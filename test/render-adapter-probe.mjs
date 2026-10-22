import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	Container,
	Text,
	MouseRegion,
	stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { piRoot } from "./pi-host.mjs";
const host = (path) => import(pathToFileURL(join(piRoot, "dist", path)).href);
const theme = await host("modes/interactive/theme/theme.js");
theme.initTheme("dark", false);
const { AssistantMessageComponent } = await host(
	"modes/interactive/components/assistant-message.js",
);
const { ToolExecutionComponent } = await host(
	"modes/interactive/components/tool-execution.js",
);
const key = Symbol.for("pi-compact-ui2tree/container-render-v1");
const checks = [];
function check(name, fn) {
	fn();
	checks.push(name);
}
function context(mode = "tui") {
	return {
		mode,
		ui: {
			get theme() {
				return theme.theme;
			},
			getToolsExpanded: () => false,
			setWorkingMessage() {},
			onTerminalInput() { return () => {}; }, setWorkingIndicator() {},
			setFooter() {},
		},
	};
}
async function load(suffix = "") {
	const { default: plugin } = await import(
		`../extensions/compact-ui2tree.ts${suffix}`
	);
	const handlers = new Map();
	plugin({ on: (name, fn) => handlers.set(name, fn), registerCommand() {} });
	return handlers;
}
const plain = (c) =>
	c
		.render(80)
		.map(stripTerminalSequences)
		.map((s) => s.trimEnd());
const mixed = {
	role: "assistant",
	stopReason: "stop",
	content: [
		{ type: "thinking", thinking: "SECRET THINKING" },
		{ type: "text", text: "VISIBLE PROSE" },
	],
};
const ctx = context();
let handlers = await load();
handlers.get("session_start")({}, ctx);
const assistant = new AssistantMessageComponent(mixed, true);
const originalContentRender = assistant.contentContainer.render;
check("direct assistant render hides thinking and preserves OSC133", () => {
	const rows = assistant.render(80).join("\n");
	assert.match(rows, /VISIBLE PROSE/);
	assert.doesNotMatch(rows, /SECRET THINKING|Thinking\.\.\./);
	assert(rows.includes("\x1b]133;A\x07"));
	assert(rows.includes("\x1b]133;C\x07"));
	assert.equal(assistant.contentContainer.render, originalContentRender);
	assert.equal(Object.hasOwn(assistant.contentContainer, "render"), false);
});
check("Ctrl+T and clear/rebuild preserve filter", () => {
	assistant.setHideThinkingBlock(false);
	assert.doesNotMatch(plain(assistant).join("\n"), /SECRET THINKING/);
	assistant.updateContent({
		...mixed,
		content: [...mixed.content, { type: "text", text: "AFTER REBUILD" }],
	});
	assert.match(plain(assistant).join("\n"), /AFTER REBUILD/);
});
check("array alias is not content role", () => {
	const unrelated = new Container();
	unrelated.children = assistant.contentContainer.children;
	assert.match(plain(unrelated).join("\n"), /SECRET THINKING/);
	assert.doesNotMatch(
		plain(assistant.contentContainer).join("\n"),
		/SECRET THINKING/,
	);
});
check("native MouseRegion is visible", () => {
	const parent = new Container();
	parent.addChild(new MouseRegion(new Text("CLICK REGION", 0, 0), () => {}));
	assert.match(plain(parent).join("\n"), /CLICK REGION/);
});
const chat = new Container();
chat.addChild(assistant);
const tool = new ToolExecutionComponent(
	"bash",
	"call-1",
	{ command: "printf ok" },
	{},
	undefined,
	{ requestRender() {} },
	process.cwd(),
);
chat.addChild(tool);
check("hidden-only process policy still hides queued tools", () => {
	// A separate component: a Pi component belongs to one container, and a
	// shared one makes the second projection fall back to native rendering.
	const queued = new Container();
	queued.addChild(new ToolExecutionComponent("bash", "queued-1", { command: "printf queued" }, {}, undefined, { requestRender() {} }, process.cwd()));
	assert.deepEqual(plain(queued), []);
	assert.doesNotMatch(plain(chat).join("\n"), /Bash/);
});
check(
	"cached topology and assistant kind transitions preserve outputs",
	() => {
		tool.markExecutionStarted();
		tool.updateResult({
			isError: false,
			content: [{ type: "text", text: "ok" }],
		});
		assert.match(plain(chat).join("\n"), /Ran 1 shell command/);
		assistant.updateContent({
			...mixed,
			stopReason: "toolUse",
			content: [{ type: "thinking", thinking: "COMPLETED THOUGHT" }],
		});
		assert.match(plain(chat).join("\n"), /COMPLETED THOUGHT[\s\S]*Ran 1 shell command/);
		assistant.updateContent(mixed);
		assert.match(plain(chat).join("\n"), /VISIBLE PROSE/);
      assert.equal((plain(chat).join("\n").match(/SECRET THINKING/g) ?? []).length, 1);
		assert.doesNotMatch(plain(chat).join("\n"), /Thinking\.\.\./);
	},
);
check("error abort length diagnostics remain visible", () => {
	for (const reason of ["error", "aborted", "length"]) {
		assistant.updateContent({
			...mixed,
			stopReason: reason,
			errorMessage: "VISIBLE DIAGNOSTIC",
		});
		assert.match(
			plain(chat).join("\n"),
			reason === "length"
				? /truncated before completion/
				: /VISIBLE DIAGNOSTIC/,
		);
	}
	assistant.updateContent(mixed);
});
check("invalid container is not silently mapped to empty output", () => {
	const broken = new Container();
	broken.children = undefined;
	assert.throws(() => broken.render(80), TypeError);
});
handlers.get("session_shutdown")({}, ctx);
check("shutdown restores native thinking", () =>
	assert.match(plain(assistant).join("\n"), /SECRET THINKING/),
);
const wrapper = Container.prototype.render;
let calls = 0;
const outer = function (w) {
	calls++;
	return wrapper.call(this, w);
};
Container.prototype.render = outer;
const installed = Container.prototype[key];
handlers = await load("?reload=1");
handlers.get("session_start")({}, ctx);
check("same protocol reload preserves third-party outer wrapper", () => {
	assert.equal(Container.prototype.render, outer);
	assert.equal(Container.prototype[key], installed);
	assert.match(plain(chat).join("\n"), /VISIBLE PROSE/);
	assert(calls > 0);
	assert.equal((plain(chat).join("\n").match(/SECRET THINKING/g) ?? []).length, 1);
	assert.doesNotMatch(plain(chat).join("\n"), /Thinking\.\.\./);
});
check("content role is rediscovered after session reset", () => {
	assert(
		Container.prototype[key].assistantContents.has(
			assistant.contentContainer,
		),
	);
	assert.equal(Object.hasOwn(assistant.contentContainer, "render"), false);
});
handlers.get("session_shutdown")({}, ctx);
for (const mode of ["rpc", "json", "print"]) {
	const c = context(mode);
	handlers.get("session_start")({}, c);
	check(`${mode} delegates native`, () =>
		assert.match(plain(assistant).join("\n"), /SECRET THINKING/),
	);
	handlers.get("session_shutdown")({}, c);
}
console.log(JSON.stringify({ checks, host: piRoot }));
