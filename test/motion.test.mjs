import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKING_INDICATOR_INTERVAL_MS, workingIndicatorFrames, elapsedCompact, MOTION_TICK_MS,
  createMotionScheduler, addMotionTick, motionNow } from "../extensions/motion.ts";

test("motion samples use monotonic elapsed time and share one time across hooks", () => {
  let now = 100;
  let callback;
  let renders = 0;
  const samples = [];
  const observations = [];
  const unsubscribe = addMotionTick((sample) => { samples.push(sample); observations.push(motionNow()); now += 1; });
  const unsubscribeOther = addMotionTick((sample) => { assert.equal(sample, samples.at(-1)); observations.push(motionNow()); });
  const scheduler = createMotionScheduler(() => { renders++; observations.push(motionNow()); }, {
    now: () => now,
    setInterval(fn, period) { callback = fn; assert.equal(period, 25); return 1; },
    clearInterval() {},
  });
  try {
    assert.equal(MOTION_TICK_MS, 25);
    scheduler.arm({});
    for (const at of [100, 110, 150, 300, 1_300]) { now = at; callback(); }
    assert.deepEqual(samples, [
      { now: 100, elapsedMs: 0 }, { now: 110, elapsedMs: 10 }, { now: 150, elapsedMs: 40 },
      { now: 300, elapsedMs: 150 }, { now: 1_300, elapsedMs: 1_000 },
    ]);
    assert.deepEqual(observations, samples.flatMap(({ now }) => [now, now, now]));
    assert.equal(renders, 5);
    assert.ok(samples.every(Object.isFrozen));
  } finally { scheduler.stop(); unsubscribe(); unsubscribeOther(); }
});

test("motion restarts without banking idle time and stops with its last key", () => {
  let now = 0;
  let callback;
  let timers = 0;
  let renders = 0;
  const samples = [];
  const unsubscribe = addMotionTick((sample) => samples.push(sample));
  const scheduler = createMotionScheduler(() => renders++, {
    now: () => now,
    setInterval(fn) { callback = fn; timers++; return 1; },
    clearInterval() { timers--; },
  });
  const first = {}, second = {};
  try {
    scheduler.arm(first); scheduler.arm(first); scheduler.arm(second);
    assert.equal(timers, 1);
    now = 25; callback();
    scheduler.clear(first);
    assert.equal(timers, 1);
    scheduler.clear(second);
    assert.equal(timers, 0);
    now = 100_000; callback();
    assert.equal(renders, 1);
    scheduler.arm(first);
    now += 25; callback();
    assert.deepEqual(samples.map((sample) => sample.elapsedMs), [25, 25]);
    scheduler.stop(); callback(); scheduler.arm(second);
    assert.equal(timers, 0);
    assert.equal(renders, 2);
  } finally { scheduler.stop(); unsubscribe(); }
});

test("elapsed time handles second, minute, and hour boundaries", () => {
  for (const [milliseconds, expected] of [
    [-1, "0s"],
    [0, "0s"],
    [999, "0s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 00m 00s"],
    [3_661_000, "1h 01m 01s"],
    [90_061_000, "25h 01m 01s"],
  ]) assert.equal(elapsedCompact(milliseconds), expected);
});

test("native loader frames preserve the marker's phase lengths and intensity", () => {
  const theme = { fg: (_color, text) => text, bold: text => `\x1b[1m${text}\x1b[22m` };
  const frames = workingIndicatorFrames(theme);
  const runs = [];
  for (const frame of frames) {
    if (runs.at(-1)?.frame === frame) runs.at(-1).endMs += WORKING_INDICATOR_INTERVAL_MS;
    else runs.push({ frame, endMs: (runs.at(-1)?.endMs ?? 0) + WORKING_INDICATOR_INTERVAL_MS });
  }
  const expected = [
    [900, "\x1b[38;5;35m\x1b[2m.\x1b[22m\x1b[39m"], [1200, "\x1b[38;5;35m\x1b[1m.\x1b[22m\x1b[39m"],
    [1360, "\x1b[38;5;35m\x1b[2mʏ\x1b[22m\x1b[39m"], [1520, "\x1b[38;5;35mҮ\x1b[39m"],
    [2420, "\x1b[38;5;35m\x1b[1mϒ\x1b[22m\x1b[39m"], [2530, "\x1b[38;5;35mϒ\x1b[39m"],
    [2615, "\x1b[38;5;35mҮ\x1b[39m"], [2700, "\x1b[38;5;35m\x1b[2mʏ\x1b[22m\x1b[39m"],
  ];
  assert.equal(runs.length, expected.length);
  runs.forEach((run, index) => {
    assert.equal(run.frame, expected[index][1]);
    assert.ok(Math.abs(run.endMs - expected[index][0]) <= 10);
  });
  assert.equal(frames.length * WORKING_INDICATOR_INTERVAL_MS, 2700);
});
