import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("detached projection caches are collectible and live hooks are disposed", async () => {
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[
			"--expose-gc",
			"--experimental-strip-types",
			"--import",
			fileURLToPath(new URL("./register.mjs", import.meta.url)),
			fileURLToPath(new URL("./projection-gc.mjs", import.meta.url)),
		],
		{ timeout: 20_000 },
	);
	assert.deepEqual(JSON.parse(stdout), {
		collected: 4_000,
		liveHooksRestored: true,
	});
});
