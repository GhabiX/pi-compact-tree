import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { isGapRow } from "./format.ts";
import type { PaintSpan, SnapshotBlock } from "./snapshot.ts";

export type OutputSpan = {
  id: string;
  at: number;
  kind: SnapshotBlock["kind"];
  shape: string;
  sources?: readonly string[];
  playback?: boolean;
  enters?: boolean;
  paintReserve?: number;
  paint?: readonly PaintSpan[];
  sealed?: true;
};

export type NativeOutput = {
  mixed?: boolean;
  excluded?: boolean;
  rows: readonly string[];
  blocks: readonly SnapshotBlock[];
};

function visibleNative(row: string): boolean {
  return stripTerminalSequences(row).trim() !== "" || /\x1b\[[0-9;]*m/u.test(row);
}

/**
 * Per-prepare rows/block assembly. It owns no cache or playback state; all
 * inputs are already ordered and semantically admitted by ProjectionCache.
 */
export function createOutputAssembler(onDrop?: (span: PaintSpan) => void): {
  process(blocks: readonly SnapshotBlock[]): void;
  native(source: NativeOutput): void;
  sealed(block: SnapshotBlock, afterProcess: boolean): void;
  state(): { at: number; afterProcess: boolean };
  finish(): SnapshotBlock[];
} {
  const lines: string[] = [];
  const spans: OutputSpan[] = [];
  let afterProcess = false;
  const drop = (paint: readonly PaintSpan[] | undefined) => {
    if (!onDrop || !paint) return;
    for (const span of paint) onDrop(span);
  };
  // A sealed prefix is already owned by the host. It stays opaque while the
  // tail is assembled, and finish() hands its rows on by reference.
  let prefix: SnapshotBlock | undefined;
  const prefixRows = () => prefix?.rows.length ?? 0;
  const totalRows = () => prefixRows() + lines.length;
  const hasOutput = () => totalRows() > 0;
  const lastOutput = () => lines.length ? lines[lines.length - 1] : prefix?.rows.at(-1);
  const append = (rows: readonly string[]) => {
    for (const row of rows) lines.push(row);
  };

  const process = (blocks: readonly SnapshotBlock[]) => {
    for (const block of blocks) if (!block.rows.length) drop(block.paint);
    if (!blocks.some(block => block.rows.length)) return;
    while (lines.length && isGapRow(lines[lines.length - 1])) lines.pop();
    while (spans.length && !spans[spans.length - 1].sealed && spans[spans.length - 1].at >= totalRows()) {
      drop(spans.pop()!.paint);
    }
    const tail = spans.at(-1);
    if (tail?.paint?.length && !tail.sealed) {
      const kept = totalRows() - tail.at;
      tail.paint = tail.paint.flatMap(span => {
        if (span.to <= span.from || span.from >= kept) { onDrop?.(span); return []; }
        return [span.to > kept ? { ...span, to: kept } : span];
      });
    }
    let first = true;
    for (const block of blocks) {
      if (!block.rows.length) continue;
      const at = totalRows();
      if (first && hasOutput()) lines.push("");
      append(block.rows);
      spans.push({ id: block.id, at, kind: block.kind, shape: block.shape, sources: block.sources,
        playback: block.playback,
        ...(block.paintReserve === undefined ? {} : { paintReserve: block.paintReserve + (first && at > 0 ? 1 : 0) }),
        paint: block.paint?.map(span => ({ ...span,
          from: span.from + (first && at > 0 ? 1 : 0),
          to: span.to + (first && at > 0 ? 1 : 0),
        })) });
      first = false;
    }
    afterProcess = true;
  };

  const native = (source: NativeOutput) => {
    if (source.mixed && source.excluded) {
      for (const block of source.blocks) drop(block.paint);
      return;
    }
    const at = totalRows();
    let first = 0;
    let contentAt = at;
    if (afterProcess) {
      while (first < source.rows.length && isGapRow(source.rows[first])) first += 1;
      if (first >= source.rows.length) {
        for (const block of source.blocks) drop(block.paint);
        return;
      }
      const head = source.rows[first];
      if (visibleNative(head) && (!hasOutput() || !isGapRow(lastOutput() ?? ""))) lines.push("");
      contentAt = totalRows();
      append(source.rows.slice(first));
      afterProcess = false;
    } else {
      append(source.rows);
    }
    if (totalRows() <= at) {
      for (const block of source.blocks) drop(block.paint);
      return;
    }
    let offset = 0;
    let emitted = false;
    for (const block of source.blocks) {
      const end = offset + block.rows.length;
      if (end > first) {
        const dropped = Math.max(0, first - offset), padding = emitted ? 0 : contentAt - at;
        const paint = block.paint?.flatMap(span => {
          if (span.to <= span.from || span.to <= dropped) { onDrop?.(span); return []; }
          return [{ ...span, from: Math.max(0, span.from - dropped) + padding, to: span.to - dropped + padding }];
        });
        spans.push({ id: block.id, kind: block.kind, shape: block.shape, sources: block.sources,
          at: emitted ? contentAt + offset - first : at,
          playback: block.playback, enters: block.enters,
          ...(block.paintReserve === undefined ? {} : { paintReserve: block.paintReserve - dropped + padding }),
          ...(block.paint === undefined ? {} : { paint }) });
        emitted = true;
      } else {
        drop(block.paint);
      }
      offset = end;
    }
  };

  /** Final leading rows; later output continues from their spacing state. */
  const sealed = (block: SnapshotBlock, endsAfterProcess: boolean) => {
    prefix = block;
    spans.push({ id: block.id, at: 0, kind: block.kind, shape: block.shape, sealed: true });
    afterProcess = endsAfterProcess;
  };
  return {
    process,
    native,
    sealed,
    state: () => ({ at: totalRows(), afterProcess }),
    // Spans are at host offsets; the tail lines start after the prefix.
    finish: () => spans.map(({ at, ...span }, index) => ({ ...span,
      rows: span.sealed ? prefix!.rows : lines.slice(at - prefixRows(), (spans[index + 1]?.at ?? totalRows()) - prefixRows()),
    })).filter((block) => block.rows.length > 0),
  };
}
