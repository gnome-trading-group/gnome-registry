import { readFileSync } from 'fs';
import { join } from 'path';
import { committedCapital } from '../lambda/endpoints/ledger-math';

// The same cases gnome-oms's CommittedCapitalTest runs (copied from gnome-oms src/test/resources), so the registry's
// usage and allocation figures match what the OMS enforces. Refresh the copy whenever the OMS formula changes.
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'committed-capital-cases.json'), 'utf8')) as {
  cases: Record<string, string | boolean>[];
};

describe('committed capital, as the OMS counts it', () => {
  it.each(fixture.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(committedCapital({
      binary: c.binary as boolean,
      netQuantity: BigInt(c.netQuantity as string),
      totalCost: BigInt(c.totalCost as string),
      leavesBuyQty: BigInt(c.leavesBuyQty as string),
      leavesBuyNotional: BigInt(c.leavesBuyNotional as string),
      leavesSellQty: BigInt(c.leavesSellQty as string),
      leavesSellNotional: BigInt(c.leavesSellNotional as string),
    }).toString()).toBe(c.expected);
  });
});
