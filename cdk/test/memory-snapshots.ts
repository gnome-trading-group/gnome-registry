import { snapshotKey, Snapshots, Unit } from '../lambda/sync/metadata/kind';
import { SnapshotStore, Stored } from '../lambda/sync/metadata/snapshot';

/** Snapshots held in memory, one per venue, versioned so a save over a stale version fails as on S3. */
export function memorySnapshots<S>(initial: Record<string, S> = {}) {
  const key = (unit: Unit) => snapshotKey('test', unit);
  const held = new Map<string, Stored<S>>(
    Object.entries(initial).map(([venue, value]) => [key({ venue }), { value: structuredClone(value), version: '1' }]));
  let versions = 1;
  const snapshots: Snapshots<S> = (unit): SnapshotStore<S> => ({
    load: async () => { const s = held.get(key(unit)); return s ? structuredClone(s) : null; },
    save: async (value, version) => {
      if ((held.get(key(unit))?.version ?? null) !== version) return false;
      held.set(key(unit), { value: structuredClone(value), version: String(++versions) });
      return true;
    },
    replace: async (value) => { held.set(key(unit), { value: structuredClone(value), version: String(++versions) }); },
  });
  return { snapshots, held: (venue: string) => held.get(key({ venue }))?.value };
}
