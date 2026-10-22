// End-to-end TUI test: the global Pi in tmux, this plugin loaded through settings.json `packages`, and a scripted
// model (scripted-provider.ts). usage: node test/e2e/run.mjs [scenario ...]   (no arguments: every scenario)
// Each Pi gets its own agent directory. user_stack runs only when named: it loads the local packages from the
// caller's ~/.pi/agent/settings.json, and gives a SpineTree in that stack a temporary tree kept inside the run directory.
// Output goes to temp/null/<YYYYMMDD_HHmm>/e2e-<pid>/; nothing is deleted.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RECEIPT_OBSERVER = join(PLUGIN, "test/e2e/receipt-timing.ts");
const PROVIDER = join(PLUGIN, "test/e2e/scripted-provider.ts");
const pad = n => String(n).padStart(2, "0");
const now = new Date();
const STAMP = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
const RUN = join(PLUGIN, "temp/null", STAMP, `e2e-${process.pid}`);
const CONF = join(RUN, "tmux.conf");
const SOCKET = `ui2tree-e2e-${process.pid}`;
// The caller's PATH selects Pi (as `which pi` does in the other plugins); the global npm prefix is the fallback for non-interactive shells.
const PATH = `${dirname(process.execPath)}:${process.env.PATH}:${join(homedir(), ".local/npm-global/bin")}`;
const TURNS = Number(process.env.E2E_TURNS ?? 30);
const LIVE = new Set();

const tmux = (...args) => execFileSync("tmux", ["-L", SOCKET, "-f", CONF, ...args], { encoding: "utf8", stdio: "pipe" });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const lines = screen => screen.split("\n").map(line => line.trimEnd());
const hasLine = (screen, text) => lines(screen).some(line => line.trim() === text);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function agentDir(name, packages, extra = {}) {
  const dir = join(RUN, `agent-${name}`);
  mkdirSync(dir, { recursive: true });
  const settings = { defaultProvider: "ui2tree-e2e", defaultModel: "script", defaultThinkingLevel: "high", tuiMode: "regular",
    lastChangelogVersion: "1.1.0", theme: "dark", packages, ...extra };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  const tools = join(homedir(), ".pi/agent/bin"); // Pi's fd/rg helpers; linking them avoids a download
  if (existsSync(tools)) symlinkSync(tools, join(dir, "bin"));
  return dir;
}

function project(name) {
  const dir = join(RUN, `project-${name}`);
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes/a.md"), "alpha note\nsecond line\n");
  writeFileSync(join(dir, "notes/b.md"), "beta note\n");
  return dir;
}

// SpineTree's environment for a project: a fresh tree whose discovery stops at the project directory.
function spineTree(dir, name) {
  const env = { ST_DIR: join(dir, ".spinetree"), ST_CEILING_DIRS: dir, ST_USER: "ui2tree-test", ST_HARNESS: "test",
    ST_SESSION: `e2e-${process.pid}-${name}` };
  execFileSync("st", ["init", "--goal", "ui2tree e2e temporary tree"], { cwd: dir, env: { ...process.env, PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"] });
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join(" ");
}

// Non-blank lines from the line `from` through the line `to` (both compared after trimming).
function block(screen, from, to) {
  const all = lines(screen);
  const start = all.findIndex(line => line.trim() === from);
  const end = all.findIndex((line, index) => index > start && line.trim() === to);
  check(start >= 0 && end > start, `no block from "${from}" to "${to}"`);
  return all.slice(start, end + 1).filter(line => line !== "");
}

function checkBlock(screen, from, to, expected) {
  const found = block(screen, from, to);
  const same = found.length === expected.length
    && expected.every((want, index) => typeof want === "string" ? found[index] === want : want.test(found[index]));
  check(same, `unexpected block "${from}":\n${found.join("\n")}`);
}

// History drawn twice shows a turn twice.
function checkOnce(screen, tag) {
  for (const text of [`E2E:tools ${tag}`, `DONE ${tag}`]) {
    const count = lines(screen).filter(line => line.trim() === text).length;
    check(count === 1, `"${text}" appears ${count} times`);
  }
}

// A finished tools turn: each Thinking folds into its title, each run of calls into one sentence.
function checkToolsTree(screen, tag) {
  checkOnce(screen, tag);
  checkBlock(screen, `E2E:tools ${tag}`, `DONE ${tag}`, [
    ` E2E:tools ${tag}`,
    " ● Planning the next step",
    " ● Read 2 files",
    " ● Both notes are there",
    " ● Ran 1 shell command",
    ` DONE ${tag}`,
  ]);
}

class Pi {
  constructor(name, agent, cwd, args = "", extraEnv = "") {
    this.name = name; this.agent = agent;
    // PI_OFFLINE: no startup version check, whose notice lands in the transcript whenever the network answers.
    const env = `PATH=${PATH} PI_OFFLINE=1 PI_CODING_AGENT_DIR=${agent} ${extraEnv}`;
    tmux("new-session", "-d", "-s", name, "-x", "100", "-y", "40", "-c", cwd, `env ${env} pi -e ${PROVIDER} -e ${RECEIPT_OBSERVER} ${args}`);
    LIVE.add(this);
  }

  screen() {
    return tmux("capture-pane", "-p", "-t", this.name, "-S", "-", "-E", "-");
  }

  visible() {
    return tmux("capture-pane", "-p", "-t", this.name);
  }

  save(label) {
    writeFileSync(join(RUN, `${this.name}-${label}.txt`), this.screen());
  }

  async until(predicate, what, { timeout = 30_000, visible = false } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      const screen = visible ? this.visible() : this.screen();
      if (predicate(screen)) return screen;
      check(this.alive(), `${this.name}: Pi exited while waiting for ${what}`);
      if (Date.now() > end) throw new Error(`${this.name}: timed out waiting for ${what}`);
      await sleep(200);
    }
  }

  untilLine(text, timeout) {
    return this.until(screen => hasLine(screen, text), `"${text}"`, { timeout });
  }

  async untilStable(tag, timeout=60000) {
    const end=Date.now()+timeout;
    while(Date.now()<end){
      try { const r=JSON.parse(readFileSync(join(this.agent,'receipt-timings.json'),'utf8'))[tag]; if(r?.stableAt)return r; }
      catch(error){ if(error.code!=='ENOENT')throw error; }
      await sleep(50);
    }
    throw Error(`no receipt-complete stable terminal for ${tag}`);
  }

  // Waits until the screen stops changing; folds keep animating for a moment after the reply text appears.
  async settle(timeout = 30_000) {
    const end = Date.now() + timeout;
    let last = this.screen();
    for (;;) {
      await sleep(1000);
      check(this.alive(), `${this.name}: Pi exited while settling`);
      const screen = this.screen();
      if (screen === last) return screen;
      check(Date.now() < end, `${this.name}: the screen kept changing for ${timeout}ms`);
      last = screen;
    }
  }

  started() {
    return this.until(screen => screen.includes("context left"), "the plugin footer");
  }

  async send(text) {
    tmux("send-keys", "-t", this.name, "-l", text);
    await sleep(300);
    tmux("send-keys", "-t", this.name, "Enter");
  }

  key(name) {
    tmux("send-keys", "-t", this.name, name);
  }

  resize(rows) {
    tmux("resize-window", "-t", this.name, "-x", "100", "-y", String(rows));
  }

  // remain-on-exit keeps the pane, and its last screen, after Pi exits.
  alive() {
    return tmux("display-message", "-p", "-t", this.name, "#{pane_dead}").trim() === "0";
  }

  async quit() {
    this.key("C-d");
    const end = Date.now() + 15_000;
    while (this.alive()) {
      check(Date.now() < end, `${this.name}: Pi did not exit on Ctrl-D`);
      await sleep(200);
    }
    LIVE.delete(this);
  }
}

const SCENARIOS = {
  async tree() {
    // The plugin replaces Pi's tool cards, Thinking blocks, editor and footer; its packaged theme registers.
    const pi = new Pi("tree", agentDir("tree", [PLUGIN], { theme: "spine-dark" }), project("tree"));
    const start = await pi.started();
    check(start.includes("compact-ui2tree.ts"), "the plugin is not listed under [Extensions]");
    check(!/Failed to load|Extension issues|Error:/.test(start), "startup reported a problem");
    check(hasLine(start, "› Ask Pi to do anything"), "borderless input panel missing");
    check(/^  script high · .* 100% context left$/m.test(start), "single-line footer missing");
    check(!start.includes("(auto)"), "Pi's native footer statistics are still drawn");
    await pi.send("E2E:tools t1");
    await pi.untilLine("DONE t1");
    const done = await pi.settle();
    checkToolsTree(done, "t1");
    check(!/\$ echo shell-t1|read notes\/a\.md|Took \d/.test(done), "Pi's native tool cards are still drawn");
    await pi.send("E2E:fail t2");
    await pi.untilLine("DONE t2");
    const failed = await pi.settle();
    checkBlock(failed, "E2E:fail t2", "DONE t2",
      [" E2E:fail t2", " ● Try a command that fails", " ● Ran 1 shell command",
        "   ⎿  Bash(echo broken >&2; exit 3) · Error: Command exited with code 3", " DONE t2"]);
    pi.save("end");
    await pi.quit();
  },

  async working() {
    // While the model is busy, Pi's working indicator sits directly above the input panel, and leaves afterwards.
    const pi = new Pi("working", agentDir("working", [PLUGIN]), project("working"));
    await pi.started();
    await pi.send("E2E:wait 4000");
    const busy = lines(await pi.until(screen => /Resonating \(\d+s • esc to interrupt\)/.test(screen),
      "the working indicator", { visible: true }));
    const indicator = busy.findIndex(line => line.includes("Resonating"));
    const editor = busy.findIndex(line => line.trim() === "› Ask Pi to do anything");
    check(indicator >= 0 && editor > indicator && busy.slice(indicator + 1, editor).every(line => line === ""),
      `indicator is not right above the input panel:\n${busy.join("\n")}`);
    await pi.untilLine("DONE 4000");
    check(!(await pi.settle()).includes("Resonating"), "the working indicator stayed after the run");
    await pi.quit();
  },

  async reload_and_resume() {
    // /reload keeps drawn history and the plugin; /thoughts shows saved Thinking; `pi -c` redraws the session as a tree.
    const agent = agentDir("reload", [PLUGIN]);
    const cwd = project("reload");
    const pi = new Pi("reload", agent, cwd);
    await pi.started();
    await pi.send("E2E:tools r1");
    await pi.untilLine("DONE r1");
    await pi.send("/reload");
    await pi.until(screen => screen.includes("Reloaded keybindings"), "the reload notice");
    await pi.send("E2E:tools r2");
    await pi.untilLine("DONE r2");
    const after = await pi.settle();
    checkToolsTree(after, "r1");
    checkToolsTree(after, "r2");
    await pi.send("/thoughts");
    await pi.until(screen => screen.includes("Thinking 4/4") && screen.includes("Esc close"), "the /thoughts overlay", { visible: true });
    pi.key("Escape");
    await pi.until(screen => !screen.includes("Esc close") && screen.includes("› Ask Pi to do anything"), "the overlay to close", { visible: true });
    pi.save("end");
    await pi.quit();
    const resumed = new Pi("resumed", agent, cwd, "-c");
    await resumed.started();
    const restored = await resumed.settle();
    checkToolsTree(restored, "r1");
    checkToolsTree(restored, "r2");
    resumed.save("end");
    await resumed.quit();
  },

  async long_session() {
    // E2E_TURNS tool turns in one session: every turn still folds to the same tree. Then Ctrl+O and two height
    // changes. Turn latency is reported.
    const pi = new Pi("long", agentDir("long", [PLUGIN]), project("long"));
    await pi.started();
    const latency = [], stableLatency = [], observerRecords = [];
    for (let turn = 1; turn <= TURNS; turn++) {
      const sent = Date.now();
      await pi.send(`E2E:tools l${turn}`);
      await pi.untilLine(`DONE l${turn}`, 60_000);
      latency.push(Date.now() - sent);
      const receipt = await pi.untilStable(`l${turn}`); stableLatency.push(receipt.stableAt-sent); observerRecords.push({...receipt,sent});
    }
    const screen = await pi.settle();
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const report = { turns: TURNS, firstFiveMedianMs: median(latency.slice(0, 5)), lastFiveMedianMs: median(latency.slice(-5)), latency, stableLatency, observerRecords, stableFirstFiveMedianMs: median(stableLatency.slice(0,5)), stableLastFiveMedianMs: median(stableLatency.slice(-5)) };
    writeFileSync(join(RUN, "long-latency.json"), JSON.stringify(report, null, 2));
    for (let turn = 1; turn <= TURNS; turn++) checkToolsTree(screen, `l${turn}`);
    // The long history is sealed by now. After Ctrl+O changes how it would be drawn, height-only reflows must
    // redraw it once and keep working. Frozen rows stay as drawn, so only the count of each turn is checked.
    pi.key("C-o");
    await pi.settle();
    for (const [rows, turn] of [[30, TURNS + 1], [40, TURNS + 2]]) {
      pi.resize(rows);
      await sleep(1000);
      await pi.send(`E2E:tools l${turn}`);
      await pi.untilLine(`DONE l${turn}`, 60_000);
    }
    const reflowed = await pi.settle();
    for (let turn = 1; turn <= TURNS + 2; turn++) checkOnce(reflowed, `l${turn}`);
    console.log(`  long_session: ${TURNS} turns, send→DONE median first 5 ${report.firstFiveMedianMs}ms, last 5 ${report.lastFiveMedianMs}ms`);
    console.log(`  necessary receipts/stable: first5 ${report.stableFirstFiveMedianMs}ms, last5 ${report.stableLastFiveMedianMs}ms`);
    pi.save("end");
    await pi.quit();
  },

  async long_reload() {
    // /reload after a session longer than the screen: every earlier turn still appears exactly once.
    const pi = new Pi("longreload", agentDir("longreload", [PLUGIN]), project("longreload"));
    await pi.started();
    for (let turn = 1; turn <= 8; turn++) {
      await pi.send(`E2E:tools m${turn}`);
      await pi.untilLine(`DONE m${turn}`, 60_000);
    }
    await pi.settle();
    await pi.send("/reload");
    await pi.until(screen => screen.includes("Reloaded keybindings"), "the reload notice");
    await pi.send("E2E:tools m9");
    await pi.untilLine("DONE m9", 60_000);
    const screen = await pi.settle();
    for (let turn = 1; turn <= 9; turn++) checkToolsTree(screen, `m${turn}`);
    pi.save("end");
    await pi.quit();
  },

  async session_switch() {
    // /new and /resume after a session longer than the screen: only the current session is drawn, as the same tree.
    const pi = new Pi("switch", agentDir("switch", [PLUGIN]), project("switch"));
    await pi.started();
    await pi.send("/name E2E_FIRST");
    for (let turn = 1; turn <= 6; turn++) {
      await pi.send(`E2E:tools s${turn}`);
      await pi.untilLine(`DONE s${turn}`, 60_000);
    }
    await pi.settle();
    await pi.send("/new");
    await pi.until(screen => screen.includes("New session started"), "the new session notice");
    await pi.send("E2E:tools n1");
    await pi.untilLine("DONE n1", 60_000);
    const fresh = await pi.settle();
    pi.save("new");
    checkToolsTree(fresh, "n1");
    for (let turn = 1; turn <= 6; turn++) check(!hasLine(fresh, `DONE s${turn}`), `/new left "DONE s${turn}" on screen`);
    await pi.send("/resume");
    await sleep(1000);
    tmux("send-keys", "-t", pi.name, "-l", "E2E_FIRST");
    await sleep(1000);
    pi.key("Enter");
    await pi.until(screen => screen.includes("Resumed session"), "the resume notice");
    const resumed = await pi.settle();
    pi.save("resume");
    for (let turn = 1; turn <= 6; turn++) checkToolsTree(resumed, `s${turn}`);
    check(!hasLine(resumed, "DONE n1"), `/resume left "DONE n1" on screen`);
    await pi.quit();
  },

  async user_stack() {
    // The same tool turn with every local package from the user's Pi settings, loaded the way the user loads them.
    const settings = JSON.parse(readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8"));
    const installedPackages = settings.packages.filter(entry => !entry.startsWith("npm:")).map(entry => resolve(homedir(), ".pi/agent", entry));
    check(installedPackages.some(entry => entry.endsWith("/pi-compact-ui2tree")), "the user's Pi settings do not load the ui2tree package");
    const packages = installedPackages.map(entry => entry.endsWith("/pi-compact-ui2tree") ? PLUGIN : entry);
    const cwd = project("stack");
    const pi = new Pi("stack", agentDir("stack", packages), cwd, "", spineTree(cwd, "stack"));
    const start = await pi.started();
    check(start.includes("compact-ui2tree.ts"), "the plugin is not listed under [Extensions]");
    const all = lines(start);
    const from = all.indexOf("[Extension issues]");
    const issues = from < 0 ? [] : all.slice(from + 1, all.indexOf("", from));
    check(!issues.some(line => line.includes(PLUGIN)), `a startup issue names this plugin:\n${issues.join("\n")}`);
    await pi.send("E2E:tools k1");
    await pi.untilLine("DONE k1");
    checkToolsTree(await pi.settle(), "k1");
    pi.save("end");
    await pi.quit();
  },
};

mkdirSync(RUN, { recursive: true });
writeFileSync(CONF, "set -g history-limit 100000\nset -g remain-on-exit on\n");
const chosen = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(SCENARIOS).filter(name => name !== "user_stack");
const failures = [];
for (const name of chosen) {
  const started = Date.now();
  try {
    await SCENARIOS[name]();
    console.log(`PASS ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${error.message}`);
    for (const pi of LIVE) pi.save("failed");
  }
  for (const pi of LIVE) { if (pi.alive()) await pi.quit(); }
  LIVE.clear();
}
tmux("kill-server");
console.log(`${chosen.length - failures.length}/${chosen.length} passed · output ${RUN}`);
process.exitCode = failures.length > 0 ? 1 : 0;
