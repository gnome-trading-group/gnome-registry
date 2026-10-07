import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { withTransaction } from '../lambda/endpoints/base';
import { writeBatch } from '../lambda/endpoints/ledger-batch';
import { series } from '../lambda/endpoints/pnl-series';
import { summarize } from '../lambda/endpoints/pnl-summary';
import { marks } from '../lambda/endpoints/ledger-marks';
import { daily } from '../lambda/endpoints/pnl-daily';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const CENT = 10_000_000;
const UNIT = 1_000_000;
const HALF_HOUR = 30 * 60 * 1000;
const cents = (value: number) => String(value * CENT);

// One strategy on one listing, priced in cents:
//   10:01  session old buys 10 at 40c (fee 1c)
//   10:30  mark 45c (bid 44, ask 46)
//   11:00  old stops: its PnL is 10 x (45 - 40) - 1 = 49c
//   11:30  mark 50c while nothing runs: +50c on the inventory, which belongs to no session
//   12:00  session new starts, inheriting the 10 at 40c, valued at 50c: opening unrealized 100c
//   12:30  mark 55c
//   12:40  new sells 4 at 54c (fee 1c): realizes 4 x 14 = 56c, keeps 6 at 40c
//   13:00  now: new's PnL = 56 + 6 x 15 - 1 - 100 = 45c, of which carry 10 x (55 - 50) = 50c and trading -5c
//          (sold 1c under the mark on 4, and the fee). Lifetime = 56 + 90 - 2 = 144c = 49 + 45 + 50 between sessions.
describeDb('PnL derived from the ledger, against Postgres', () => {
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
    await client.query(`TRUNCATE ledger.fill, ledger.position, ledger.order, ledger.mark, strategy.session_listing,
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.listing_spec, sm.listing, sm.security,
      sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'mbp-10', 'KALSHI')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'X', 0)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_symbol)
      VALUES (500, 1, 1, 'KX-YES')`);
    await client.query(`INSERT INTO sm.listing_spec (listing_id, tick_size, lot_size) VALUES (500, $1, $2)`,
      [CENT, UNIT]);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb')`);
  });

  async function session(id: string, startedAt: string, stoppedAt: string | null = null) {
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at)
      VALUES ($1, 1, 'RUNNING', 'paper', '{}', $2)`, [id, startedAt]);
    await client.query(`INSERT INTO strategy.session_listing VALUES ($1, 1, 'paper', 500, true)`, [id]);
    if (stoppedAt) await stop(id, stoppedAt);
  }

  async function stop(id: string, at: string) {
    await client.query(`UPDATE strategy.session SET status = 'STOPPED', stopped_at = $2 WHERE session_id = $1`, [id, at]);
  }

  async function fill(sessionId: string, at: string, f: Record<string, unknown>) {
    const body = JSON.stringify({ sessionId, fills: [{ source: 'VENUE', listingId: 500, eventTimeNs: 1, ...f }] });
    await withTransaction(client, (c) => writeBatch(c, sessionId, body));
    await client.query(`UPDATE ledger.fill SET recorded_at = $1 WHERE fill_id = (SELECT MAX(fill_id) FROM ledger.fill)`, [at]);
  }

  async function mark(at: string, bidCents: number, askCents: number) {
    await client.query(`INSERT INTO ledger.mark (listing_id, ts, bid, ask, last_trade) VALUES (500, $1, $2, $3, 0)`,
      [at, bidCents * CENT, askCents * CENT]);
  }

  async function story() {
    await session('old', '2026-10-06T10:00:00Z');
    await fill('old', '2026-10-06T10:01:00Z', { clientOidCounter: 1, cumQtyAfter: 10 * UNIT, side: 0,
      fillQty: 10 * UNIT, fillPrice: 40 * CENT, fee: CENT, netQuantityAfter: 10 * UNIT, totalCostAfter: 400 * CENT,
      realizedPnlAfter: 0, feesAfter: CENT, positionVersion: 1, liquidity: 'MAKER' });
    await mark('2026-10-06T10:30:00Z', 44, 46);
    await stop('old', '2026-10-06T11:00:00Z');
    await mark('2026-10-06T11:30:00Z', 49, 51);
    await session('new', '2026-10-06T12:00:00Z');
    await mark('2026-10-06T12:30:00Z', 54, 56);
    await fill('new', '2026-10-06T12:40:00Z', { clientOidCounter: 1, cumQtyAfter: 4 * UNIT, side: 1,
      fillQty: 4 * UNIT, fillPrice: 54 * CENT, fee: CENT, netQuantityAfter: 6 * UNIT, totalCostAfter: 240 * CENT,
      realizedPnlAfter: 56 * CENT, feesAfter: CENT, positionVersion: 2, liquidity: 'TAKER' });
  }

  it('a session that inherited inventory starts at $0 and splits its PnL into carry and trading', async () => {
    await story();
    const summary = await summarize(client, { sessionId: 'new' }, now) as any;
    expect(summary.opening).toBe('INHERITED');
    expect(summary.totals).toEqual({
      total: cents(45), realized: cents(56), unrealized: cents(90), fees: cents(1), carry: cents(50),
      trading: cents(-5), openingUnrealized: cents(100),
    });
    const row = summary.listings[0];
    expect([row.symbol, row.tickSize, row.lotSize]).toEqual(['KX-YES', String(CENT), String(UNIT)]);
    expect([row.netQuantity, row.markPrice, row.opening.netQuantity, row.opening.markPrice])
      .toEqual([String(6 * UNIT), cents(55), String(10 * UNIT), cents(50)]);
    expect(summary.counts.fills).toBe(1);

    const old = await summarize(client, { sessionId: 'old' }, now) as any;
    expect(old.opening).toBe('NONE');
    expect(old.totals.total).toBe(cents(49));
    expect(old.asOf).toBe('2026-10-06T11:00:00.000Z');
  });

  it("a strategy's lifetime is its sessions' PnL plus what moved between them; today starts at the zone's midnight", async () => {
    await story();
    const utc = await summarize(client, { strategyId: '1', mode: 'paper' }, now) as any;
    expect(utc.totals).toEqual({
      lifetime: cents(144), today: cents(144), realized: cents(56), unrealized: cents(90), fees: cents(2),
      betweenSessions: cents(50),
    });
    expect(utc.openPositions).toBe(1);
    expect(utc.modesWithData).toEqual(['paper']);

    // 13:00 UTC is 02:00 in Pago Pago (UTC-11), whose day began at 11:00 UTC, when the strategy stood at 49c.
    const pagoPago = await summarize(client, { strategyId: '1', mode: 'paper', tz: 'Pacific/Pago_Pago' }, now) as any;
    expect(pagoPago.totals.today).toBe(cents(95));
    expect(pagoPago.scope.dayStart).toBe('2026-10-06T11:00:00.000Z');

    const firm = await summarize(client, { mode: 'paper' }, now) as any;
    expect(firm.strategies).toEqual([
      { strategyId: 1, lifetime: cents(144), today: cents(144), unrealized: cents(90), openPositions: 1 },
    ]);

    const page = await summarize(client, { sessionIds: 'new,old' }, now) as any;
    expect(page.map((s: any) => [s.sessionId, s.opening, s.totals.total, s.fills]))
      .toEqual([['new', 'INHERITED', cents(45), 1], ['old', 'NONE', cents(49), 1]]);
  });

  it('a session series starts at $0 and steps with its marks and fills; since returns only new points', async () => {
    await story();
    const s = await series(client, { sessionId: 'new', resolution: String(HALF_HOUR) }, now) as any;
    expect(s.t.map((t: number) => new Date(t).toISOString().slice(11, 16))).toEqual(['12:00', '12:30', '13:00']);
    expect(s.total).toEqual([cents(0), cents(50), cents(45)]);
    expect([s.listings[0].symbol, s.listings[0].lotSize]).toEqual(['KX-YES', String(UNIT)]);
    expect(s.listings[0].netQuantity).toEqual([String(10 * UNIT), String(10 * UNIT), String(6 * UNIT)]);
    expect(s.events.map((e: any) => e.kind)).toEqual(['SESSION_START']);

    const tail = await series(client, {
      sessionId: 'new', resolution: String(HALF_HOUR), since: String(Date.parse('2026-10-06T12:30:00Z')),
    }, now) as any;
    expect(tail.total).toEqual([cents(50), cents(45)]);
  });

  it('a strategy series is continuous across sessions, including what moved between them', async () => {
    await story();
    const s = await series(client, {
      strategyId: '1', mode: 'paper', start: '2026-10-06T10:00:00Z', resolution: String(HALF_HOUR),
    }, now) as any;
    // 10:00, 10:30 (bought, marked 45c), 11:00, 11:30 (50c), 12:00, 12:30 (55c), 13:00 (sold 4)
    expect(s.total).toEqual([0, 49, 49, 99, 99, 149, 144].map(cents));
    expect(s.events.map((e: any) => [e.kind, e.sessionId]))
      .toEqual([['SESSION_START', 'old'], ['SESSION_STOP', 'old'], ['SESSION_START', 'new']]);
  });

  it('starting flat writes off the inventory: the strategy shows the loss, the session starts at $0 with nothing', async () => {
    await story();
    await stop('new', '2026-10-06T13:00:00Z');
    await session('flat', '2026-10-06T14:00:00Z');
    await fill('flat', '2026-10-06T14:00:05Z', { source: 'RESET', clientOidCounter: 0, netQuantityAfter: 0,
      totalCostAfter: 0, realizedPnlAfter: 0, feesAfter: 0, positionVersion: 3, reason: 'started flat' });
    const later = new Date('2026-10-06T15:00:00Z');

    const flat = await summarize(client, { sessionId: 'flat' }, later) as any;
    expect(flat.opening).toBe('FLAT');
    expect(flat.totals.total).toBe(cents(0));

    const strategy = await summarize(client, { strategyId: '1', mode: 'paper' }, later) as any;
    expect(strategy.totals.lifetime).toBe(cents(54));
    expect(strategy.totals.betweenSessions).toBe(cents(-40));

    const s = await series(client, {
      strategyId: '1', mode: 'paper', start: '2026-10-06T13:30:00Z', resolution: String(HALF_HOUR),
    }, later) as any;
    const reset = s.events.find((e: any) => e.kind === 'RESET');
    expect([reset.sessionId, reset.pnlImpact, reset.reason]).toEqual(['flat', cents(-90), 'started flat']);
    expect(s.total).toEqual([cents(144), cents(144), cents(54), cents(54)]);
  });

  it('a short position gains when the mark falls', async () => {
    await session('short', '2026-10-06T10:00:00Z');
    await mark('2026-10-06T10:00:00Z', 59, 61);
    await fill('short', '2026-10-06T10:01:00Z', { clientOidCounter: 1, cumQtyAfter: 10 * UNIT, side: 1,
      fillQty: 10 * UNIT, fillPrice: 60 * CENT, fee: 0, netQuantityAfter: -10 * UNIT, totalCostAfter: 600 * CENT,
      realizedPnlAfter: 0, feesAfter: 0, positionVersion: 1 });
    await mark('2026-10-06T10:30:00Z', 49, 51);
    const summary = await summarize(client, { sessionId: 'short' }, now) as any;
    expect([summary.totals.unrealized, summary.totals.total, summary.totals.carry])
      .toEqual([cents(100), cents(100), cents(0)]);
  });

  it('rejects what it cannot answer', async () => {
    await expect(summarize(client, { strategyId: '1' }, now)).rejects.toThrow(/mode is required/);
    await expect(summarize(client, { mode: 'paper', tz: 'Mars/Olympus' }, now)).rejects.toThrow(/tz/);
    await expect(series(client, { strategyId: '1' }, now)).rejects.toThrow(/mode/);
    expect(await summarize(client, { sessionId: 'nope' }, now)).toBeNull();
  });

  it('a strategy series for one listing leaves the others out', async () => {
    await story();
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id) VALUES (501, 1, 1)`);
    await client.query(`INSERT INTO ledger.fill (source, session_id, strategy_id, listing_id, mode, client_oid_counter,
        cum_qty_after, net_quantity_after, total_cost_after, realized_pnl_after, fees_after, position_version, recorded_at)
      VALUES ('VENUE', 'new', 1, 501, 'paper', 2, 1, 0, 0, $1, 0, 1, '2026-10-06T12:50:00Z')`, [3 * CENT]);
    const params = { strategyId: '1', mode: 'paper', start: '2026-10-06T10:00:00Z', resolution: String(HALF_HOUR) };
    const all = await series(client, params, now) as any;
    const one = await series(client, { ...params, listingId: '500' }, now) as any;
    expect(all.total.at(-1)).toBe(cents(147));
    expect(one.total.at(-1)).toBe(cents(144));
    expect(one.listings.map((l: any) => l.listingId)).toEqual([500]);
  });

  it('price history opens with the price in force, then the last in each step, with the mark derived', async () => {
    await mark('2026-10-06T10:00:10Z', 40, 42);
    await mark('2026-10-06T10:00:40Z', 41, 43);
    await mark('2026-10-06T10:00:50Z', 42, 44);
    await mark('2026-10-06T10:01:20Z', 0, 45);
    const m = await marks(client, { listingId: '500', start: '2026-10-06T10:00:30Z', resolution: '60000' }, now);
    expect(m.t.map(t => new Date(t).toISOString().slice(11, 19))).toEqual(['10:00:30', '10:00:50', '10:01:20']);
    expect(m.mark).toEqual([cents(41), cents(43), '0']);
    expect(m.ask).toEqual([cents(42), cents(44), cents(45)]);
    await expect(marks(client, {}, now)).rejects.toThrow(/listingId/);
  });

  it('daily PnL is the change between local midnights, so the days add up to the lifetime change', async () => {
    await story();
    const utc = await daily(client, { strategyId: '1', mode: 'paper', days: '2' }, now);
    expect(utc.days.map(d => [d.date, d.pnl])).toEqual([['2026-10-05', cents(0)], ['2026-10-06', cents(144)]]);
    // In Pago Pago (UTC-11) the old session's day ended at 11:00 UTC on the 6th, with the strategy at 49c.
    const pagoPago = await daily(client, { strategyId: '1', mode: 'paper', days: '2', tz: 'Pacific/Pago_Pago' }, now);
    expect(pagoPago.days.map(d => [d.date, d.start, d.pnl])).toEqual([
      ['2026-10-05', '2026-10-05T11:00:00.000Z', cents(49)],
      ['2026-10-06', '2026-10-06T11:00:00.000Z', cents(95)],
    ]);
    const firm = await daily(client, { mode: 'paper', days: '2' }, now);
    expect(firm.days.map(d => d.pnl)).toEqual(utc.days.map(d => d.pnl));
    await expect(daily(client, { strategyId: '1' }, now)).rejects.toThrow(/mode/);
  });
});
