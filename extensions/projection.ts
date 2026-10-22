import { type Component } from "@earendil-works/pi-tui";
import { type TreeCard, type TreeTheme, BODY_ROWS, isRunTool, isVisibleNativeRows, pacedRows, proseFlowLimit, renderRun,
  renderThinking, renderTool, rowText, thinkingFlowLimit } from "./format.ts";
import { type DuckTool, toTreeCard } from "./group.ts";
import { createOutputAssembler } from "./output-assembly.ts";
import { armMotion, clearMotion, hasMotionScheduler, motionNow } from "./motion.ts";
import { breath } from "./colors.ts";
import { PaintGate, settleId, sourceId, type Admission, type FlowSource } from "./queue.ts";
import { restEnd, type PaintSpan, type RenderResult, type SnapshotBlock } from "./snapshot.ts";
import { observeNativeSource } from "./native-source.ts";

export type ProjectionItem = DuckTool | "spacer" | "hidden" | undefined;

type ProjectionKind = "process" | "spacer" | "hidden" | "native";

type Entry<T extends Component> = {
  component: T;
  projection: ProjectionItem;
  kind: ProjectionKind;
  card?: TreeCard;
  native?: { rows: readonly string[]; blocks: readonly SnapshotBlock[]; input: readonly unknown[] };
  companions?: Entry<T>[];
  dirty: boolean;
};

type HookState<T extends Component> = {
  cache: ProjectionCache<T>;
  component: T;
  methods: Map<string, { descriptor?: PropertyDescriptor; original: unknown; wrapper: unknown }>;
};

export type ProjectionOptions<T extends Component> = {
  classify: (component: T) => ProjectionItem;
  /** A live assistant message's prose, paced at its arrival rate like Thinking; `ended` once its stream ends. */
  prose?: (component: T) => { ended: boolean } | undefined;
  /** No agent run is under way, so nothing more can join the newest run of calls; true when omitted. */
  agentSettled?: boolean;
  renderNative: (component: T, width: number) => string[];
  /** `reason` is "native-boundary" when the children hold no process; any other reason means projection failed. */
  renderFallback?: (children: readonly T[], width: number, reason: string) => readonly SnapshotBlock[];
  layoutId?: string;
  confirmPaint?: boolean;
  nativeBlocks?: (component: T, rows: readonly string[]) => readonly SnapshotBlock[];
  /** Sources already retained as native host history; admission remains unchanged. */
  excludedComponents?: ReadonlySet<Component>;
  theme?: TreeTheme | false;
  expanded: boolean;
  styleEpoch: number;
};

const HOOK_STATE_KEY = Symbol.for("pi-compact-ui2tree/projection-hook-v1");
const HOOK_METHODS = [
  "updateArgs",
  "updateResult",
  "updateContent",
  "appendOutput",
  "setComplete",
  "setArgsComplete",
  "markExecutionStarted",
  "setText",
] as const;

const hookState = (component: Component): HookState<Component> | undefined => {
  return (component as unknown as Record<PropertyKey, unknown>)[HOOK_STATE_KEY] as HookState<Component> | undefined;
};

function kindOf(item: ProjectionItem): ProjectionKind {
  if (item === "spacer") return "spacer";
  if (item === "hidden") return "hidden";
  if (item && typeof item === "object") return "process";
  return "native";
}

function sameChildren<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function hasHookMethod(component: Component): boolean {
  const target = component as unknown as Record<PropertyKey, unknown>;
  return HOOK_METHODS.some((name) => typeof target[name] === "function");
}

type Source<T extends Component> = { entry: Entry<T>; card: TreeCard; id: string; live: boolean; ended: boolean };
type Prose = { id: string; text: string; ended: boolean };
// An item is one Thinking, one change (edit, write), one diagnostic, or a run of other calls
// with nothing visible between them, across messages too.
type Part<T extends Component> = { source: Source<T> } | { run: Source<T>[] } | { native: Entry<T>; prose?: Prose };
/** What one part shows this frame, as the schedule decided it; drawing it is the only work left. */
type Step<T extends Component> =
  | { native: Entry<T>; form: "final"; prose: Prose; done: boolean }
  | { native: Entry<T>; form: "pacing"; prose: Prose; shown: string }
  | { native: Entry<T>; form: "enters" | "plain" }
  | { source: Source<T>; final: true; done: boolean }
  | { source: Source<T>; final: false; window: boolean; done: boolean; active: boolean; flowText: string }
  | { run: Source<T>[]; final: true; done: boolean }
  | { run: Source<T>[]; final: false; shown: number; current: boolean; receipt?: { member: Source<T>; phase?: "out" }; active: boolean };
type Drawing<T extends Component> = {
  presentation: ProjectionOptions<T>;
  localId: (id: string) => string;
  options: { width: number; theme: TreeTheme | false | undefined; expanded: boolean; pulse: ReturnType<typeof breath> };
  shared: unknown[];
  assembler: ReturnType<typeof createOutputAssembler>;
  /** Items drawn this frame; the derived blocks of the others are dropped. */
  drawn: Set<string>;
};

export class ProjectionCache<T extends Component> {
  private readonly identifySource?: (component: object) => string;

  constructor(identifySource?: (component: object) => string) {
    this.identifySource = identifySource;
  }

  private childrenRef: readonly T[] | undefined;
  private childrenSnapshot: T[] = [];
  private entries: Entry<T>[] = [];
  private byComponent = new WeakMap<object, Entry<T>>();
  private hooks = new Set<HookState<T>>();
  private presentation: {
    width: number;
    expanded: boolean;
    theme?: TreeTheme | false;
    styleEpoch: number;
  } | undefined;
  private needsHydrate = true;
  private disabled = false;
  private disposed = false;
  private gate = new PaintGate();
  private paintPrefix = "";
  /** Children before the seal are frozen host output; they are never projected again. */
  private sealed: { components: readonly T[]; block: SnapshotBlock; afterProcess: boolean; width: number; expanded: boolean } | undefined;
  /** Start row and spacing state of each pure native boundary in the last assembly. */
  private cuts = new Map<object, { afterProcess: boolean; id: string }>();

  private get offset(): number { return this.sealed?.components.length ?? 0; }

  private sealHolds(children: readonly T[], width: number, expanded: boolean): boolean {
    const sealed = this.sealed!;
    return sealed.width === width && sealed.expanded === expanded && children.length >= sealed.components.length &&
      sealed.components.every((component, index) => children[index] === component);
  }

  unseal(): void {
    if (!this.sealed) return;
    this.sealed = undefined;
    this.invalidate();
  }

  /**
   * Propose sealing before the last pure native boundary whose published
   * block starts in frozen rows. Sealed rows are the published (host) rows,
   * so frozen conflicts are kept exactly as drawn. No published block before
   * the boundary may be moving, and no projected block before it may still
   * play, finish or await a receipt.
   */
  proposeSeal(frozen: number, published: readonly { id: string; rows: readonly string[]; phase?: string }[]):
    { count: number; block: SnapshotBlock; afterProcess: boolean; replaced: string[] } | undefined {
    if (this.disposed || this.disabled || this.prepared?.kind === "fallback" || !this.childrenRef) return undefined;
    const offsets = new Map<string, number>();
    let at = 0;
    for (const block of published) {
      if (at > frozen) break;
      offsets.set(block.id, at);
      at += block.rows.length;
    }
    let count = 0, mark: { afterProcess: boolean; id: string } | undefined;
    for (let index = 0; index < this.entries.length; index++) {
      const cut = this.entries[index].kind === "native" ? this.cuts.get(this.entries[index].component) : undefined;
      if (!cut) continue;
      if (!offsets.has(cut.id)) break;
      count = index; mark = cut;
    }
    if (!mark || count === 0) return undefined;
    for (const block of this.blocks) {
      if (block.id === mark.id) break;
      if (block.playback || block.paint?.length) return undefined;
    }
    const replaced: string[] = [];
    let proposedRows = 0;
    for (const block of published) {
      if (block.id === mark.id) break;
      // Deferred frozen blocks are static host rows; only moving blocks block a seal.
      if (block.phase === "pending" || block.phase === "transition") return undefined;
      replaced.push(block.id);
      proposedRows += block.rows.length;
    }
    const oldRows = this.sealed?.block.rows.length ?? 0;
    if (!replaced.length || proposedRows <= oldRows) return undefined;
    // Do not copy the old sealed prefix while merely checking whether the
    // viewport advanced. Only the newly admitted suffix is assembled when a
    // proposal really grows the seal.
    const rows: string[] = [];
    const oldId = this.sealed?.block.id;
    let pastOld = oldId === undefined;
    const additions: string[] = [];
    for (const block of published) {
      if (block.id === mark.id) break;
      if (block.id === oldId) { pastOld = true; continue; }
      if (pastOld) additions.push(...block.rows);
    }
    if (oldId === undefined) rows.push(...additions);
    else rows.push(...(this.sealed?.block.rows ?? []), ...additions);
    if (!rows.length) return undefined;
    return { count, afterProcess: mark.afterProcess, replaced,
      block: { id: `${this.paintPrefix}sealed`, kind: "native", rows, shape: "sealed", sealed: true } };
  }

  commitSeal(proposal: { count: number; block: SnapshotBlock; afterProcess: boolean }): void {
    const children = this.childrenRef!;
    const offset = this.offset + proposal.count;
    const sealed = new Set<object>(this.entries.slice(0, proposal.count).map((entry) => entry.component));
    for (const component of sealed) this.byComponent.delete(component);
    // Sealed components are final output; their later mutations are not observed.
    // A sealed component becomes cold on re-entry; no full Flow survives the seal.
    this.gate.retireRemoved(this.entries.slice(0, proposal.count).flatMap(entry => this.sourceIds(entry)));
    for (const component of sealed) this.interruptedSources.set(component, "sealed");
    for (const hook of this.hooks) if (sealed.has(hook.component)) { this.restoreHook(hook); this.hooks.delete(hook); }
    this.entries = this.entries.slice(proposal.count);
    this.childrenSnapshot = this.childrenSnapshot.slice(proposal.count);
    this.sealed = { components: children.slice(0, offset), block: proposal.block, afterProcess: proposal.afterProcess,
      width: this.presentation!.width, expanded: this.presentation!.expanded };
    this.semanticRevision += 1;
    this.preparedInput = undefined;
  }
  private interruptedSources = new WeakMap<object, "abandoned" | "sealed">();
  /** The clock runs while a marker breathes or an item rests. */
  private readonly clockKey = {};
  private ticking = false;
  /** The earliest rest that ends after the last prepare: crossing it changes what may enter. */
  private restDeadline = Infinity;

  /** Skip only sources already owned at this explicit user boundary. */
  interrupt(): void {
    for (const entry of this.entries) this.interruptedSources.set(entry.component, "abandoned");
    this.gate.interrupt();
    this.invalidate();
  }

  acknowledge(id: string, text: string): boolean {
    if (!this.paintPrefix || !id.startsWith(this.paintPrefix) || !this.gate.acknowledge(id.slice(this.paintPrefix.length), text)) return false;
    this.preparedInput = undefined;
    return true;
  }

  /** An item frozen in scrollback can no longer move, so it counts as settled: later items need not wait for it. */
  release(blockId: string): boolean {
    let released = false;
    for (const span of this.blocks.find((block) => block.id === blockId)?.paint ?? []) {
      released = this.acknowledge(span.id, span.text) || released;
    }
    return released;
  }

  private blocks: SnapshotBlock[] = [];
  private committedKind: RenderResult["kind"] = "empty";
  private committedReason: string | undefined;
  private structureKey = "projection";
  private prepared: RenderResult | undefined;
  private paintIds = new WeakMap<object, string>();
  private nextPaintId = 0;
  private semanticRevision = 0;
  private preparedInput: readonly unknown[] | undefined;
  private preparedBlocks: SnapshotBlock[] = [];
  private derivedRuns = new Map<string, {
    input: unknown[]; blocks: readonly SnapshotBlock[];
  }>();

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Host preparation observes semantic mutations; reading rows never does. */
  prepare(
    children: readonly T[], width: number, presentation: ProjectionOptions<T>,
  ): RenderResult {
    this.prepared = this.prepareTarget(children, width, presentation);
    // Rows stay immutable inside the coordinator. The root makes the single
    // mutable host copy immediately before Pi applies line resets.
    return this.prepared;
  }

  read(): RenderResult {
    const result = this.prepared ?? this.committedResult();
    return {
      ...result,
      blocks: result.blocks?.map((block) => ({ ...block, rows: [...block.rows], ...(block.sources && { sources: [...block.sources] }), ...(block.paint && { paint: block.paint.map(span => ({ ...span })) }) })),
    };
  }

  /**
   * The first root render can observe a live source before its prepared block
   * carries `playback`.  Keep that source's bottom window addressable during
   * the same render; otherwise a tall native widget can move it past V before
   * the paint metadata appears.
   */
  hasActivePlayback(): boolean {
    return this.entries.some((entry) => {
      if (entry.kind !== "process" || !entry.projection || typeof entry.projection !== "object") return false;
      const projection = entry.projection as DuckTool;
      return projection.playbackSource === true && projection.playbackEnded !== true;
    });
  }

  private prepareTarget(
    children: readonly T[], width: number, presentation: ProjectionOptions<T>,
  ): RenderResult {
    if (this.disposed || this.disabled) return this.fallbackResult(children, width, presentation, "projection-disabled");
    // Ctrl+O can change how sealed items draw. The seal is then projected again, and kept
    // only when its rows come out the same.
    const recheck = this.sealed && !this.sealHolds(children, width, presentation.expanded) &&
      this.sealHolds(children, width, this.sealed.expanded) ? this.sealed : undefined;
    if (this.sealed && !this.sealHolds(children, width, presentation.expanded)) this.unseal();
    const previousPresentation = this.presentation;
    const presentationChanged = !this.samePresentation(width, presentation);
    if (this.needsHydrate) {
      if (!this.hydrate(children, width, presentation)) {
        return this.fallbackResult(children, width, presentation, "projection-unavailable");
      }
    } else if (!this.syncTopology(children, presentation)) {
      // Replacement is a new semantic input, not a deferred render. Hydrate
      // and measure it now; old-width rows must never cross the geometry gate.
      // The same semantic source may move while its live prefix is pending.
      // Session lifecycle owns reset; topology alone never flushes playback.
      if (!this.hydrate(children, width, presentation)) {
        return this.fallbackResult(children, width, presentation, "topology-unavailable");
      }
    }

    if (presentationChanged && previousPresentation) {
      if (previousPresentation.width !== width) this.clearDerived();
      this.presentation = {
        width,
        expanded: presentation.expanded,
        theme: presentation.theme,
        styleEpoch: presentation.styleEpoch,
      };
      for (const entry of this.entries) {
        if (entry.kind === "process") entry.dirty = true;
      }
    }

    for (const entry of this.entries) {
      if (!entry.dirty) continue;
      entry.native = undefined;
      const next = presentation.classify(entry.component);
      const nextKind = kindOf(next);
      if (nextKind !== entry.kind) {
        // A component changing role is a local semantic update. Rehydrating
        // the whole collection would discard its siblings' committed body shape
        // and detail while their fold transactions are still pending.
        entry.kind = nextKind;
        entry.projection = next;
        entry.card = nextKind === "process" ? toTreeCard(next as DuckTool) : undefined;
        entry.companions = undefined;
        entry.dirty = false;
        continue;
      }
      if (nextKind !== "process") {
        entry.projection = next;
        entry.dirty = false;
        continue;
      }
      entry.projection = next;
      entry.card = toTreeCard(next as DuckTool);
      entry.companions = undefined;
      entry.dirty = false;
    }

    // Reconcile semantic owners after hydration too; temporary invalidation alone does not retire them.
    if (this.gate.hasOwnedState) this.gate.retainSources(this.entries.flatMap(entry => this.sourceIds(entry)));
    // A sealed prefix keeps the assembled path even when only native rows follow it.
    // Without a process or live prose, the host's own rows are already the projection.
    if (!this.sealed && !this.entries.some((entry) => entry.kind === "process" || presentation.prose?.(entry.component))) {
      if (this.entries.some((entry) => entry.kind === "native")) {
        return this.fallbackResult(children, width, presentation, "native-boundary");
      }
      this.blocks = [];
      this.committedKind = "empty";
      this.committedReason = undefined;
      this.structureKey = "[]";
      return this.committedResult();
    }
    const blocks = this.prepareBlocks(width, presentation);
    if (blocks === this.blocks && this.prepared?.kind !== "fallback") return this.prepared ?? this.committedResult();
    this.blocks = blocks;
    this.structureKey = JSON.stringify(blocks.map(block => [block.id, block.kind, block.shape]));
    this.committedKind = blocks.length ? "committed" : "empty";
    this.committedReason = undefined;
    if (recheck && this.drawsAsSealed(recheck, children)) {
      this.commitSeal({ count: recheck.components.length, block: recheck.block, afterProcess: recheck.afterProcess });
      return this.prepareTarget(children, width, presentation);
    }
    return this.committedResult();
  }

  /** The blocks before the seal's boundary repeat its rows exactly. */
  private drawsAsSealed(seal: NonNullable<typeof this.sealed>, children: readonly T[]): boolean {
    const cut = this.cuts.get(children[seal.components.length]);
    const end = cut ? this.blocks.findIndex((block) => block.id === cut.id) : -1;
    if (end < 0) return false;
    const rows = this.blocks.slice(0, end).flatMap((block) => block.rows);
    return rows.length === seal.block.rows.length && rows.every((row, index) => row === seal.block.rows[index]);
  }

  private committedResult(phase: RenderResult["phase"] = "stable"): RenderResult {
    return {
      kind: this.committedKind,
      blocks: this.blocks,
      phase,
      rootRevision: 0,
      structureKey: this.structureKey,
      ...(this.committedReason ? { reason: this.committedReason } : {}),
    };
  }

  private fallbackResult(
    children: readonly T[],
    width: number,
    presentation: ProjectionOptions<T>,
    reason: string,
  ): RenderResult {
    const blocks = presentation.renderFallback?.(children, width, reason) ?? [{ id: "native-fallback", kind: "native",
      rows: children.flatMap((component) => presentation.renderNative(component, width)), shape: "native-fallback" }];
    return {
      kind: "fallback",
      blocks: [...blocks],
      phase: "stable",
      rootRevision: 0,
      structureKey: "native-fallback",
      reason,
    };
  }

  invalidate(): void {
    if (this.disposed) return;
    this.disposeHooks();
    this.needsHydrate = true;
    this.semanticRevision += 1;
    this.childrenRef = undefined;
    this.childrenSnapshot = [];
    this.entries = [];
    this.byComponent = new WeakMap();
    this.presentation = undefined;
    this.clearDerived();
  }

  disable(): void {
    this.invalidate();
    this.disabled = true;
  }

  dispose(): void {
    if (this.disposed) return;
    clearMotion(this.clockKey);
    this.disposeHooks();
    this.gate.dispose();
    this.sealed = undefined;
    this.cuts.clear();
    this.entries = [];
    this.childrenSnapshot = [];
    this.childrenRef = undefined;
    this.byComponent = new WeakMap();
    this.clearDerived();
    this.presentation = undefined;
    this.prepared = undefined;
    this.blocks = [];
    this.committedKind = "empty";
    this.committedReason = undefined;
    this.disposed = true;
  }

  private hydrate(children: readonly T[], width: number, presentation: ProjectionOptions<T>): boolean {
    this.disposeHooks();
    this.childrenRef = children;
    this.childrenSnapshot = children.slice(this.offset);
    this.entries = [];
    this.byComponent = new WeakMap();
    const seen = new Set<object>();

    for (const component of this.childrenSnapshot) {
      const projection = presentation.classify(component);
      const kind = kindOf(projection);
      const entry: Entry<T> = { component, projection, kind, dirty: false };
      if (kind === "process") {
        if (seen.has(component as object)) {
          this.disable();
          return false;
        }
        seen.add(component as object);
      }
      if (hasHookMethod(component)) {
        if (!this.installHooks(component)) {
          this.disable();
          return false;
        }
        this.byComponent.set(component as object, entry);
      }
      if (kind === "process" && !entry.card) {
        entry.card = toTreeCard(projection as DuckTool);
      }
      this.entries.push(entry);
    }

    this.presentation = {
      width,
      expanded: presentation.expanded,
      theme: presentation.theme,
      styleEpoch: presentation.styleEpoch,
    };
    this.needsHydrate = false;
    this.semanticRevision += 1;
    return true;
  }

  /** Flow and receipt owners of an entry: its cards, and its prose when the host draws some. */
  private sourceIds(entry: Entry<T>): string[] {
    const prose = `prose:${this.tokenOf(entry.component)}`;
    if (entry.kind === "native") return [prose];
    if (entry.kind !== "process") return [];
    const primary = entry.projection as DuckTool;
    return [...[primary, ...(primary.companions ?? [])].map(card => sourceId(this.tokenOf(entry.component), card.toolName)),
      ...(primary.nativePlacement ? [prose] : [])];
  }

  private syncTopology(children: readonly T[], presentation: ProjectionOptions<T>): boolean {
    const offset = this.offset, old = this.childrenSnapshot;
    const prefixOf = (length: number) => old.every((component, index) => index >= length || children[offset + index] === component);
    if (this.childrenRef === children && children.length - offset === old.length && prefixOf(old.length)) return true;
    const isAppend = this.childrenRef === children && children.length - offset >= old.length && prefixOf(old.length);
    if (!isAppend) {
      const nextComponents = new Set(children as readonly T[]);
      const removedSources: string[] = [];
      for (const entry of this.entries) {
        if (entry.kind !== "process" || nextComponents.has(entry.component)) continue;
        removedSources.push(...this.sourceIds(entry));
      }
      this.gate.retireRemoved(removedSources);
      if (!this.entries.some(entry => entry.kind === "process" && children.includes(entry.component))) this.gate.reset();
      this.invalidate();
      return false;
    }

    const seen = new Set<object>();
    for (const entry of this.entries) {
      if (entry.kind === "process") seen.add(entry.component as object);
    }
    for (const component of children.slice(offset + old.length)) {
      const projection = presentation.classify(component);
      const kind = kindOf(projection);
      const entry: Entry<T> = { component, projection, kind, dirty: false };
      if (kind === "process") {
        if (seen.has(component as object)) {
          this.invalidate();
          return false;
        }
        seen.add(component as object);
      }
      if (hasHookMethod(component)) {
        if (!this.installHooks(component)) {
          this.invalidate();
          return false;
        }
        this.byComponent.set(component as object, entry);
      }
      if (kind === "process" && !entry.card) {
        entry.card = toTreeCard(projection as DuckTool);
      }
      this.entries.push(entry);
    }
    this.childrenRef = children;
    this.childrenSnapshot = children.slice(offset);
    this.semanticRevision += 1;
    return true;
  }

  private samePresentation(width: number, presentation: ProjectionOptions<T>): boolean {
    return this.presentation?.width === width &&
      this.presentation.expanded === presentation.expanded &&
      this.presentation.theme === presentation.theme &&
      this.presentation.styleEpoch === presentation.styleEpoch;
  }

  private clearDerived(): void {
    this.derivedRuns.clear();
    this.preparedInput = undefined;
    this.preparedBlocks = [];
  }

  private tokenOf(component: object): string {
    if (this.identifySource) return this.identifySource(component);
    const existing = this.paintIds.get(component);
    if (existing) return existing;
    const id = String(++this.nextPaintId);
    this.paintIds.set(component, id);
    return id;
  }

  private prepareBlocks(width: number, presentation: ProjectionOptions<T>): SnapshotBlock[] {
    const scheduler = hasMotionScheduler();
    const localId = (id: string) => `${presentation.layoutId ?? ""}/${id}`;
    this.paintPrefix = `${presentation.layoutId ?? ""}/`;
    const nativeChanged = this.observe(width, presentation, localId);
    // Active markers breathe on the shared clock; the clock runs only while one is active.
    const pulse = scheduler ? breath(motionNow()) : breath(0);
    const input: unknown[] = [this.semanticRevision, this.gate.revision, scheduler, this.ticking ? pulse : -1,
      motionNow() >= this.restDeadline, width,
      presentation.expanded, presentation.theme, presentation.styleEpoch, presentation.layoutId,
      presentation.excludedComponents, presentation.confirmPaint, presentation.agentSettled ?? true, this.sealed];
    if (!nativeChanged && this.preparedInput && sameChildren(input, this.preparedInput)) return this.preparedBlocks;
    const { parts, flows } = this.segment(width, presentation, scheduler);
    this.gate.prepare(flows, scheduler);
    let dropped = false;
    const assembler = createOutputAssembler(span => { dropped = this.acknowledge(span.id, span.text) || dropped; });
    if (this.sealed) assembler.sealed(this.sealed.block, this.sealed.afterProcess);
    this.cuts = new Map();
    const drawing: Drawing<T> = { presentation, localId, assembler, drawn: new Set(),
      options: { width, theme: presentation.theme, expanded: presentation.expanded, pulse },
      shared: [width, presentation.theme, presentation.styleEpoch, presentation.expanded] };
    // Each step is drawn and placed before the schedule decides the next one: placing a step
    // can settle a receipt the assembler drops, and the schedule reads that.
    const schedule = this.schedule(parts, presentation, scheduler);
    let next = schedule.next();
    for (; !next.done; next = schedule.next()) this.place(next.value, drawing);
    const { ticking, restDeadline, held } = next.value;
    if (held) this.cut(held, assembler);
    this.ticking = ticking && scheduler;
    this.restDeadline = restDeadline;
    if (this.ticking) armMotion(this.clockKey); else clearMotion(this.clockKey);
    const blocks = assembler.finish();
    for (const id of this.derivedRuns.keys()) if (!drawing.drawn.has(id)) this.derivedRuns.delete(id);
    if (!dropped) {
      input[1] = this.gate.revision;
      this.preparedInput = input;
      this.preparedBlocks = blocks;
    }
    return blocks;
  }

  /** Observes each native entry's blocks this frame; true when any of them changed. */
  private observe(width: number, presentation: ProjectionOptions<T>, localId: (id: string) => string): boolean {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.kind !== "native" && !(entry.kind === "process" && (entry.projection as DuckTool).nativePlacement)) continue;
      const observed = observeNativeSource(entry.component, width, presentation.renderNative,
        presentation.nativeBlocks, this.tokenOf(entry.component), localId, entry.kind === "process");
      if (!entry.native || !sameChildren(entry.native.input, observed.input)) {
        entry.native = observed;
        changed = true;
      }
    }
    return changed;
  }

  /** Groups the entries into parts in source order, and lists the flows (Thinking, live prose) the gate paces. */
  private segment(width: number, presentation: ProjectionOptions<T>, scheduler: boolean): { parts: Part<T>[]; flows: FlowSource[] } {
    const parts: Part<T>[] = [];
    const flows: FlowSource[] = [];
    let run: Source<T>[] | undefined;
    const addNative = (entry: Entry<T>) => {
      if (entry.kind === "process" && presentation.excludedComponents?.has(entry.component)) return;
      if (isVisibleNativeRows(entry.native!.rows)) run = undefined;
      const live = presentation.prose?.(entry.component);
      if (!live || !scheduler || !presentation.confirmPaint || this.interruptedSources.has(entry.component)) {
        parts.push({ native: entry });
        return;
      }
      const id = `prose:${this.tokenOf(entry.component)}`;
      const text = entry.native!.rows.map(rowText).join("\n");
      flows.push({ id, text, live: this.gate.admission(id) !== "final", ended: live.ended, limit: proseFlowLimit(text, this.gate.flowText(id)) });
      parts.push({ native: entry, prose: { id, text, ended: live.ended } });
    };
    const addCard = (entry: Entry<T>) => {
      const card = entry.card;
      if (!card) return;
      const duck = entry.projection as DuckTool;
      const id = sourceId(this.tokenOf(entry.component), card.toolName);
      const live = !this.interruptedSources.has(entry.component) && !!presentation.confirmPaint &&
        (duck.playbackSource === true || card.toolName === "thinking" && duck.playbackSource !== false);
      const source: Source<T> = { entry, card, id, live,
        ended: card.status !== "running" && (card.toolName !== "thinking" || duck.playbackEnded !== false) };
      if (presentation.excludedComponents?.has(entry.component)) return;
      if (!isRunTool(card)) {
        run = undefined;
        parts.push({ source });
      } else if (run) run.push(source);
      else parts.push({ run: run = [source] });
      if (card.toolName === "thinking") {
        // The layout-aware grant is needed only while the flow still has text to show.
        const text = card.detail ?? "", shown = this.gate.flowText(id);
        flows.push({ id, text, live: live && this.gate.admission(id) !== "final", ended: source.ended, interrupted: this.interruptedSources.has(entry.component),
          limit: live && shown !== text ? thinkingFlowLimit(text, shown, width) : text });
      }
    };
    for (const entry of this.entries) {
      if (entry.kind === "hidden" || entry.kind === "spacer") continue;
      if (entry.kind === "native") { addNative(entry); continue; }
      const duck = entry.projection as DuckTool;
      if (duck.nativePlacement === "before") addNative(entry);
      addCard(entry);
      entry.companions ??= (duck.companions ?? []).flatMap(duck => {
        const card = toTreeCard(duck);
        return card ? [{ component: entry.component, projection: duck, kind: "process" as const, card, dirty: false }] : [];
      });
      for (const companion of entry.companions) addCard(companion);
      if (duck.nativePlacement === "after") addNative(entry);
    }
    return { parts, flows };
  }

  /**
   * Decides what each part shows this frame and yields it as a step, recording admissions in the gate.
   * Items enter in source order, one at a time: everything after a live item waits until that item has
   * settled on screen (a Thinking played and folded, a call grown in, a finished run folded). Only the
   * newest item ever moves. Returns whether the clock must keep ticking, and the native part it stopped
   * before, if any.
   */
  private *schedule(parts: readonly Part<T>[], presentation: ProjectionOptions<T>, scheduler: boolean):
    Generator<Step<T>, { ticking: boolean; restDeadline: number; held?: Entry<T> }> {
    // A finished item rests, fully shown, to the next beat before it
    // folds or the next call replaces it; the clock keeps ticking meanwhile.
    const now = motionNow();
    let restDeadline = Infinity;
    const resting = (at: number | undefined) => {
      if (at === undefined || now >= restEnd(at)) return false;
      restDeadline = Math.min(restDeadline, restEnd(at));
      return true;
    };
    const playing = (source: Source<T>) => source.live && scheduler &&
      (!source.ended || !this.gate.flowComplete(source.id, source.card.detail ?? "") || resting(this.gate.flowDoneAt(source.id)));
    const settled = (source: Source<T>, phase?: string) => !source.live || !scheduler || this.gate.isSettled(source.id, phase);
    // followedAt[i]: something visible comes after part i (one pass, not a scan per part).
    const followedAt = parts.map(() => false);
    for (let at = parts.length - 2, seen = false; at >= 0; at--) {
      const next = parts[at + 1];
      seen ||= !("native" in next) || isVisibleNativeRows(next.native.native!.rows);
      followedAt[at] = seen;
    }
    const followed = (index: number) => followedAt[index];
    // A live item that has not started while a newer one already waits enters in its final
    // form (Thinking its title, a change its result, a run its summary, prose all its rows),
    // together with the others like it as one passage. One that started plays through.
    const admit = (id: string, live: boolean, ended: boolean, index: number): Admission | undefined =>
      live && scheduler ? this.gate.admit(id, ended && followed(index) ? "final" : "play") : undefined;
    // What follows a passage waits until its last item is drawn, then rests to the next beat.
    let passagePending = false, passageAt: number | undefined;
    const passage = (source: { id: string }) => {
      if (!this.gate.isSettled(source.id)) passagePending = true;
      else passageAt = Math.max(passageAt ?? 0, this.gate.settledAt(source.id)!);
    };
    const afterPassage = () => {
      if (!passagePending && !resting(passageAt)) return true;
      ticking = true;
      return false;
    };
    let ticking = false, followsLive = false;
    for (const [index, part] of parts.entries()) {
      if ("native" in part) {
        const { prose } = part;
        const final = prose && admit(prose.id, true, prose.ended, index) === "final";
        if (!final && !afterPassage()) return { ticking, restDeadline, held: part.native };
        if (final && prose) {
          const done = this.gate.isSettled(prose.id);
          // Prose with no rows has nothing to draw: it is settled as it stands.
          if (part.native.native!.blocks.some(block => block.rows.length > 0)) passage(prose);
          followsLive = true;
          yield { native: part.native, form: "final", prose, done };
          continue;
        }
        // Live prose plays until its source ended and the whole text was drawn; then it is plain native rows.
        if (prose && !(prose.ended && this.gate.flowComplete(prose.id, prose.text))) {
          yield { native: part.native, form: "pacing", prose, shown: this.gate.flowText(prose.id) };
          if (!this.gate.flowComplete(prose.id, prose.text)) { ticking = true; break; }
          if (!prose.ended) break;
          continue;
        }
        yield { native: part.native, form: !prose && followsLive ? "enters" : "plain" };
        continue;
      }
      if ("run" in part) {
        const members = part.run;
        // Each call of a run grows in under the summary, keeps its preview to the
        // next beat, then rolls up into the summary before the next call grows in
        // (or the newest of the calls that arrived meanwhile).
        // The last call rolls up once every call has finished and something
        // visible follows: that is the run folding. Then it rests, and the next
        // item enters.
        // Nothing more can join the run once something visible follows it or no source of it is
        // still running: the agent settled, or the run is history.
        const ended = members.every(member => member.ended);
        const finished = ended && (followed(index) || (presentation.agentSettled ?? true) || !members.some(member => member.live));
        // The run is one item: final when none of its calls has entered yet and it ended with
        // something after it; then every call is recorded final, so the choice stays made.
        const decided = members.map(member => this.gate.admission(member.id));
        const final = scheduler && members.some(member => member.live) && (decided.every(how => how === "final") ||
          decided.every(how => how === undefined) && ended && followed(index));
        if (final) {
          for (const member of members) this.gate.admit(member.id, "final");
          followsLive = true;
          yield { run: members, final: true, done: settled(members[0]) };
          passage(members[0]);
          continue;
        }
        if (!afterPassage()) break;
        let shown = members.length, current = false, waiting = false;
        let receipt: { member: Source<T>; phase?: "out" } | undefined;
        for (const [at, member] of members.entries()) {
          const open = (wait: boolean) => { shown = at + 1; current = true; waiting = wait; };
          if (!settled(member)) {
            // A call that has not started while a newer one already waits goes straight into
            // the summary: under a burst only the newest call plays, so the screen keeps up
            // with the agent. A call that started plays through.
            if (at < members.length - 1 && this.gate.admit(member.id, "final") === "final") continue;
            this.gate.admit(member.id, "play");
            open(true); receipt = { member }; break;
          }
          if (at === members.length - 1 && !finished) { open(false); break; }
          if (resting(this.gate.settledAt(member.id))) { open(true); break; }
          if (!settled(member, "out")) { shown = at + 1; waiting = true; receipt = { member, phase: "out" }; break; }
        }
        const folded = !waiting && !current;
        const rest = folded && resting(this.gate.settledAt(members.at(-1)!.id, "out"));
        const active = members.slice(0, shown).some(member => member.card.status === "running");
        ticking ||= active || waiting || rest;
        followsLive ||= members.some(member => member.live);
        yield { run: members, final: false, shown, current, receipt, active };
        if (!folded || rest) break;
        continue;
      }
      const { source } = part;
      if (admit(source.id, source.live, source.ended, index) === "final") {
        followsLive = true;
        yield { source, final: true, done: settled(source) };
        passage(source);
        continue;
      }
      if (!afterPassage()) break;
      followsLive ||= source.live;
      const isThinking = source.card.toolName === "thinking";
      const window = isThinking && playing(source);
      const done = settled(source);
      const active = window || source.card.status === "running";
      ticking ||= active;
      const flowText = isThinking && source.live && scheduler ? this.gate.flowText(source.id) : isThinking ? source.card.detail ?? "" : "";
      yield { source, final: false, window, done, active, flowText };
      if (!done) { ticking = true; break; }
      // Every settled item rests to the next beat before the next one enters.
      if (resting(this.gate.settledAt(source.id))) { ticking = true; break; }
    }
    return { ticking, restDeadline };
  }

  /** Draws one step and places it in the frame. */
  private place(step: Step<T>, drawing: Drawing<T>): void {
    const { presentation, localId, options, shared, assembler } = drawing;
    const settle = (rows: readonly string[], source: Source<T>, phase?: string): PaintSpan[] =>
      [{ id: localId(settleId(source.id, phase)), text: "settled", from: rows.length - 1, to: rows.length, settled: true }];
    if ("native" in step) {
      const entry = step.native;
      this.cut(entry, assembler);
      let blocks = entry.native!.blocks;
      if (step.form === "final") {
        const last = blocks.findLastIndex(block => block.rows.length > 0);
        blocks = blocks.map((block, at) => ({ ...block, enters: true, ...(at === last && !step.done ? { paint: [{ id: localId(settleId(step.prose.id)),
          text: "settled", from: block.rows.length - 1, to: block.rows.length, settled: true as const }] } : {}) }));
      } else if (step.form === "pacing") {
        // Its shown prefix plays; its receipt sits on the last block it reaches.
        let rest = step.shown;
        const paced = blocks.map(block => {
          const rows = pacedRows(block.rows, rest);
          rest = rest.slice(Math.min(rest.length, block.rows.map(rowText).join("\n").length + 1));
          return { ...block, rows };
        });
        const edge = paced.findLastIndex(block => block.rows.length > 0);
        // Only the front row needs a receipt: the rows above it were confirmed by earlier grants,
        // and they may already have scrolled into history.
        const front = paced[edge]?.rows.length ?? 0;
        if (edge >= 0) paced[edge] = { ...paced[edge], playback: true, paintReserve: 1,
          paint: [{ id: localId(step.prose.id), text: step.shown, from: front - 1, to: front }] };
        blocks = paced;
      } else if (step.form === "enters") {
        // Prose that waited for a live item enters on the pulse like that item; prose
        // already drawn before any (a prompt, history) keeps the host's rows as they are.
        blocks = blocks.map(block => ({ ...block, enters: true }));
      }
      assembler.native({ mixed: entry.kind === "process", excluded: presentation.excludedComponents?.has(entry.component),
        rows: blocks.flatMap(block => block.rows), blocks });
      return;
    }
    /** One item's block, derived again only when its input changed. */
    const item = (id: string, input: unknown[], make: () => Omit<SnapshotBlock, "id" | "kind">, owners: readonly Source<T>[]) => {
      drawing.drawn.add(id);
      const cached = this.derivedRuns.get(id);
      if (cached && sameChildren(input, cached.input)) { assembler.process(cached.blocks); return; }
      const block: SnapshotBlock = { id: localId(id), kind: "structure", ...make(),
        sources: [...new Set(owners.map(owner => localId(`source:${this.tokenOf(owner.entry.component)}`)))] };
      this.derivedRuns.set(id, { input, blocks: [block] });
      assembler.process([block]);
    };
    const runShape = JSON.stringify(["run", presentation.expanded]);
    if ("run" in step) {
      const members = step.run;
      if (step.final) {
        item(`item:run:${members[0].id}`, [...shared, "final", step.done, ...members.map(member => member.card)], () => {
          const rows = renderRun(members.map(member => member.card), { ...options, current: false });
          return { rows, shape: runShape, paint: step.done ? [] : settle(rows, members[0]) };
        }, members);
        return;
      }
      const { shown, current, receipt } = step;
      item(`item:run:${members[0].id}`, [...shared, shown, current, receipt?.phase ?? !!receipt, step.active && options.pulse,
        ...members.slice(0, shown).map(member => member.card)], () => {
        const rows = renderRun(members.slice(0, shown).map(member => member.card), { ...options, current });
        return { rows, shape: runShape, paint: receipt ? settle(rows, receipt.member, receipt.phase) : [] };
      }, members);
      return;
    }
    const { source } = step, { card } = source;
    const isThinking = card.toolName === "thinking";
    if (step.final) {
      item(`item:${source.id}`, [...shared, "final", step.done, card], () => {
        const rows = isThinking ? renderThinking(card, { ...options, text: card.detail ?? "", window: false }).rows : renderTool(card, options);
        return { rows, shape: JSON.stringify(isThinking ? ["thinking", false, presentation.expanded] : ["tool", presentation.expanded]),
          paint: step.done ? [] : settle(rows, source) };
      }, [source]);
      return;
    }
    const { window, done, flowText } = step;
    item(`item:${source.id}`, [...shared, window, done, step.active && options.pulse, flowText, card], () => {
      const text = isThinking ? card.detail ?? "" : "";
      const { rows, paced } = isThinking
        ? renderThinking(card, { ...options, text: presentation.expanded && !window ? text : flowText, window })
        : { rows: renderTool(card, options), paced: undefined };
      return { rows, playback: window,
        shape: JSON.stringify(isThinking ? ["thinking", window, presentation.expanded] : ["tool", presentation.expanded]),
        paint: paced ? [{ id: localId(source.id), text: flowText, ...paced }] : !window && !done ? settle(rows, source) : [],
        ...(window ? { paintReserve: 1 + BODY_ROWS } : {}) };
    }, [source]);
  }

  /** Where a native part starts in the frame: a candidate end for the sealed prefix. */
  private cut(entry: Entry<T>, assembler: Drawing<T>["assembler"]): void {
    if (entry.kind !== "process" && entry.native!.blocks[0]) this.cuts.set(entry.component,
      { afterProcess: assembler.state().afterProcess, id: entry.native!.blocks[0].id });
  }

  private markDirty(component: T): void {
    if (this.disposed || this.disabled) return;
    const entry = this.byComponent.get(component as object);
    if (entry) {
      entry.dirty = true;
      this.semanticRevision += 1;
    }
  }

  private installHooks(component: T): boolean {
    const existing = hookState(component);
    if (existing) return existing.cache === this;
    const target = component as unknown as Record<PropertyKey, unknown>;
    const state: HookState<T> = { cache: this, component, methods: new Map() };
    try {
      Object.defineProperty(target, HOOK_STATE_KEY, {
        configurable: true,
        enumerable: false,
        value: state,
        writable: true,
      });
      for (const name of HOOK_METHODS) {
        const original = target[name];
        if (typeof original !== "function") continue;
        const descriptor = Object.getOwnPropertyDescriptor(target, name);
        const wrapper = function (this: T, ...args: unknown[]) {
          try {
            return (original as (...values: unknown[]) => unknown).apply(this, args);
          } finally {
            state.cache.markDirty(component);
          }
        };
        Object.defineProperty(target, name, {
          configurable: true,
          enumerable: descriptor?.enumerable ?? false,
          value: wrapper,
          writable: true,
        });
        state.methods.set(name, { descriptor, original, wrapper });
      }
      if (!state.methods.size) {
        delete target[HOOK_STATE_KEY];
        return true;
      }
      this.hooks.add(state);
      return true;
    } catch {
      this.restoreHook(state);
      return false;
    }
  }

  private disposeHooks(): void {
    for (const state of this.hooks) this.restoreHook(state);
    this.hooks.clear();
  }

  private restoreHook(state: HookState<T>): void {
    const target = state.component as unknown as Record<PropertyKey, unknown>;
    for (const [name, method] of state.methods) {
      if (target[name] !== method.wrapper) continue;
      try {
        if (method.descriptor) Object.defineProperty(target, name, method.descriptor);
        else delete target[name];
      } catch {
        // An extension may have replaced the method after installation. Leave
        // that replacement in place and continue restoring the other hooks.
      }
    }
    if (target[HOOK_STATE_KEY] === state) {
      try { delete target[HOOK_STATE_KEY]; } catch { /* best effort */ }
    }
  }
}
