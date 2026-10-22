/** Paced prefixes (Thinking, live prose) and their exact host receipts, and the receipt that each process item has settled on screen. */
import { normalizeThinkingPrefix } from "./format.ts";
import { addMotionTick, armMotion, clearMotion, motionNow, type MotionSample } from "./motion.ts";

/**
 * Pace: a body plays at the rate its source arrives (a time-weighted average
 * over RATE_MS), plus its backlog spread over CATCHUP_MS. A provider burst then
 * plays at the model's speed instead of rushing, and the body never lags far.
 */
export const RATE_MS = 1000;
export const CATCHUP_MS = 1000;
export const UNITS_PER_TOKEN = 4;
export const MIN_TOKENS_PER_SECOND = 10;
const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
type GraphemeIndex = { source: string; ends: number[]; units: number[] };

function isHan(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
}

/** Han is one token. Anything else is a quarter token, so a partial character never waits on bytes. */
function unitCost(char: string): number {
  return isHan(char) ? UNITS_PER_TOKEN : 1;
}

function unitLength(text: string): number {
  let units = 0;
  for (const char of text) units += unitCost(char);
  return units;
}

function buildGraphemeIndex(text: string): GraphemeIndex {
  const ends: number[] = [];
  const costs: number[] = [];
  let total = 0;
  for (const part of graphemeSegmenter.segment(text)) {
    const cost = unitLength(part.segment);
    ends.push(part.index + part.segment.length);
    total += cost;
    costs.push(total);
  }
  return { source: text, ends, units: costs };
}

function cachedGraphemeIndex(text: string, key: string, cache: Map<string, GraphemeIndex>): GraphemeIndex {
  const existing = cache.get(key);
  if (existing?.source === text) return existing;
  const index = buildGraphemeIndex(text);
  cache.set(key, index);
  return index;
}

/** Longest complete grapheme prefix whose existing token units fit. */
function prefixByUnits(text: string, units: number, key: string, cache: Map<string, GraphemeIndex>): string {
  if (units <= 0) return "";
  const index = cachedGraphemeIndex(text, key, cache);
  let lo = 0, hi = index.units.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (index.units[mid] <= units) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(0, lo ? index.ends[lo - 1] : 0);
}


export const sourceId = (token: string, tool: string): string => `card:${token}:${tool}`;
/** Receipt that an item's final row was painted with no motion left: grown in, folded, or (`phase`) its run closed. */
export const settleId = (source: string, phase?: string): string => `settle:${source}${phase ? `#${phase}` : ""}`;
const settleOwner = (id: string): string => id.slice("settle:".length).split("#")[0];

export type Admission = "play" | "final";
/** `ended`: the source will not grow any more (its stream ended). */
export type FlowSource = { id: string; text: string; live: boolean; ended: boolean; interrupted?: boolean; limit: string };

/** The longest common prefix: a rewritten source keeps what still matches instead of replaying. */
function commonPrefix(left: string, right: string): string {
  let end = 0;
  while (end < left.length && end < right.length && left[end] === right[end]) end += 1;
  return left.slice(0, end);
}
/**
 * `rate`: source arrival in units per second; `seenAt`: when the source last grew; `doneAt`: when its whole text was drawn.
 * `finished`: the source ended and all of it was drawn. Its text can still change, as prose is the host's rows
 * folded at the current width, but that is the same content laid out again, never more to play.
 */
type Flow = { text: string; shown: string; drawn?: string; limit: string; credit: number; rate: number; seenAt: number;
  doneAt?: number; ended: boolean; finished?: true };
const gates = new Map<WeakRef<PaintGate>, object>();
const activeGates = new Set<WeakRef<PaintGate>>();
function releaseGate(ref: WeakRef<PaintGate>): void {
  const token = gates.get(ref);
  if (token) clearMotion(token);
  activeGates.delete(ref);
  gates.delete(ref);
}
const finalizer = new FinalizationRegistry<WeakRef<PaintGate>>(releaseGate);
addMotionTick(sample => {
  for (const ref of activeGates) {
    const gate = ref.deref();
    if (gate) gate.advance(sample);
    else releaseGate(ref);
  }
});

export class PaintGate {
  private readonly token = {};
  private readonly ref = new WeakRef(this);
  private flows = new Map<string, Flow>();
  /** Settle receipt id → when it was drawn. */
  private settled = new Map<string, number>();
  private indexes = new Map<string, GraphemeIndex>();
  private active: string[] = [];
  private revisionValue = 0;
  get revision(): number { return this.revisionValue; }

  constructor() { gates.set(this.ref, this.token); finalizer.register(this, this.ref, this.ref); }

  prepare(sources: readonly FlowSource[], scheduler: boolean): void {
    this.active = sources.filter(source => scheduler && source.live && !source.interrupted).map(source => source.id);
    for (const source of sources) {
      if (!scheduler || !source.live || source.interrupted) {
        if (this.flows.delete(source.id)) this.revisionValue++;
        this.indexes.delete(source.id);
        continue;
      }
      let flow = this.flows.get(source.id);
      if (!flow) {
        flow = { text: source.text, shown: "", limit: source.limit,
          drawn: source.text === "" ? "" : undefined, credit: 0, rate: 0, seenAt: motionNow(), ended: source.ended };
        this.flows.set(source.id, flow);
        this.revisionValue++;
      } else if (flow.finished) {
        if (flow.text !== source.text) {
          flow.text = flow.shown = flow.drawn = flow.limit = source.text;
          this.indexes.delete(source.id);
          this.revisionValue++;
        }
      } else {
        if (flow.text !== source.text) {
          if (source.text.startsWith(flow.text)) {
            const now = motionNow(), seconds = (now - flow.seenAt) / 1000;
            const weight = 1 - Math.exp(-seconds * 1000 / RATE_MS);
            if (seconds > 0) flow.rate += weight * (unitLength(source.text.slice(flow.text.length)) / seconds - flow.rate);
            flow.seenAt = now;
          }
          const normalized = normalizeThinkingPrefix(source.text, commonPrefix(source.text, flow.shown));
          if (!source.text.startsWith(flow.shown) || flow.drawn !== flow.shown && normalized !== flow.shown) {
            flow.shown = normalized;
            if (source.text === "") flow.drawn = "";
            else if (flow.drawn !== normalized) flow.drawn = undefined;
            flow.credit = 0;
          }
          this.indexes.delete(source.id);
          flow.text = source.text;
          this.revisionValue++;
        }
        flow.limit = source.limit;
      }
      flow.ended = source.ended;
      if (flow.ended && flow.drawn === flow.text) flow.finished = true;
    }
    this.arm();
  }

  flowText(id: string): string { return this.flows.get(id)?.shown ?? ""; }
  flowComplete(id: string, text: string): boolean { const flow = this.flows.get(id); return !flow || flow.drawn === text; }
  isSettled(source: string, phase?: string): boolean { return this.settled.has(settleId(source, phase)); }
  settledAt(source: string, phase?: string): number | undefined { return this.settled.get(settleId(source, phase)); }
  flowDoneAt(id: string): number | undefined { return this.flows.get(id)?.doneAt; }
  /**
   * How `source` entered the screen, decided once and kept: it played, or it went
   * straight to its final form because a newer item was already waiting.
   */
  admit(source: string, how: Admission): Admission {
    const decided = this.admission(source);
    if (decided) return decided;
    this.settled.set(settleId(source, how), motionNow());
    return how;
  }
  admission(source: string): Admission | undefined {
    return this.settled.has(settleId(source, "play")) ? "play" : this.settled.has(settleId(source, "final")) ? "final" : undefined;
  }

  acknowledge(id: string, text: string): boolean {
    if (id.startsWith("settle:")) {
      if (this.settled.has(id)) return false;
      this.settled.set(id, motionNow());
      this.revisionValue++;
      return true;
    }
    const flow = this.flows.get(id);
    if (!flow || text !== flow.shown || text === flow.drawn) return false;
    flow.drawn = text;
    if (text === flow.text) {
      this.indexes.delete(id); flow.doneAt = motionNow();
      if (flow.ended) flow.finished = true;
    }
    this.revisionValue++;
    this.arm();
    return true;
  }

  advance(sample: MotionSample): void {
    // A prefix has to be flushed before the next window can replace it.
    // Later Thinking sources wait for earlier bodies, while tool titles remain direct.
    const id = this.active.find(id => { const flow = this.flows.get(id)!; return flow.drawn !== flow.text; });
    if (id) {
      const flow = this.flows.get(id)!;
      if (flow.shown === "" || flow.drawn === flow.shown) {
        const pending = unitLength(flow.text.slice(flow.shown.length));
        const rate = Math.max(MIN_TOKENS_PER_SECOND * UNITS_PER_TOKEN, flow.rate + pending * 1000 / CATCHUP_MS);
        flow.credit += rate * Math.max(0, sample.elapsedMs) / 1000;
        const units = unitLength(flow.shown) + Math.floor(flow.credit);
        const prefix = prefixByUnits(flow.text, units, id, this.indexes);
        const shown = prefix.length > flow.limit.length ? flow.limit : prefix;
        if (shown.length > flow.shown.length) {
          flow.credit -= unitLength(shown.slice(flow.shown.length));
          if (prefix.length >= flow.limit.length) flow.credit %= 1;
          flow.shown = shown;
          this.revisionValue++;
        }
      }
    }
    this.arm();
  }

  interrupt(): void {
    this.flows.clear(); this.indexes.clear(); this.active = [];
    this.revisionValue++;
    this.disarm();
  }
  get hasOwnedState(): boolean { return this.flows.size > 0 || this.settled.size > 0; }
  retainSources(ids: readonly string[]): void {
    const current = new Set(ids);
    const owned = [...this.flows.keys(), ...[...this.settled.keys()].map(settleOwner)];
    const removed = owned.filter(id => !current.has(id));
    if (removed.length) this.retireRemoved(removed);
  }
  retireRemoved(ids: readonly string[]): void {
    const removed = new Set(ids);
    for (const id of ids) { this.flows.delete(id); this.indexes.delete(id); }
    for (const id of this.settled.keys()) if (removed.has(settleOwner(id))) this.settled.delete(id);
    this.active = this.active.filter(id => !ids.includes(id));
    this.revisionValue++;
    this.arm();
  }
  reset(): void {
    this.flows.clear(); this.indexes.clear(); this.settled.clear(); this.active = [];
    this.revisionValue++;
    this.disarm();
  }
  dispose(): void { this.reset(); releaseGate(this.ref); finalizer.unregister(this.ref); }

  private arm(): void {
    const id = this.active.find(id => { const flow = this.flows.get(id)!; return flow.drawn !== flow.text; });
    const flow = id && this.flows.get(id);
    if (flow && (flow.shown === "" || flow.drawn === flow.shown)) {
      activeGates.add(this.ref); armMotion(this.token);
    } else this.disarm();
  }
  private disarm(): void { activeGates.delete(this.ref); clearMotion(this.token); }
}

export function resetPaintQueue(): void {
  for (const ref of gates.keys()) ref.deref()?.reset();
}
