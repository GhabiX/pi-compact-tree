/** Frames for Pi's working loader and compact elapsed time. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { spineSuccess } from "./colors.ts";

export const WORKING_INDICATOR_INTERVAL_MS = 25;

export function workingIndicatorFrames(theme: Pick<Theme, "bold">): string[] {
  // A green marker that grows from a dot to ϒ and back, one 2700ms cycle.
  // Pi accepts fixed ticks: repeating frames preserves the holds without a
  // plugin animation timer. Nearest-tick phase boundaries differ by <=10ms.
  const phases = [
    [900, ".", "dim"],
    [1200, ".", "bold"],
    [1360, "ʏ", "dim"],
    [1520, "Ү", "normal"],
    [2420, "ϒ", "bold"],
    [2530, "ϒ", "normal"],
    [2615, "Ү", "normal"],
    [2700, "ʏ", "dim"],
  ] as const;
  let previousTick = 0;
  return phases.flatMap(([endMs, glyph, emphasis]) => {
    const endTick = Math.round(endMs / WORKING_INDICATOR_INTERVAL_MS);
    const count = endTick - previousTick;
    previousTick = endTick;
    // The palette is fixed; SGR 2 only controls the phase intensity.
    const text = emphasis === "bold" ? theme.bold(glyph) : emphasis === "dim" ? `\x1b[2m${glyph}\x1b[22m` : glyph;
    return Array<string>(count).fill(spineSuccess(text));
  });
}

/** Session reveal clock. This is not the working-indicator timer. */
export const MOTION_TICK_MS = 25;

export type MotionSample = Readonly<{ now: number; elapsedMs: number }>;

export type MotionClock = {
  setInterval: (callback: () => void, delay?: number) => unknown;
  clearInterval: (id: unknown) => void;
  now?: () => number;
};

export type MotionScheduler = {
  arm: (key: object) => void;
  clear: (key: object) => void;
  stop: () => void;
  now: () => number;
};

function defaultClock(): MotionClock {
  return {
    setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
    clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
  };
}

/** One tick renders at most once. An empty set does not keep the timer. */
export function createMotionScheduler(
  requestRender: () => void,
  clock: MotionClock = defaultClock(),
  tickMs = MOTION_TICK_MS,
): MotionScheduler {
  const keys = new Set<object>();
  const now = clock.now ?? (() => performance.now());
  let timer: unknown;
  let previous = 0;
  let stopped = false;
  const stopTimer = () => {
    if (timer === undefined) return;
    clock.clearInterval(timer);
    timer = undefined;
  };
  return {
    arm(key) {
      if (stopped) return;
      const before = keys.size;
      keys.add(key);
      if (keys.size === before || timer !== undefined) return;
      previous = now();
      timer = clock.setInterval(() => {
        if (stopped || keys.size === 0) return;
        const at = Math.max(previous, now());
        const sample = Object.freeze({ now: at, elapsedMs: at - previous });
        previous = at;
        const outerSample = activeSample;
        activeSample = sample;
        try {
          for (const hook of motionTickHooks) hook(sample);
          requestRender();
        } finally {
          activeSample = outerSample;
        }
      }, tickMs);
    },
    clear(key) {
      if (!keys.delete(key) || keys.size > 0) return;
      stopTimer();
    },
    stop() {
      stopped = true;
      keys.clear();
      stopTimer();
    },
    now,
  };
}

let current: MotionScheduler | undefined;
let currentRender: (() => void) | undefined;
let activeSample: MotionSample | undefined;
const motionTickHooks = new Set<(sample: MotionSample) => void>();

/** One time source for semantic ingress and every participant in a frame. */
export function motionNow(): number {
  return activeSample?.now ?? current?.now() ?? performance.now();
}

export function addMotionTick(hook: (sample: MotionSample) => void): () => void {
  motionTickHooks.add(hook);
  return () => motionTickHooks.delete(hook);
}

export function hasMotionScheduler(): boolean {
  return current !== undefined;
}

export function attachMotionScheduler(requestRender: () => void, clock?: MotionClock): void {
  if (currentRender === requestRender && current) return;
  current?.stop();
  currentRender = requestRender;
  current = createMotionScheduler(requestRender, clock);
}

export function detachMotionScheduler(requestRender: () => void): void {
  if (currentRender !== requestRender) return;
  stopMotion();
}

export function armMotion(key: object): void {
  current?.arm(key);
}

export function clearMotion(key: object): void {
  current?.clear(key);
}

export function stopMotion(): void {
  current?.stop();
  current = undefined;
  currentRender = undefined;
}

export function elapsedCompact(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secondsPart = `${String(seconds % 60).padStart(2, "0")}s`;
  if (minutes < 60) return `${minutes}m ${secondsPart}`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${secondsPart}`;
}
