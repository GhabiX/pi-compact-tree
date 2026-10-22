import { ProjectionCache } from "../extensions/projection.ts";
import { FrameCoordinator, materialize } from "../extensions/snapshot.ts";

/** A publication as the host draws it: its blocks plus the rows they materialize to. */
export const withRows = (result) => ({ ...result, rows: materialize(result.blocks ?? []) });
/** The owner of each host row. */
export const rowOwners = (result) => (result.blocks ?? []).flatMap((block) => block.rows.map(() => block.id));

export class HostRowsCoordinator extends FrameCoordinator {
  publish() { return super.publish().map(withRows); }
  render() { const view = super.render(); return { ...view, owners: view.owners.map(withRows) }; }
}

export class HostRowsCache extends ProjectionCache {
  prepare(...args) { return withRows(super.prepare(...args)); }
  read() { return withRows(super.read()); }
}
