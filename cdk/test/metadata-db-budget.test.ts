import { SQSEvent } from 'aws-lambda';
import { Mode } from '../lambda/sync/metadata/kind';
import { hashOf } from '../lambda/sync/metadata/snapshot';
import { refreshes, Registry, SpecSnapshot, syncVenue } from '../lambda/sync/metadata/specs';
import { VenueSpec } from '../lambda/sync/venues/specs';
import { memorySnapshots } from './memory-snapshots';

// What each mode may ask of the registry's database. A population read (every active listing, every listing without
// a spec) is allowed only in the paced daily or hourly passes; the every-minute and every-15-minute modes and the
// refreshes read only recent rows (range) or named rows (point). Each Registry method is labelled by what its
// endpoint reads, so this pins which calls each mode makes; that a range call stays a range (its window, the indexes
// behind it) is the endpoints' own tests' and the query plans'.
type Read = 'population' | 'range' | 'point' | 'write';

const spec: VenueSpec = {
  priceBands: [{ start: 0, end: 1_000_000_000, step: 10_000_000 }], lotSize: 10_000, minNotional: 0, minSize: 0,
  contractMultiplier: 1_000_000_000,
};

function countingRegistry() {
  const reads: Read[] = [];
  const registry: Registry = {
    exchangeIds: async () => { reads.push('point'); return new Map([['KALSHI', 1]]); },
    activeTargets: async () => { reads.push('population'); return [{ listingId: 1, exchangeSecurityId: 'M1', current: spec }]; },
    unspeccedTargets: async (_id, created) => {
      reads.push(created.after ? 'range' : 'population');
      return [{ listingId: 2, exchangeSecurityId: 'M2', current: null }];
    },
    createdListings: async () => { reads.push('range'); return [{ listingId: 2, exchangeSecurityId: 'M2' }]; },
    currentSpecs: async (ids) => { reads.push('point'); return new Map(ids.map(id => [id, spec])); },
    target: async (_id, exchangeSecurityId) => { reads.push('point'); return { listingId: 1, exchangeSecurityId, current: spec }; },
    post: async (rows) => { reads.push('write'); return { written: rows.length, refused: [] }; },
  };
  return { registry, reads };
}

describe("the specs kind's database budget", () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const moved: VenueSpec = { ...spec, priceBands: [{ start: 0, end: 1_000_000_000, step: 1_000_000 }] };
  const readers = { KALSHI: async (ids: string[]) => new Map(ids.map(id => [id, moved])) };
  const snapshot = (): SpecSnapshot => ({ listedThrough: now.toISOString(), listings: { 1: ['M1', hashOf(spec)] } });

  it.each<[Mode, Read[]]>([
    ['new', ['range', 'point', 'write']],
    ['sweep', ['range', 'point', 'write']],
  ])('keeps a %s pass to recent and named rows', async (mode, allowed) => {
    const { registry, reads } = countingRegistry();
    await syncVenue('KALSHI', 1, mode, registry, now, readers, memorySnapshots<SpecSnapshot>({ KALSHI: snapshot() }).snapshots);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter(r => !allowed.includes(r))).toEqual([]);
  });

  it.each<Mode>(['reconcile', 'missing'])('lets the paced %s pass read the population', async (mode) => {
    const { registry, reads } = countingRegistry();
    await syncVenue('KALSHI', 1, mode, registry, now, readers, memorySnapshots<SpecSnapshot>().snapshots);
    expect(reads).toContain('population');
  });

  it('keeps a refresh to named rows', async () => {
    const { registry, reads } = countingRegistry();
    const body = JSON.stringify({ exchangeCode: 'KALSHI', exchangeSecurityId: 'M1', observedAt: now.toISOString() });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await refreshes({ Records: [{ messageId: 'm', body, attributes: { MessageGroupId: 'g' } }] } as unknown as SQSEvent, registry, readers);
    expect(reads.filter(r => r === 'population' || r === 'range')).toEqual([]);
    jest.restoreAllMocks();
  });
});
