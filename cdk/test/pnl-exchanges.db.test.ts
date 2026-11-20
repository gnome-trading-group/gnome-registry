import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { exchangeVolumes, netCostPer100 } from '../lambda/endpoints/pnl-exchanges';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const CENT = 10_000_000;
const UNIT = 1_000_000;
const cents = (value: number) => String(value * CENT);

// Two exchanges, Kalshi (two accounts) and Polymarket (one), and two strategies, priced in cents:
//   yesterday  arb buys 10 at 40c on Kalshi account steady-heron-01 as maker (fee 1c)
//   today      arb sells 4 at 50c on steady-heron-01 as taker (fee 2c); mm buys 2 at 30c on quiet-otter-02 as maker (fee 0)
//              mm buys 5 at 20c on Polymarket brave-lynx-03 as maker (fee 0); Kalshi pays steady-heron-01 a 3c reward
//              a settlement on Kalshi, which isn't trading
describeDb('volume by exchange, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  const now = new Date('2026-10-06T13:00:00Z');

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE ledger.fill, treasury.transfer, account_master.venue_account, strategy.strategy,
      sm.listing, sm.security, sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'Kalshi', 'us-east-1', 'KALSHI'), (2, 'Polymarket', 'us-east-1', 'POLYMARKET_INTL'),
             (3, 'Idle', 'us-east-1', 'IDLE')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'X', 0)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_symbol)
      VALUES (500, 1, 1, 'KX-YES'), (600, 2, 1, 'PM-YES')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb'), ('mm')`);
    await client.query(`INSERT INTO account_master.venue_account (exchange_id, label, status, trading_secret_name, activated_at)
      VALUES (1, 'steady-heron-01', 'ACTIVE', 's', NOW()), (1, 'quiet-otter-02', 'ACTIVE', 's', NOW()), (2, 'brave-lynx-03', 'ACTIVE', 's', NOW())`);
  });

  async function fill(f: {
    strategy: number; listing: number; account: number | null; qty: number; price: number; fee: number;
    liquidity: string | null; at: string; mode?: string; source?: string;
  }) {
    await client.query(`INSERT INTO ledger.fill (source, strategy_id, listing_id, mode, account_id, fill_qty, fill_price,
      fee, liquidity, net_quantity_after, total_cost_after, recorded_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0, $10)`,
    [f.source ?? 'VENUE', f.strategy, f.listing, f.mode ?? 'live', f.account, f.qty * UNIT, f.price * CENT, f.fee * CENT,
      f.liquidity, f.at]);
  }

  async function story() {
    await fill({ strategy: 1, listing: 500, account: 1, qty: 10, price: 40, fee: 1, liquidity: 'MAKER', at: '2026-10-05T12:00:00Z' });
    await fill({ strategy: 1, listing: 500, account: 1, qty: 4, price: 50, fee: 2, liquidity: 'TAKER', at: '2026-10-06T10:00:00Z' });
    await fill({ strategy: 2, listing: 500, account: 2, qty: 2, price: 30, fee: 0, liquidity: 'MAKER', at: '2026-10-06T10:30:00Z' });
    await fill({ strategy: 2, listing: 600, account: 3, qty: 5, price: 20, fee: 0, liquidity: 'MAKER', at: '2026-10-06T11:00:00Z' });
    await fill({ strategy: 1, listing: 500, account: 1, qty: 6, price: 100, fee: 0, liquidity: null, at: '2026-10-06T12:00:00Z',
      source: 'SETTLEMENT' });
    await client.query(`INSERT INTO treasury.transfer (account_id, kind, amount, occurred_at, actor)
      VALUES (1, 'REWARD', $1, '2026-10-06T09:00:00Z', 'poller'), (1, 'INTEREST', $2, '2026-10-06T09:00:00Z', 'poller')`,
    [3 * CENT, 50 * CENT]);
  }

  const volume = (maker: number, taker: number, fills: number, fees: number) => ({
    notional: cents(maker + taker), maker: cents(maker), taker: cents(taker), fills, fees: cents(fees),
  });

  it('breaks each exchange down by account and strategy, its rewards counted against its fees', async () => {
    await story();
    const result = await exchangeVolumes(client, { mode: 'live', days: '2' }, now) as any;
    expect(result.scope).toMatchObject({ mode: 'live', days: 2, from: '2026-10-05T00:00:00.000Z' });
    expect(result.exchanges.map((e: any) => e.exchangeCode)).toEqual(['KALSHI', 'POLYMARKET_INTL']);
    const [kalshi, poly] = result.exchanges;
    expect(kalshi.volume).toEqual(volume(460, 200, 3, 3));
    expect(kalshi.rewards).toBe(cents(3));
    // Fees 3c less rewards 3c on $6.60 traded.
    expect(kalshi.netCostPer100).toBe('0');
    expect(kalshi.accounts).toEqual([
      { accountId: 1, label: 'steady-heron-01', volume: volume(400, 200, 2, 3), rewards: cents(3) },
      { accountId: 2, label: 'quiet-otter-02', volume: volume(60, 0, 1, 0), rewards: cents(0) },
    ]);
    expect(kalshi.strategies).toEqual([
      { strategyId: 1, name: 'arb', volume: volume(400, 200, 2, 3) },
      { strategyId: 2, name: 'mm', volume: volume(60, 0, 1, 0) },
    ]);
    expect(poly.volume).toEqual(volume(100, 0, 1, 0));
    expect(result.daily).toBeUndefined();
  });

  it('counts only the local days asked for', async () => {
    await story();
    const today = await exchangeVolumes(client, { mode: 'live', days: '1' }, now) as any;
    expect(today.exchanges[0].volume).toEqual(volume(60, 200, 2, 2));
    // In Pago Pago (UTC-11) the day began at 11:00 UTC: only the settlement, which isn't trading, came after.
    const pagoPago = await exchangeVolumes(client, { mode: 'live', days: '1', tz: 'Pacific/Pago_Pago' }, now) as any;
    expect(pagoPago.exchanges).toEqual([]);
  });

  it('gives one exchange its daily volume, and an idle one at zero', async () => {
    await story();
    const kalshi = await exchangeVolumes(client, { mode: 'live', days: '2', exchangeId: '1' }, now) as any;
    expect(kalshi.exchanges).toHaveLength(1);
    expect(kalshi.daily.map((d: any) => [d.date, d.volume])).toEqual([
      ['2026-10-05', volume(400, 0, 1, 1)],
      ['2026-10-06', volume(60, 200, 2, 2)],
    ]);
    const idle = await exchangeVolumes(client, { mode: 'live', exchangeId: '3' }, now) as any;
    expect(idle.exchanges[0]).toMatchObject({ exchangeCode: 'IDLE', volume: volume(0, 0, 0, 0), netCostPer100: null });
    expect(await exchangeVolumes(client, { mode: 'live', exchangeId: '99' }, now)).toBeNull();
  });

  it('paper trades through no account', async () => {
    await fill({ strategy: 1, listing: 500, account: null, qty: 1, price: 50, fee: 1, liquidity: 'TAKER', at: '2026-10-06T10:00:00Z', mode: 'paper' });
    const paper = await exchangeVolumes(client, { mode: 'paper', days: '1' }, now) as any;
    expect(paper.exchanges[0]).toMatchObject({ volume: volume(0, 50, 1, 1), accounts: [], netCostPer100: cents(200) });
    await expect(exchangeVolumes(client, {}, now)).rejects.toThrow(/mode/);
  });

  it('prices the net cost per $100 traded', () => {
    const v = { notional: 1000n * BigInt(CENT), maker: 0n, taker: 0n, fills: 1, fees: 5n * BigInt(CENT) };
    expect(netCostPer100(v, 0n)).toBe(50n * BigInt(CENT));
    expect(netCostPer100(v, 10n * BigInt(CENT))).toBe(-50n * BigInt(CENT));
    expect(netCostPer100({ ...v, notional: 0n }, 0n)).toBeNull();
  });
});
