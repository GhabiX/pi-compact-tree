import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Container, Text } from "@earendil-works/pi-tui";
import compactUi2Tree from "../extensions/compact-ui2tree.ts";

const handlers = new Map();
compactUi2Tree({ on: (name, handler) => handlers.set(name, handler), registerCommand() {} });
const ctx = {
	mode: "tui",
	ui: {
		theme: { bold: (text) => text },
		getToolsExpanded: () => false,
		setWorkingMessage() {},
		setWorkingIndicator() {},
		setFooter() {},
	},
};
const start = () => handlers.get("session_start")({}, ctx);
const stop = () => handlers.get("session_shutdown")({}, ctx);
start();

const state =
	Container.prototype[Symbol.for("pi-compact-ui2tree/container-render-v1")];
const tool = () => ({
	toolName: "read",
	args: { path: "example.ts" },
	result: { content: [], isError: false },
	updateResult(result) {
		this.result = result;
	},
	setExpanded() {},
	render: () => ["native tool"],
});

function temporary(index) {
	const parent = new Container();
	const child = index % 2 === 0 ? new Text(`temporary-${index}`, 0, 0) : tool();
	parent.addChild(child);
	parent.render(80);
	const cache = state.cacheByContainer.get(parent);
	cache.gate.prepare([{ id: `retained-${index}`, text: 'x'.repeat(1024), limit: 'x'.repeat(1024), live: false }], true);
	return [parent, child, cache, cache.gate].map(
		(value) => new WeakRef(value),
	);
}

const live = new Container();
const card = tool();
const original = card.updateResult;
live.addChild(card);
live.render(80);
assert.notEqual(card.updateResult, original);
const refs = Array.from({ length: 1_000 }, (_, index) =>
	temporary(index),
).flat();

try {
	let collected = false;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		// WeakRef targets remain alive until the end of the job that derefs them.
		await setImmediate();
		global.gc();
		await setImmediate();
		collected = refs.every((ref) => ref.deref() === undefined);
		if (collected && state.caches.size === 1) break;
	}
	assert.equal(
		collected,
		true,
		"detached containers, children, caches and playback gates must be collectible",
	);
	assert.equal(
		state.caches.size,
		1,
		"collected cache tracking entries must also be released",
	);
	assert.match(live.render(80).join("\n"), /Read/);
	start();
	assert.equal(
		card.updateResult,
		original,
		"session replacement must restore live hooks",
	);
	live.render(80);
	assert.notEqual(card.updateResult, original);
	stop();
	assert.equal(card.updateResult, original, "shutdown must restore live hooks");
	assert.equal(state.caches.size, 0);
	stop();
	console.log(
		JSON.stringify({ collected: refs.length, liveHooksRestored: true }),
	);
} finally {
	stop();
}
