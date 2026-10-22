import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Test against the Pi that loads the plugin: the global installation.
// PI_TEST_ROOT can select another Pi installation.
export const piRoot = process.env.PI_TEST_ROOT
  ?? join(execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
export const piRequire = createRequire(join(piRoot, "package.json"));
export const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
