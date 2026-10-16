import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { fees } from '../lambda/monitoring/rules/fees';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const now = new Date('2026-10-14T12:00:00Z');
const CENT = 10_000_000n;
const dollars = (amount: string) => BigInt(Math.round(Number(amount) * 1e9));
const contracts = (amount: string) => BigInt(Math.round(Number(amount) * 1e6));
const nanos = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;

const KALSHI = {
  currency: 'USD', components: [{ kind: 'PRICE_CURVE', taker: 0.07, maker: 0.0175, exponent: 1 }],
  rounding: { mode: 'CEIL', increment: 0.0001, scope: 'ORDER_ACCUMULATOR' },
};
const POLYMARKET_US = {
  currency: 'USD', components: [{ kind: 'PRICE_CURVE', taker: 0.0695, maker: -0.0125, exponent: 1 }],
  rounding: { mode: 'HALF_EVEN', increment: 0.01, scope: 'FILL' },
};

// Kalshi (1) listing 500, Polymarket US (2) listing 600, Polymarket International (3) listing 700. Polymarket US's
// schedule starts 2026-04-03, as the registry's does.
describeDb('fee mismatch rule, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  let cum = 0n;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    cum = 0n;
    await client.query(`TRUNCATE ledger.fill, strategy.session, strategy.strategy, sm.fee_schedule, sm.listing,
      sm.security, sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code) VALUES
      (1, 'K', 'us-east-1', 'mbp-10', 'KALSHI'), (2, 'P', 'us-east-1', 'mbp-10', 'POLYMARKET_US'),
      (3, 'I', 'us-east-1', 'mbp-10', 'POLYMARKET_INTL')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'K', 4), (2, 'P', 4), (3, 'I', 4)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id,
      exchange_security_symbol) VALUES (500, 1, 1, 'T:yes', 'T-YES'), (600, 2, 2, 's:long', 'S-LONG'),
      (700, 3, 3, 'c:t', 'C-T')`);
    await client.query(`INSERT INTO sm.fee_schedule (exchange_id, effective_from, definition, source) VALUES
      (1, '1970-01-01', $1, 'MANUAL'), (2, '2026-04-03T04:00:00Z', $2, 'MANUAL'), (3, '1970-01-01', $1, 'MANUAL')`,
    [JSON.stringify(KALSHI), JSON.stringify(POLYMARKET_US)]);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb')`);
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at) VALUES
      ('live', 1, 'RUNNING', 'live', '{}', NOW()), ('paper', 1, 'RUNNING', 'paper', '{}', NOW())`);
  });

  async function fill(order: number, listingId: number, qty: string, price: string, fee: bigint,
    liquidity: 'MAKER' | 'TAKER' | null, at = '2026-10-14T10:00:00Z', session = 'live', buy = true) {
    cum += contracts(qty);
    await client.query(`INSERT INTO ledger.fill (source, session_id, strategy_id, listing_id, mode, client_oid_counter,
      cum_qty_after, side, fill_qty, fill_price, fee, event_time_ns, liquidity, recorded_at)
      VALUES ('VENUE', $1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [session, listingId, session, order, cum, buy ? 0 : 1, contracts(qty), dollars(price), fee, nanos(at), liquidity,
      new Date(Date.parse(at))]);
  }

  it('passes fees that match the venue to the unit, including Kalshi rounding carried across an order', async () => {
    await fill(1, 500, '10', '0.55', dollars('0.1733'), 'TAKER');
    await fill(1, 500, '1', '0.55', dollars('0.0173'), 'TAKER', '2026-10-14T10:00:00.001Z');
    await fill(2, 600, '1', '0.436', dollars('0.02'), 'TAKER');
    await fill(3, 600, '3', '0.34', -dollars('0.01'), 'MAKER');
    await fill(4, 600, '15.47', '0.90', -dollars('0.02'), 'MAKER', undefined, 'live', false);

    expect(await fees(client, now)).toEqual([]);
  });

  it('flags a listing whose orders were charged more than a cent off, naming the worst', async () => {
    await fill(1, 500, '10', '0.55', dollars('0.20'), 'TAKER');
    await fill(1, 500, '1', '0.55', dollars('0.02'), 'TAKER', '2026-10-14T10:00:00.001Z');
    await fill(2, 500, '1', '0.55', dollars('0.0174'), 'TAKER');

    const [finding] = await fees(client, now);
    expect(finding).toMatchObject({
      kind: 'FEE_MISMATCH', key: 'FEE_MISMATCH:500', severity: 'info', mode: 'live', listingId: 500,
      exchangeName: 'KALSHI', facts: { orders: 2, mismatched: 1, differenceUnits: Number(dollars('0.0294')) },
    });
    expect(finding.detail).toContain('order 1 of session live was charged $0.22, expected $0.19');
  });

  it('allows a cent per order, and checks a fill of unknown liquidity against both', async () => {
    await fill(1, 600, '1', '0.436', dollars('0.03'), 'TAKER');
    // 3 at $0.34: a maker earns $0.01 back, a taker pays $0.05.
    await fill(2, 600, '3', '0.34', dollars('0.05'), null);
    await fill(3, 600, '3', '0.34', -dollars('0.01'), null);

    expect(await fees(client, now)).toEqual([]);

    await fill(4, 600, '3', '0.34', dollars('0.07'), null);
    expect((await fees(client, now)).map((f) => f.facts.mismatched)).toEqual([1]);
  });

  it('reports fills no schedule covers instead of judging them', async () => {
    await fill(1, 600, '1', '0.436', dollars('0.50'), 'TAKER', '2026-01-10T00:00:00Z');
    await client.query(`UPDATE ledger.fill SET recorded_at = NOW()`);

    const [finding] = await fees(client, new Date());
    expect(finding).toMatchObject({ kind: 'FEE_SCHEDULE_MISSING', listingId: 600, since: '2026-01-10T00:00:00.000Z' });
  });

  it('leaves out paper fills, venues that report no fee, and orders with no fill in the last day', async () => {
    await fill(1, 500, '1', '0.55', dollars('9'), 'TAKER', undefined, 'paper');
    await fill(2, 700, '1', '0.55', dollars('9'), 'TAKER');
    await fill(3, 500, '1', '0.55', dollars('9'), 'TAKER', '2026-10-12T10:00:00Z');

    expect(await fees(client, now)).toEqual([]);
  });
});
