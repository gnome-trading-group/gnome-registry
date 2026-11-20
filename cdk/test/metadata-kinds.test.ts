import { Counts, Kind, runScheduled, Unit } from '../lambda/sync/metadata/kind';
import { memorySnapshots } from './memory-snapshots';

// The kinds still to come must fit the same interfaces: fee schedules (a log of changes the venue dates itself, known
// by their ids) and fee tiers (kept per account). Sketches of both, run through the harness.
interface FeeChange { sourceRef: string; effectiveFrom: string; definition: Record<string, unknown> }
interface FeeSnapshot { known: string[] }

function feeScheduleKind(venueChanges: FeeChange[], written: FeeChange[]): Kind<FeeSnapshot> {
  return {
    name: 'fees',
    venues: ['KALSHI'],
    modes: ['sweep', 'reconcile'],
    async run(_mode, unit, ctx): Promise<Counts> {
      const store = ctx.snapshots(unit);
      const stored = await store.load();
      const known = new Set(stored?.value.known ?? []);
      const fresh = venueChanges.filter(c => !known.has(c.sourceRef));
      written.push(...fresh);
      await store.replace({ known: [...known, ...fresh.map(c => c.sourceRef)] });
      return { Read: venueChanges.length, Written: fresh.length };
    },
  };
}

describe('kinds to come', () => {
  const now = new Date('2026-11-20T12:00:00Z');

  it('fit a venue-dated log: each change written once, with the date the venue gave it', async () => {
    const written: FeeChange[] = [];
    const changes = [{ sourceRef: 'a', effectiveFrom: '2026-03-03T00:00:00Z', definition: {} }];
    const kind = feeScheduleKind(changes, written);
    const { snapshots } = memorySnapshots<FeeSnapshot>();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await runScheduled(kind, { mode: 'sweep' }, { now, snapshots });
    await runScheduled(kind, { mode: 'sweep' }, { now, snapshots });
    expect(written).toEqual(changes);
    jest.restoreAllMocks();
  });

  it('fit a kind kept per account: one run fans out to every account on the venue', async () => {
    const ran: Unit[] = [];
    const kind: Kind<{ tier: string }> = {
      name: 'fee-tiers',
      venues: ['KALSHI'],
      modes: ['sweep'],
      units: async venue => [{ venue, scope: 'acct-1' }, { venue, scope: 'acct-2' }],
      async run(_mode, unit, ctx) {
        ran.push(unit);
        await ctx.snapshots(unit).replace({ tier: 'base' });
        return { Read: 1 };
      },
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await runScheduled(kind, { mode: 'sweep', venue: 'KALSHI' }, { now, snapshots: memorySnapshots<{ tier: string }>().snapshots });
    expect(ran).toEqual([{ venue: 'KALSHI', scope: 'acct-1' }, { venue: 'KALSHI', scope: 'acct-2' }]);
    jest.restoreAllMocks();
  });
});
