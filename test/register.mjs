import { mkdirSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const d = new Date(), p = n => String(n).padStart(2, "0");
const minute = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
/** This minute's directory under the repo's temp/null. */
export const tempMinute = join(fileURLToPath(new URL("../temp/null", import.meta.url)), minute);

// Pi writes crashes, settings and sessions under its agent dir; tests get their own so they never touch ~/.pi/agent.
// Files run by one node --test share the runner's dir (their parent pid).
if (!process.env.PI_CODING_AGENT_DIR) {
  const run = process.env.NODE_TEST_CONTEXT ? process.ppid : process.pid;
  process.env.PI_CODING_AGENT_DIR = join(tempMinute, `pi-agent-${run}`);
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
}
register("./resolve-pi.mjs", import.meta.url);
