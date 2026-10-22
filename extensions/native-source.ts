import type { Component } from "@earendil-works/pi-tui";
import type { SnapshotBlock } from "./snapshot.ts";

/**
 * The stable native ingress boundary used by ProjectionCache. This module
 * owns only observation and block metadata; playback, projection, and Host
 * publication remain outside it.
 */
export type NativeObservation = {
  rows: readonly string[];
  blocks: readonly SnapshotBlock[];
  input: readonly unknown[];
};

export function observeNativeSource<T extends Component>(
  component: T,
  width: number,
  renderNative: (component: T, width: number) => string[],
  nativeBlocks: ((component: T, rows: readonly string[]) => readonly SnapshotBlock[]) | undefined,
  sourceToken: string,
  localId: (id: string) => string,
  mixed: boolean,
): NativeObservation {
  const rows = renderNative(component, width);
  const id = localId(`native:${sourceToken}`);
  let blocks = nativeBlocks?.(component, rows) ??
    (rows.length ? [{ id, kind: "native" as const, rows, shape: "native" }] : []);
  if (mixed) blocks = blocks.map((block) => ({
    ...block, sources: block.sources ?? [localId(`source:${sourceToken}`)],
  }));
  const input: unknown[] = [rows.length, ...rows, blocks.length];
  for (const block of blocks) input.push(block.id, block.kind, block.shape, block.rows.length,
    block.sources?.length ?? 0, ...(block.sources ?? []), block.playback, block.paintReserve,
    ...(block.paint ?? []).flatMap(span => [span.id, span.text, span.from, span.to]));
  return { rows, blocks, input };
}
