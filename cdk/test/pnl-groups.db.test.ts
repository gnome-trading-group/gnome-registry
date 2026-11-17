import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { groups } from '../lambda/endpoints/pnl-groups';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const CENT = 10_000_000;
const UNIT = 1_000_000;
const cents = (value: number) => String(value * CENT);
const now = new Date('2026-10-07T12:00:00Z');

describeDb('positions by risk group against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE ledger.fill, ledger.position, ledger.order, ledger.mark, strategy.session_listing,
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.contract_relationship, sm.event_contract,
      sm.event, sm.listing_spec, sm.listing, sm.security, sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code) VALUES
      (1, 'K', 'us-east-1', 'KALSHI'), (2, 'P', 'us-east-1', 'POLYMARKET_INTL')`);
    // A yes/no market, a three-way event, and a perp.
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type) VALUES
      (1, 'T-YES', 0, 7), (2, 'T-NO', 0, 7), (3, 'M-A', 0, 8), (4, 'M-B', 0, 8), (5, 'M-C', 0, 8), (6, 'BTC-PERP', 0, 1)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id, exchange_security_symbol)
      VALUES (500, 1, 1, 'KX-T:yes', 'T Yes'), (501, 1, 2, 'KX-T:no', 'T No'), (502, 1, 3, 'KX-M-A', 'M A'),
             (503, 1, 4, 'KX-M-B', 'M B'), (504, 1, 5, 'KX-M-C', 'M C'), (505, 1, 6, 'BTC', 'BTC perp')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id, expiry) VALUES
      (10, 'Will T happen?', 1, 'KX-T', '2026-10-08T00:00:00Z'), (20, 'Who wins M?', 1, 'KX-M', '2026-10-09T00:00:00Z')`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label) VALUES
      (10, 1, 'Yes'), (10, 2, 'No'), (20, 3, 'A'), (20, 4, 'B'), (20, 5, 'C')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb'), ('maker')`);
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config) VALUES
      ('s', 1, 'STOPPED', 'paper', '{}'), ('m', 2, 'STOPPED', 'paper', '{}')`);
  });

  async function hold(listingId: number, net: number, cost: number, realized = 0, session = 's') {
    await client.query(`INSERT INTO ledger.fill (source, session_id, strategy_id, listing_id, mode, client_oid_counter,
        cum_qty_after, net_quantity_after, total_cost_after, realized_pnl_after, fees_after, position_version, recorded_at)
      VALUES ('VENUE', $5::text, (SELECT strategy_id FROM strategy.session WHERE session_id = $5::text), $1::int, 'paper',
        $1::int, 1, $2, $3, $4, 0, 1, '2026-10-07T11:00:00Z')`,
    [listingId, net * UNIT, cost * CENT, realized * CENT, session]);
  }

  async function mark(listingId: number, mid: number) {
    await client.query(`INSERT INTO ledger.mark VALUES ($1, '2026-10-07T11:30:00Z', $2, $2, 0)`, [listingId, mid * CENT]);
  }

  // A match on two venues: Kalshi "Will Alpha win?" yes/no, and Polymarket Intl's Alpha/Beta tokens; Alpha ≡ yes.
  async function match() {
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type) VALUES
      (11, 'KA-YES', 0, 7), (12, 'KA-NO', 0, 7), (13, 'P-ALPHA', 0, 7), (14, 'P-BETA', 0, 7)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id, exchange_security_symbol)
      VALUES (511, 1, 11, 'KX-A:yes', 'Alpha Yes'), (512, 1, 12, 'KX-A:no', 'Alpha No'),
             (513, 2, 13, 'cond:alpha', 'Alpha'), (514, 2, 14, 'cond:beta', 'Beta')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id, expiry) VALUES
      (40, 'Will Alpha win?', 1, 'KX-A', '2026-10-07T20:00:00Z'), (41, 'Alpha vs Beta', 2, 'cond', '2026-10-07T20:00:00Z')`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label) VALUES
      (40, 11, 'Yes'), (40, 12, 'No'), (41, 13, 'Alpha'), (41, 14, 'Beta')`);
    await client.query(`INSERT INTO sm.contract_relationship (security_id_a, security_id_b, relationship_type, method)
      VALUES (11, 13, 'EQUIVALENT', 'derived')`);
  }

  it('values each outcome of a yes/no market and a three-way event, and leaves the perp out of both', async () => {
    await hold(500, 10, 400);
    await mark(500, 45);
    await hold(501, 4, 220);
    await mark(501, 54);
    await hold(502, 5, 150);
    await mark(502, 30);
    await hold(503, -2, 100);
    await mark(503, 50);
    await hold(505, 1, 10_000, 3);

    const result = await groups(client, { strategyId: '1', mode: 'paper' }, now);
    expect(result.groups.map(g => g.title)).toEqual(['Will T happen?', 'Who wins M?']);
    const [yesNo, threeWay] = result.groups;
    // Now: YES up 10 x 5c, NO down 4 x 1c. If Yes: YES pays $10 on $4 cost, NO loses its $2.20.
    expect(yesNo.current).toBe(cents(46));
    expect(yesNo.worlds.map(w => [w.label, w.pnl, w.change, w.paying])).toEqual([
      ['Not: Will T happen?', cents(-220), cents(-266), String(4 * UNIT)],
      ['Will T happen?', cents(380), cents(334), String(10 * UNIT)],
    ]);
    expect([yesNo.locked, yesNo.worst, yesNo.best, yesNo.gap, yesNo.void]).toEqual([cents(-220), cents(-220), cents(380), String(6 * UNIT), null]);

    // Long 5 A at 30c, short 2 B at 50c; C (not held) winning is "none of these".
    expect(threeWay.worlds.map(w => [w.label, w.pnl])).toEqual([['B', cents(-250)], ['Not: A · Not: B', cents(-50)], ['A', cents(450)]]);
    expect(threeWay.legs.map(l => [l.outcome, l.held.netQuantity])).toEqual([['A', String(5 * UNIT)], ['B', String(-2 * UNIT)]]);
    expect(result.other.map(o => [o.listingId, o.total])).toEqual([[505, cents(3)]]);
  });

  it('joins a match across venues, locks the pair, and prices the void the venues settle differently', async () => {
    await match();
    // NO on Alpha at Kalshi for 45c, Alpha at Polymarket for 50c: $0.95 a pair, so 50c locked on 10 pairs.
    await hold(512, 10, 450);
    await mark(512, 40);
    await hold(513, 10, 500);
    await mark(513, 50);

    const [group] = (await groups(client, { strategyId: '1', mode: 'paper' }, now)).groups;
    expect(group.legs.map(l => l.held.listingId)).toEqual([512, 513]);
    expect(group.worlds.map(w => [w.label, w.pnl])).toEqual([['Alpha', cents(50)], ['Not: Alpha', cents(50)]]);
    expect([group.locked, group.gap]).toEqual([cents(50), '0']);
    // Voided: Polymarket pays 50c (its 10 at 50c break even), Kalshi the last fair price (the 40c mark: 10 x -5c).
    expect(group.void).toEqual({ pnl: cents(-50), change: cents(0) });
    expect(group.worst).toBe(cents(-50));
  });

  it('nets a ladder of thresholds: n strikes, n + 1 worlds', async () => {
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type) VALUES
      (21, 'S50', 0, 7), (22, 'S50N', 0, 7), (23, 'S60', 0, 7), (24, 'S60N', 0, 7)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id)
      VALUES (521, 1, 21, 'RT-50:yes'), (522, 1, 22, 'RT-50:no'), (523, 1, 23, 'RT-60:yes'), (524, 1, 24, 'RT-60:no')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id) VALUES
      (50, 'Score above 50?', 1, 'RT-50'), (60, 'Score above 60?', 1, 'RT-60')`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label) VALUES
      (50, 21, 'Yes'), (50, 22, 'No'), (60, 23, 'Yes'), (60, 24, 'No')`);
    await client.query(`INSERT INTO sm.contract_relationship (security_id_a, security_id_b, relationship_type, method)
      VALUES (23, 21, 'IMPLIES', 'derived')`);
    // Long 10 above 50 at 70c, long 10 NOT above 60 at 50c.
    await hold(521, 10, 700);
    await hold(524, 10, 500);

    const [group] = (await groups(client, { strategyId: '1', mode: 'paper' }, now)).groups;
    expect(group.worlds.map(w => [w.label, w.pnl])).toEqual([
      ['Not: Score above 50?', cents(-200)],
      ['Score above 60?', cents(-200)],
      ['Score above 50? · Not: Score above 60?', cents(800)],
    ]);
  });

  it('nets the firm across strategies: one strategy long Alpha, another short it on the other venue', async () => {
    await match();
    await hold(513, 10, 500);
    await hold(511, -10, 550, 0, 'm');

    const firm = await groups(client, { firm: 'true', mode: 'paper' }, now);
    expect(firm.groups).toHaveLength(1);
    expect(firm.groups[0].strategyIds).toEqual([1, 2]);
    // Bought Alpha at 50c, sold its equivalent at 55c: 50c whichever wins.
    expect(firm.groups[0].worlds.map(w => w.pnl)).toEqual([cents(50), cents(50)]);
    await expect(groups(client, { firm: 'true', mode: 'paper', status: 'history' }, now)).rejects.toThrow('not firm');
  });

  it('returns groups still held by default, and pages the flat ones most recently resolved first', async () => {
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type) VALUES (7, 'L-YES', 0, 7)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id, exchange_security_symbol)
      VALUES (506, 1, 7, 'KX-L:yes', 'L Yes')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id, expiry) VALUES
      (30, 'Will L happen?', 1, 'KX-L', '2026-10-07T09:00:00Z')`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label) VALUES (30, 7, 'Yes')`);
    await client.query(`UPDATE sm.event SET resolved = true, resolved_at = '2026-10-06T10:00:00Z' WHERE event_id = 10`);
    await hold(502, 5, 150);
    await hold(500, 0, 0, 5);
    await hold(506, 0, 0, -2);
    await hold(505, 0, 0, 3);
    const params = { strategyId: '1', mode: 'paper' };

    const active = await groups(client, params, now);
    expect(active.groups.map(g => g.title)).toEqual(['Who wins M?']);
    expect(active.other).toEqual([]);
    expect([active.counts, active.nextBefore]).toEqual([{ active: 1, flatContracts: 2, flatOther: 1 }, null]);

    const history = (extra: Record<string, string>) => groups(client, { ...params, status: 'history', ...extra }, now);
    const first = await history({ limit: '1' });
    expect(first.groups.map(g => [g.title, g.current])).toEqual([['Will L happen?', cents(-2)]]);
    expect(first.other.map(o => [o.listingId, o.total])).toEqual([[505, cents(3)]]);
    const second = await history({ limit: '1', before: first.nextBefore as string });
    expect([second.groups.map(g => g.title), second.other]).toEqual([['Will T happen?'], []]);
    const third = await history({ limit: '1', before: second.nextBefore as string });
    expect([third.groups, third.nextBefore]).toEqual([[], null]);
    expect((await history({})).groups.map(g => g.title)).toEqual(['Will L happen?', 'Will T happen?']);

    await expect(history({ before: '12' })).rejects.toThrow('before must be');
    await expect(history({ limit: '201' })).rejects.toThrow('limit must be 1 to 200');
    await expect(groups(client, { ...params, status: 'open' }, now)).rejects.toThrow('status must be');
  });

  it('a strategy that has traded thousands of contracts answers with the ones it holds and a page of the rest', async () => {
    // 3,000 one-contract events, each traded once; 10 still held.
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type)
      SELECT id, 'S' || id, 0, 7 FROM generate_series(1000, 3999) id`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id)
      SELECT id, 1, id, 'KX-' || id || ':yes' FROM generate_series(1000, 3999) id`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id, expiry)
      SELECT id, 'Event ' || id, 1, 'KX-' || id, '2026-09-01T00:00:00Z'::timestamptz + id * interval '1 minute'
      FROM generate_series(1000, 3999) id`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label)
      SELECT id, id, 'Yes' FROM generate_series(1000, 3999) id`);
    await client.query(`INSERT INTO ledger.fill (source, session_id, strategy_id, listing_id, mode, client_oid_counter,
        cum_qty_after, net_quantity_after, total_cost_after, realized_pnl_after, fees_after, position_version, recorded_at)
      SELECT 'VENUE', 's', 1, id, 'paper', id, 1, CASE WHEN id < 1010 THEN $1 ELSE 0 END,
        CASE WHEN id < 1010 THEN $2 ELSE 0 END, $3, 0, 1, '2026-10-01T00:00:00Z'
      FROM generate_series(1000, 3999) id`, [UNIT, 50 * CENT, CENT]);

    const started = Date.now();
    const active = await groups(client, { strategyId: '1', mode: 'paper' }, now);
    const history = await groups(client, { strategyId: '1', mode: 'paper', status: 'history' }, now);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect([active.groups.length, active.counts]).toEqual([10, { active: 10, flatContracts: 2990, flatOther: 0 }]);
    expect([history.groups.length, history.groups[0].title, history.groups[49].title]).toEqual([50, 'Event 3999', 'Event 3950']);
    expect(JSON.stringify(history).length).toBeLessThan(150_000);
    const next = await groups(client, { strategyId: '1', mode: 'paper', status: 'history', before: history.nextBefore as string }, now);
    expect(next.groups[0].title).toBe('Event 3949');
  }, 60_000);

  it("values a session's worlds as session PnL, leaving out what its inherited inventory was worth at the start", async () => {
    // Session s bought 10 YES at 40c and stopped; session t started at 12:00, inheriting them, valued at 50c then.
    await hold(500, 10, 400);
    await client.query(`UPDATE strategy.session SET started_at = '2026-10-07T10:00:00Z', stopped_at = '2026-10-07T11:45:00Z'`);
    await client.query(`INSERT INTO ledger.mark VALUES (500, '2026-10-07T11:30:00Z', $1, $1, 0), (500, '2026-10-07T12:30:00Z', $2, $2, 0)`,
      [50 * CENT, 45 * CENT]);
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at)
      VALUES ('t', 1, 'RUNNING', 'paper', '{}', '2026-10-07T12:00:00Z')`);
    await client.query(`INSERT INTO strategy.session_listing VALUES ('t', 1, 'paper', 500, true)`);

    const [group] = (await groups(client, { sessionId: 't' }, new Date('2026-10-07T13:00:00Z'))).groups;
    // Now 45c: session PnL 10 x (45 - 50) = -50c. If Yes: 10 x (100 - 50) = +500c; if No: 10 x (0 - 50) = -500c.
    expect(group.current).toBe(cents(-50));
    expect(group.worlds.map(x => [x.label, x.pnl])).toEqual([['Not: Will T happen?', cents(-500)], ['Will T happen?', cents(500)]]);
    expect(group.legs[0].held.total).toBe(cents(-50));
    await expect(groups(client, {}, now)).rejects.toThrow(/strategyId, sessionId or firm=true/);
  });
});
