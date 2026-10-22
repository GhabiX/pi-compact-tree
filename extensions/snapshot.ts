import assert from "node:assert/strict";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { addressableBlockTail, allowsFrozenBlockChange, frozenBlockConstraint, preservesFrozenBlocks } from "./anchor.ts";

/*
 * Time keeps a Baroque pulse: one metronome for every motion and rest.
 * - Tempo ♩ = 100: a beat is 600ms, near the tempo people keep unprompted
 *   (Fraisse's spontaneous motor tempo); a row is a sixteenth note, TICK_MS.
 * - A motion of n rows is n even sixteenths, a row on each tick, as in Bach's
 *   running sixteenths; past a bar (16 ticks) the passage is fitted into one bar.
 * - Every motion starts on a tick, and an item rests to the next beat before
 *   the next item enters: all items keep the same grid.
 * - Height moves evenly between ticks. A row arriving sweeps in from the left
 *   over its sixteenth, its leading edge softening in from mid gray; a row
 *   leaving is dim while less than half of it is present.
 */
export const BEAT_MS = 60_000 / 100;
export const TICK_MS = BEAT_MS / 4;
const BAR_TICKS = 16;
export const motionMs = (rows: number): number => Math.min(Math.max(1, rows), BAR_TICKS) * TICK_MS;
/** The first beat after `at`: where the next item enters. */
export const restEnd = (at: number): number => (Math.floor(at / BEAT_MS) + 1) * BEAT_MS;
/** SGR 2 dims on any background; the row's own styling gives way while it is half present. */
const dim = (row: string) => `\x1b[2m${row.replace(/\x1b\[[0-9;]*m/gu, "")}\x1b[22m`;

/**
 * A row `presence` (0..1) of the way in: its own styling up to two bands
 * short of the edge, then mid gray, then faint mid gray at the edge, nothing
 * past it. Mid gray lies between background and text on dark and light themes.
 */
function sweep(row: string, presence: number): string {
  const width = visibleWidth(row), edge = Math.ceil(presence * width), band = Math.max(1, Math.ceil(width / 6));
  if (width === 0) return row;
  const plain = stripTerminalSequences(row), solid = Math.max(0, edge - 2 * band), soft = Math.max(0, edge - band);
  return `${sliceByColumn(row, 0, solid)}\x1b[0m\x1b[38;5;244m${sliceByColumn(plain, solid, soft - solid)}` +
    `\x1b[2m${sliceByColumn(plain, soft, edge - soft)}\x1b[0m`;
}

/** `settled`: the receipt counts only once the block has no motion left. */
export type PaintSpan = { id: string; text: string; from: number; to: number; settled?: true };
export type SnapshotBlock = {
  id: string;
  kind: "structure" | "native";
  rows: readonly string[];
  shape: string;
  /** Host-drawn transcript rows that still enter and leave on the pulse, as process items do. */
  enters?: boolean;
  /** A live playback body is already paced; do not mask it with a height reveal. */
  playback?: boolean;
  /** Whole viewport reservation, including the next Thinking window growth. */
  paintReserve?: number;
  paint?: readonly PaintSpan[];
  /** Semantic component owners, retained across a scope split or mixed prose. */
  sources?: readonly string[];
  /** This block is an immutable host-owned prefix. Its rows are opaque to
   * reconciliation: it is the same block while its rows are the same array. */
  sealed?: true;
};

export type PublishedBlock = SnapshotBlock & {
  phase?: "stable" | "pending" | "transition" | "deferred";
  progress?: number;
  startedAt?: number;
  deadlineAt?: number;
  targetShape?: string;
};

export type DeferredBlock = { id: string; reason: "frozen-block" | "frozen-order" | "host-addressable-tail" };

export type SnapshotPhase = "stable" | "pending" | "transition" | "content" | "committed" | "barrier" | "deferred";

export type SnapshotTarget = {
  kind?: "committed" | "empty" | "fallback";
  blocks: readonly SnapshotBlock[];
  structureKey?: string;
  reason?: string;
};

export type RenderResult = {
  kind: "committed" | "empty" | "fallback";
  blocks?: PublishedBlock[];
  deferred?: DeferredBlock[];
  phase: SnapshotPhase;
  rootRevision: number;
  structureKey: string;
  reason?: string;
  progress?: number;
};


type CommittedState = {
  kind: "committed" | "empty" | "fallback";
  blocks: SnapshotBlock[];
  structureKey: string;
  reason?: string;
};

type OwnerState = {
  committed: CommittedState;
  local: {
    latest: CommittedState;
    visible: SnapshotBlock[];
    staged?: SnapshotBlock[];
    motions: Map<string, LocalMotion>;
    deferred: DeferredBlock[];
    event: SnapshotPhase;
    progress?: number;
  };
  /** False after a geometry change until the next stage: publications stay empty. */
  geometryReady: boolean;
};

type LocalMotion = {
  from: SnapshotBlock;
  target: SnapshotBlock;
  startedAt: number;
  durationMs: number;
  progress: number;
  removing: boolean;
};

function copyBlock<T extends SnapshotBlock>(block: T): T {
  return { ...block, rows: [...block.rows], ...(block.sources && { sources: [...block.sources] }), ...(block.paint && { paint: block.paint.map(span => ({ ...span })) }) };
}

/** Staged blocks are immutable by convention; only public render() copies. */
function checkedBlocks(blocks: readonly SnapshotBlock[]): SnapshotBlock[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    assert.ok(block.id && !ids.has(block.id), `duplicate or empty snapshot block: ${block.id}`);
    ids.add(block.id);
  }
  return [...blocks];
}

function sameShape(left: SnapshotBlock, right: SnapshotBlock): boolean {
  return left.id === right.id && left.kind === right.kind && left.shape === right.shape;
}

function sameBlock(left: SnapshotBlock, right: SnapshotBlock): boolean {
  if (left.sealed || right.sealed) {
    // Sealed rows are immutable publication data: the array is the key, and
    // reading the rows here would defeat the sealed boundary.
    return left.sealed === right.sealed && sameShape(left, right) && left.rows === right.rows;
  }
  return sameShape(left, right) && left.playback === right.playback && left.paintReserve === right.paintReserve && left.enters === right.enters && JSON.stringify(left.paint) === JSON.stringify(right.paint) && sameRows(left.rows, right.rows) && sameRows(left.sources ?? [], right.sources ?? []);
}

function sameBlocks(left: readonly SnapshotBlock[], right: readonly SnapshotBlock[]): boolean {
  return left.length === right.length && left.every((block, index) => sameBlock(block, right[index]));
}

function cloneResult(result: RenderResult): RenderResult {
  return { ...result, blocks: result.blocks?.map(copyBlock), deferred: result.deferred?.map((entry) => ({ ...entry })) };
}

function sameRows(left: readonly string[], right: readonly string[]): boolean {
  return left === right || left.length === right.length && left.every((row, index) => row === right[index]);
}

function sameTarget(left: CommittedState, right: CommittedState): boolean {
  return left.kind === right.kind &&
    left.structureKey === right.structureKey &&
    left.reason === right.reason &&
    sameBlocks(left.blocks, right.blocks);
}

function transitionRows(from: readonly string[], to: readonly string[], progress: number): string[] {
  const amount = Math.max(0, Math.min(1, progress));
  if (amount <= 0) return [...from];
  if (amount >= 1) return [...to];
  // Preserve unchanged surroundings. Only the changed subtree occupies the
  // interpolated height; never concatenate two copies of the whole root.
  let prefix = 0;
  while (prefix < Math.min(from.length, to.length) && from[prefix] === to[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < Math.min(from.length, to.length) - prefix && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]) suffix += 1;
  const before = from.length - prefix - suffix, after = to.length - prefix - suffix;
  // The changed part's height h moves evenly from tick to tick; ceil(h) rows show,
  // and the one being crossed (presence h - floor(h)) is dim while under half present.
  const h = before + (after - before) * amount;
  const shown = Math.ceil(h - 1e-9), presence = h - Math.floor(h), partial = presence > 1e-9;
  let middle: string[];
  if (after < before) {
    // Folding: the final heading stays and the old detail rolls up into it,
    // its first rows leaving first, so none repeats the new heading.
    const end = from.length - suffix, tail = from.slice(end - (shown - after), end);
    if (partial && presence <= 0.5 && tail.length) tail[0] = dim(tail[0]);
    middle = [...to.slice(prefix, to.length - suffix), ...tail];
  } else {
    middle = to.slice(prefix, prefix + shown);
    if (partial && middle.length) middle[middle.length - 1] = sweep(middle.at(-1)!, presence);
  }
  return [...to.slice(0, prefix), ...middle, ...to.slice(to.length - suffix)];
}

function intermediate(motion: LocalMotion, frozenPrefix?: readonly string[]): SnapshotBlock {
  if (motion.progress <= 0) return frozenPrefix?.length
    ? { ...motion.from, rows: [...frozenPrefix, ...motion.from.rows.slice(frozenPrefix.length)] }
    : motion.from;
  if (motion.progress >= 1) return motion.target;
  const { from, target } = motion;
  const rows = transitionRows(from.rows, target.rows, motion.progress);
  // The host may freeze rows drawn after this transaction began. Interpolate
  // the still-addressable suffix, never regenerate those bytes from old from.
  const held = frozenPrefix?.length ? [...frozenPrefix, ...rows.slice(frozenPrefix.length)] : rows;
  return { ...from, rows: held, ...((from.sources || target.sources) && {
    sources: [...new Set([...(from.sources ?? [from.id]), ...(target.sources ?? [target.id])])],
  }) };
}

function targetState(target: SnapshotTarget): CommittedState {
  const blocks = checkedBlocks(target.blocks);
  const kind = target.kind ?? (blocks.some((block) => block.rows.length) ? "committed" : "empty");
  if (kind === "fallback") assert.ok(typeof target.reason === "string", "fallback requires a reason");
  return { kind, blocks, structureKey: target.structureKey ?? kind, reason: target.reason };
}

const heightOf = (blocks: readonly SnapshotBlock[]): number => blocks.reduce((height, block) => height + block.rows.length, 0);

/** The host rows of a frame: the one copy of its blocks, with `gap` rows
 * spliced in before block `gap.at`. */
export function materialize(blocks: readonly SnapshotBlock[], gap?: { at: number; rows: readonly string[] }): string[] {
  const rows: string[] = [];
  for (let index = 0; index <= blocks.length; index += 1) {
    if (gap?.at === index) for (const row of gap.rows) rows.push(row);
    if (index < blocks.length) for (const row of blocks[index].rows) rows.push(row);
  }
  return rows;
}

/** Publishes the root's blocks: structural motion, frozen-prefix constraints and the host boundary. */
export class FrameCoordinator {
  private rootRevision = 0;
  private viewportTop = 0;
  private owner: OwnerState | undefined;
  private publication: { height: number; owners: RenderResult[] } | undefined;

  register(initial: SnapshotTarget = { blocks: [] }): void {
    assert.ok(!this.owner, "the root is already registered");
    const committed = targetState(initial);
    this.owner = {
      committed,
      local: {
        latest: committed, visible: committed.blocks, motions: new Map(), deferred: [], event: "stable",
      },
      geometryReady: true,
    };
  }

  onGeometryChange(): void {
    const owner = this.requireOwner();
    this.viewportTop = 0;
    owner.local.motions.clear();
    owner.local.deferred = [];
    owner.local.staged = undefined;
    owner.geometryReady = false;
  }

  stage(target: SnapshotTarget, now = 0): "opened" | "rebased" | "unchanged" {
    const owner = this.requireOwner();
    assert.ok(Number.isFinite(now), "snapshot stage uses finite monotonic milliseconds");
    const latest = owner.local.latest;
    const kind = target.kind ?? (target.blocks.some(block => block.rows.length) ? "committed" : "empty");
    // Compare before copying: unchanged history needs no new state or receipt objects.
    if (owner.geometryReady &&
      latest.kind === kind && latest.reason === target.reason && latest.structureKey === (target.structureKey ?? kind) &&
      sameBlocks(latest.blocks, target.blocks)) return "unchanged";
    return this.stageBlocks(owner, targetState(target), now);
  }

  advance(progress: number): RenderResult[] {
    assert.ok(progress >= 0 && progress <= 1, "snapshot progress must be between 0 and 1");
    const owner = this.requireOwner();
    if (owner.local.motions.size) this.advanceBlocks(owner, () => progress);
    return this.publish();
  }

  /** Timers only wake the host; a delayed sample publishes the latest position. */
  advanceTo(now: number): RenderResult[] | undefined {
    const owner = this.requireOwner();
    const changed = owner.local.motions.size > 0 && this.advanceBlocks(owner, (motion) =>
      Math.max(motion.progress, Math.min(1, (now - motion.startedAt) / motion.durationMs)));
    return changed ? this.publish() : undefined;
  }

  commit(): RenderResult[] {
    return this.advance(1);
  }

  cancel(): void {
    const owner = this.owner;
    if (!owner) return;
    owner.local.motions.clear();
    owner.local.deferred = [];
    owner.local.staged = undefined;
    owner.local.latest = { ...owner.committed, blocks: owner.local.visible };
  }

  /** Rename a contiguous run of unmoving published blocks to one block with identical rows. */
  relabel(replaced: readonly string[], block: SnapshotBlock): boolean {
    const local = this.requireOwner().local;
    if (local.staged || !replaced.length) return false;
    const swap = (blocks: readonly SnapshotBlock[]): SnapshotBlock[] | undefined => {
      const start = blocks.findIndex((candidate) => candidate.id === replaced[0]);
      if (start < 0 || replaced.some((rid, offset) => blocks[start + offset]?.id !== rid || local.motions.has(rid))) return undefined;
      if (!sameRows(blocks.slice(start, start + replaced.length).flatMap((candidate) => candidate.rows), block.rows)) return undefined;
      return [...blocks.slice(0, start), block, ...blocks.slice(start + replaced.length)];
    };
    const visible = swap(local.visible);
    if (!visible) return false;
    local.visible = visible;
    local.deferred = local.deferred.filter((entry) => !replaced.includes(entry.id));
    const latest = swap(local.latest.blocks);
    if (latest) local.latest = { ...local.latest, blocks: latest };
    this.publish();
    return true;
  }

  /** Sample before mutation. This is a compatible publication, not a drawn-frame acknowledgement. */
  observeBoundary(viewportTop: number): RenderResult[] | undefined {
    assert.ok(Number.isInteger(viewportTop) && viewportTop >= 0, "viewport boundary must be a nonnegative row");
    if (viewportTop <= this.viewportTop) return undefined;
    assert.ok(this.publication, "publish an initial frame before observing its boundary");
    assert.ok(viewportTop <= this.publication.height, "viewport boundary is outside the publication");
    this.viewportTop = viewportTop;
    const owner = this.requireOwner();
    const before = owner.local.deferred;
    const hadMotion = owner.local.motions.size;
    this.reconcileBlocks(owner, 0);
    const changed = hadMotion !== owner.local.motions.size || !sameBlocks(owner.local.visible, owner.local.staged!) ||
      before.length !== owner.local.deferred.length || before.some((entry, index) =>
        entry.id !== owner.local.deferred[index]?.id || entry.reason !== owner.local.deferred[index]?.reason);
    if (changed) return this.publish();
    // An unchanged reconciliation leaves nothing staged for publication.
    owner.local.staged = undefined;
    return undefined;
  }

  /** Migrations may carry a host boundary from a longer publication. */
  observeAvailableBoundary(viewportTop: number): RenderResult[] | undefined {
    assert.ok(Number.isInteger(viewportTop) && viewportTop >= 0, "viewport boundary must be a nonnegative row");
    assert.ok(this.publication, "publish an initial frame before observing its boundary");
    return this.observeBoundary(Math.min(viewportTop, this.publication.height));
  }

  publish(): RenderResult[] {
    const owner = this.requireOwner();
    this.rootRevision += 1;
    const current = owner.committed;
    const result: RenderResult = owner.geometryReady ? this.publishBlocks(owner, this.rootRevision) : {
      kind: "empty", phase: "barrier", rootRevision: this.rootRevision,
      structureKey: current.structureKey, reason: current.reason,
    };
    this.publication = { height: heightOf(result.blocks ?? []), owners: [result] };
    return [result];
  }

  /** Shared view for internal layout and receipt readers; immutable by convention.
   * render() returns independently mutable public snapshots. */
  readBlocks(): readonly PublishedBlock[] {
    assert.ok(this.publication, "snapshot coordinator has no publication");
    return this.publication.owners[0].blocks ?? [];
  }

  /** Some target is held back: frozen in scrollback, or kept as Pi's addressable tail. */
  get hasDeferred(): boolean {
    return (this.publication?.owners[0].deferred?.length ?? 0) > 0;
  }

  /** Blocks whose target cannot be published: their drawn rows are frozen in scrollback. */
  readFrozen(): readonly string[] {
    assert.ok(this.publication, "snapshot coordinator has no publication");
    return (this.publication.owners[0].deferred ?? []).filter((entry) => entry.reason === "frozen-block").map((entry) => entry.id);
  }

  render(): { rootRevision: number; rows: string[]; owners: RenderResult[] } {
    assert.ok(this.publication, "snapshot coordinator has no publication");
    return {
      rootRevision: this.rootRevision,
      rows: materialize(this.readBlocks()),
      owners: this.publication.owners.map(cloneResult),
    };
  }

  get currentRootRevision(): number {
    return this.rootRevision;
  }

  get hasPending(): boolean {
    return (this.owner?.local.motions.size ?? 0) > 0;
  }

  dispose(): void {
    this.cancel();
  }

  private requireOwner(): OwnerState {
    assert.ok(this.owner, "register the root before using the coordinator");
    return this.owner;
  }

  private stageBlocks(owner: OwnerState, target: CommittedState, now: number): "opened" | "rebased" | "unchanged" {
    assert.ok(Number.isFinite(now), "snapshot stage uses finite monotonic milliseconds");
    if (owner.geometryReady && sameTarget(owner.local.latest, target)) return "unchanged";
    const rebased = owner.local.motions.size > 0;
    if (!owner.geometryReady) {
      owner.local = { latest: target, visible: target.blocks, staged: target.blocks, motions: new Map(), deferred: [], event: "committed" };
    } else {
      owner.local.latest = target;
      this.reconcileBlocks(owner, now);
    }
    owner.geometryReady = true;
    return rebased ? "rebased" : "opened";
  }

  private reconcileBlocks(owner: OwnerState, now: number): void {
    const local = owner.local;
    const current = local.visible;
    const latest = local.latest.blocks;
    const currentById = new Map(current.map((block) => [block.id, block]));
    const desiredById = new Map(latest.map((block) => [block.id, block]));
    const boundary = this.viewportTop;
    const frozenRows = new Map<string, number>();
    let start = 0;
    for (const block of current) {
      frozenRows.set(block.id, Math.max(0, boundary - start));
      start += block.rows.length;
    }
    const { pinned, topologyCompatible, order } = frozenBlockConstraint(current, latest, boundary);
    local.deferred = topologyCompatible ? [] : [{ id: "root", reason: "frozen-order" }];
    {
      // Removed structures retain their stable successor position until their
      // own transition ends. Inserting a neighbor never renames old blocks.
      const ordered = new Set(order);
      let successor: string | undefined;
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const old = current[index];
        if (ordered.has(old.id)) { successor = old.id; continue; }
        if (old.kind !== "structure" || pinned.has(old.id)) continue;
        order.splice(successor === undefined ? order.length : order.indexOf(successor), 0, old.id);
        ordered.add(old.id);
        successor = old.id;
      }
    }
    // If a frozen aggregate cannot accept its target, requests represented
    // only by that target must remain visible until the merge can be applied.
    const retained = new Set<string>();
    const unmergedSources = new Set<string>();
    for (const id of pinned) {
      const old = currentById.get(id)!;
      const target = desiredById.get(id);
      const targetSources = topologyCompatible || !target ? undefined : new Set(target.sources ?? [id]);
      const keepsSources = !targetSources || (old.sources ?? [id]).every((source) => targetSources.has(source));
      if (!target || !keepsSources || !allowsFrozenBlockChange(old.rows, target.rows, frozenRows.get(id)!)) {
        retained.add(id);
        for (const source of target?.sources ?? []) unmergedSources.add(source);
      }
    }
    const next: SnapshotBlock[] = [];
    const entering: { motion: LocalMotion; rows: number }[] = [];
    for (const id of order) {
      const old = currentById.get(id);
      const desired = desiredById.get(id);
      const removing = !desired && !pinned.has(id);
      const target = desired ?? (removing ? { ...old!, rows: [], shape: `removed:${old!.shape}` } : old!);
      const motion = local.motions.get(id);
      if (retained.has(id) || (removing && old!.sources?.some((source) => unmergedSources.has(source)))) {
        local.motions.delete(id);
        if (!desired || !sameBlock(old!, target)) local.deferred.push({ id, reason: "frozen-block" });
        next.push(old!);
        continue;
      }
      // New content of the same height keeps its motion; a new height starts a
      // fresh path from the height shown now, so position never jumps.
      if (!target.playback && motion && sameShape(motion.target, target) && motion.target.rows.length === target.rows.length) {
        motion.target = target;
        motion.removing = removing;
        const frozenPrefix = pinned.has(id) ? old!.rows.slice(0, frozenRows.get(id)) : undefined;
        next.push(intermediate(motion, frozenPrefix));
        continue;
      }
      local.motions.delete(id);
      const from = old ?? { ...target, rows: [], shape: `inserted:${target.shape}` };
      const structural = from.kind === "structure" || target.kind === "structure" || !!target.enters;
      // Every height change moves in sixteenths on the shared grid (motionMs); a removed block leaves at once.
      if (!target.playback && structural && !removing && from.rows.length !== target.rows.length) {
        const rows = Math.abs(target.rows.length - from.rows.length);
        const motion = { from, target, removing, startedAt: Math.ceil(now / TICK_MS) * TICK_MS, progress: 0, durationMs: motionMs(rows) };
        if (from.rows.length === 0) entering.push({ motion, rows });
        local.motions.set(id, motion);
        next.push(from);
      } else if (!removing) next.push(target);
    }
    // Blocks that enter together are one passage, a sixteenth per row in document order,
    // each starting where the one above ends, after any other motion under way; past a bar
    // the whole passage is fitted into one bar. One edge moves at a time.
    const rows = entering.reduce((sum, start) => sum + start.rows, 0);
    const rowMs = motionMs(rows) / Math.max(1, rows);
    let at = Math.max(Math.ceil(now / TICK_MS) * TICK_MS, ...[...local.motions.values()]
      .filter(motion => !entering.some(start => start.motion === motion)).map(motion => motion.startedAt + motion.durationMs));
    for (const { motion, rows } of entering) {
      motion.startedAt = at;
      motion.durationMs = Math.max(1, rows) * rowMs;
      at += motion.durationMs;
    }
    const ordered = new Set(order);
    for (const id of local.motions.keys()) if (!ordered.has(id)) local.motions.delete(id);
    local.staged = next;
    local.event = "content";
    local.progress = undefined;
  }

  private advanceBlocks(owner: OwnerState, progressAt: (motion: LocalMotion) => number): boolean {
    const local = owner.local;
    let changed = false;
    const next: SnapshotBlock[] = [];
    let start = 0;
    const boundary = this.viewportTop;
    // A stage can be followed directly by commit without an intervening publish.
    for (const block of local.staged ?? local.visible) {
      const frozenRows = Math.max(0, boundary - start);
      start += block.rows.length;
      const motion = local.motions.get(block.id);
      if (!motion) { next.push(block); continue; }
      const progress = progressAt(motion);
      changed = changed || progress !== motion.progress;
      motion.progress = progress;
      local.progress = progress;
      const visible = intermediate(motion, frozenRows > 0 ? block.rows.slice(0, frozenRows) : undefined);
      if (progress >= 1) {
        local.motions.delete(block.id);
        if (motion.removing) continue;
      }
      next.push(visible);
    }
    if (changed) {
      local.staged = next;
      local.event = "committed";
    }
    return changed;
  }

  private publishBlocks(owner: OwnerState, rootRevision: number): RenderResult {
    const local = owner.local;
    const boundary = this.viewportTop;
    const candidate = local.staged ?? local.visible;
    const tail = addressableBlockTail(local.visible, candidate, boundary);
    if (tail.retained) {
      local.motions.delete(tail.retained);
      local.deferred = local.deferred.filter((entry) => entry.id !== tail.retained);
      local.deferred.push({ id: tail.retained, reason: "host-addressable-tail" });
    }
    const blocks = tail.blocks as SnapshotBlock[];
    assert.ok(preservesFrozenBlocks(owner.committed.blocks, blocks, boundary), "publication changed the frozen prefix");
    const prior = owner.committed;
    const moving = [...local.motions.values()];
    const phase = moving.length ? moving.some((motion) => motion.progress > 0) ? "transition" : "pending" :
      local.deferred.length ? "deferred" : local.event;
    owner.committed = {
      ...local.latest, blocks,
      structureKey: moving.length || local.deferred.length ? prior.structureKey : local.latest.structureKey,
    };
    local.visible = blocks;
    local.staged = undefined;
    const frozen = new Set(local.deferred.map((entry) => entry.id));
    const result: RenderResult = {
      kind: heightOf(blocks) && local.latest.kind === "empty" ? "committed" : local.latest.kind,
      phase, rootRevision,
      structureKey: owner.committed.structureKey, reason: local.latest.reason,
      progress: moving.length ? Math.min(...moving.map((motion) => motion.progress)) : local.progress,
      deferred: local.deferred.map((entry) => ({ ...entry })),
      blocks: blocks.map((block) => {
        const motion = local.motions.get(block.id);
        return { ...block, phase: motion ? motion.progress > 0 ? "transition" : "pending" : frozen.has(block.id) ? "deferred" : "stable",
          progress: motion?.progress, startedAt: motion?.startedAt,
          deadlineAt: motion && motion.startedAt + motion.durationMs,
          targetShape: motion?.target.shape ?? block.shape };
      }),
    };
    local.event = "stable";
    local.progress = undefined;
    return result;
  }
}
