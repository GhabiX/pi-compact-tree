import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("render adapter", async () => {
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[
			"--experimental-strip-types",
			"--import",
			fileURLToPath(new URL("./register.mjs", import.meta.url)),
			fileURLToPath(new URL("./render-adapter-probe.mjs", import.meta.url)),
		],
		{ timeout: 20_000 },
	);
	assert.equal(JSON.parse(stdout).checks.length, 14);
});
