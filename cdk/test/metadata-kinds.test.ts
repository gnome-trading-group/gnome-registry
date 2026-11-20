import { Kind, runScheduled, Unit } from '../lambda/sync/metadata/kind';
import { memorySnapshots } from './memory-snapshots';

// Fee tiers, the kind still to come, must fit the same interfaces: kept per account. A sketch, run through the harness.

describe('the kind to come', () => {
  const now = new Date('2026-11-20T12:00:00Z');

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
