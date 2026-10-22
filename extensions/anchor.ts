/**
 * Regular-mode fold anchor.
 *
 * The viewport is the tail of the line buffer. previousViewportTop only
 * grows, and a line above it cannot be patched. A shorter visible block may
 * keep a frozen prefix in place, but a block with no frozen prefix shrinks
 * naturally so it cannot leave permanent gaps before its successor. Lines
 * above the viewport stay byte-for-byte. A block that crosses the viewport
 * may still grow, or shrink in place, below it.
 */

export type AnchoredBlock = { id: string; rows: readonly string[]; kind?: "structure" | "native"; sources?: readonly string[] };

/** Protect frozen block ownership/order; row compatibility is checked separately. */
export function frozenBlockConstraint(
  previous: readonly AnchoredBlock[],
  target: readonly AnchoredBlock[],
  viewportTop: number,
): { pinned: ReadonlySet<string>; topologyCompatible: boolean; order: string[] } {
  const frozen: AnchoredBlock[] = [];
  let start = 0;
  for (const block of previous) {
    if (start < viewportTop) frozen.push(block);
    start += block.rows.length;
  }
  const pinned = new Set(frozen.map((block) => block.id));
  const sourcesOf = (block: AnchoredBlock) => block.sources ?? [block.id];
  const represented = new Set(frozen.flatMap(sourcesOf));
  const overlaps = (block: AnchoredBlock, sources: ReadonlySet<string>, ids: ReadonlySet<string>) =>
    ids.has(block.id) || sourcesOf(block).some((source) => sources.has(source));
  // A new block sharing a source with a frozen one is a piece of it drawn again. A block already
  // drawn is itself, even when it shares a source (a Thinking and its prose come from one message).
  const drawn = new Set(previous.map((block) => block.id));
  const replaces = (block: AnchoredBlock) => !drawn.has(block.id) && overlaps(block, represented, pinned);
  const topologyCompatible = frozen.every((block, index) => target[index]?.id === block.id) && !target.some(replaces);
  if (topologyCompatible) return { pinned, topologyCompatible, order: target.map((block) => block.id) };
  // A frozen scope may split around newly arrived mixed prose. Its source
  // ownership identifies every replacement piece without guessing from text.
  // Native UI suffixes (e.g. a footer) must not push the semantic frontier past
  // a new user message inserted immediately before them.
  const structures = frozen.filter((block) => block.kind === "structure");
  const structuralSources = new Set(structures.flatMap(sourcesOf));
  const structuralIds = new Set(structures.map((block) => block.id));
  let frontier = target.findLastIndex((block) => structuralIds.has(block.id) || !drawn.has(block.id) && overlaps(block, structuralSources, structuralIds));
  if (frontier < 0) frontier = target.findLastIndex((block) => pinned.has(block.id) || replaces(block));
  const suffix = frontier < 0
    ? previous.filter((block) => !pinned.has(block.id))
    : target.slice(frontier + 1).filter((block) => !pinned.has(block.id) && !replaces(block));
  return { pinned, topologyCompatible, order: [...pinned, ...suffix.map((block) => block.id)] };
}

/**
 * A crossing block may change its addressable suffix. A block entirely before
 * another frozen row must retain its height too, so later history cannot move.
 */
export function allowsFrozenBlockChange(
  previous: readonly string[],
  target: readonly string[],
  frozenRows: number,
): boolean {
  return preservesFrozenPrefix(previous, target, frozenRows) &&
    (frozenRows <= previous.length || target.length === previous.length);
}

/**
 * Pi cannot delete its entire addressable tail after history has scrolled out.
 * Retain the current crossing/visible tail block in place; callers defer its
 * target and stop its motion.
 */
export function addressableBlockTail<T extends AnchoredBlock>(
  previous: readonly T[],
  candidate: readonly T[],
  viewportTop: number,
): { blocks: readonly T[]; retained?: string } {
  if (viewportTop <= 0 || candidate.reduce((height, block) => height + block.rows.length, 0) !== viewportTop) {
    return { blocks: candidate };
  }
  let start = 0;
  const tail = previous.find((block) => {
    start += block.rows.length;
    return start > viewportTop;
  });
  if (!tail) return { blocks: candidate };
  const exists = candidate.some((block) => block.id === tail.id);
  return { blocks: exists ? candidate.map((block) => block.id === tail.id ? tail : block) : [...candidate, tail], retained: tail.id };
}

export function preservesFrozenPrefix(
  previous: readonly string[],
  candidate: readonly string[],
  viewportTop: number,
): boolean {
  if (previous === candidate) return true;
  const length = Math.min(previous.length, viewportTop);
  if (candidate.length < length) return false;
  for (let index = 0; index < length; index += 1) if (previous[index] !== candidate[index]) return false;
  return true;
}

/** preservesFrozenPrefix over block frames, block by block while heights
 * agree: rows that are the same array are skipped without reading them, so a
 * fresh array ahead (a Spacer) does not make the sealed block behind it read. */
export function preservesFrozenBlocks(
  previous: readonly AnchoredBlock[],
  candidate: readonly AnchoredBlock[],
  viewportTop: number,
): boolean {
  let index = 0, top = viewportTop;
  while (top > 0 && index < previous.length && previous[index].rows.length === candidate[index]?.rows.length) {
    if (!preservesFrozenPrefix(previous[index].rows, candidate[index].rows, top)) return false;
    top -= previous[index].rows.length;
    index += 1;
  }
  if (top <= 0) return true;
  const rows = (blocks: readonly AnchoredBlock[]) => blocks.slice(index).flatMap((block) => block.rows);
  return preservesFrozenPrefix(rows(previous), rows(candidate), top);
}
