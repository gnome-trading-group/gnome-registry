import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { withTransaction } from '../lambda/endpoints/base';
import { gamertag, isLabel } from '../lambda/endpoints/gamertag';
import { bookAdjustment, parseAdjustment } from '../lambda/endpoints/ledger-adjustments';
import { writeBatch } from '../lambda/endpoints/ledger-batch';
import { buildOrdersQuery } from '../lambda/endpoints/ledger-orders';
import { buildPositionsQuery } from '../lambda/endpoints/ledger-positions';
import { attention } from '../lambda/endpoints/monitoring-attention';
import { summarize } from '../lambda/endpoints/pnl-summary';
import { walkLifetime } from '../lambda/endpoints/pnl-walk';
import { generateHaltUpsertQuery } from '../lambda/endpoints/risk-halts';
import { StrategySessionHandler } from '../lambda/endpoints/strategy-sessions';
import { AccountError, changeStatus, registerAccount, sessionAccounts } from '../lambda/endpoints/venue-accounts';
import { sweepSettlements } from '../lambda/sync/settlement-sweeper';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const UNIT = 1_000_000;
const CENT = 10_000_000;

// Polymarket Intl (exchange 2) with two wallets in its pool; listing 600 trades there. Kalshi (exchange 1) has one
// account; listing 500 trades there.
describeDb('venue accounts, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  let sessions: StrategySessionHandler;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE ledger.fill, ledger.position, ledger.order, ledger.mark, strategy.session_listing,
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.listing, sm.security, sm.exchange,
      account_master.venue_account, account_master.venue_account_history RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code)
      VALUES (1, 'Kalshi', 'us-east-1', 'mbp-10', 'KALSHI'), (2, 'Polymarket', 'eu-west-1', 'mbp-10', 'POLYMARKET_INTL')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'X', 4), (2, 'Y', 4)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id) VALUES (500, 1, 1), (600, 2, 2)`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb'), ('mm')`);
    sessions = new StrategySessionHandler();
    sessions.client = client;
  });

  async function register(exchangeId: number, label: string, status = 'ACTIVE'): Promise<number> {
    const row = await registerAccount(client, {
      exchangeId, label, tradingSecretName: `gnome/accounts/${label}/trading`, actor: 'ops@example.com',
      venueRef: exchangeId === 2 ? { funderAddress: `0x${label.length}` } : {},
    });
    if (status !== 'PROVISIONING') {
      await client.query(
        `UPDATE account_master.venue_account SET status = $2, activated_at = NOW() - make_interval(secs => $1)
         WHERE account_id = $1`, [row.account_id, status]);
    }
    return row.account_id;
  }

  async function create(sessionId: string, listings: number[], extra: Record<string, unknown> = {}, strategyId = 1) {
    return sessions.createOne(JSON.stringify({
      sessionId, strategyId, status: 'SUBMITTED', mode: 'live', config: { listings, ...extra },
    }));
  }

  async function boundLabel(sessionId: string, exchangeId: number): Promise<string | undefined> {
    return (await sessionAccounts(client, sessionId)).find(a => a.exchange_id === exchangeId)?.label;
  }

  async function stop(sessionId: string) {
    await client.query(`UPDATE strategy.session SET status = 'STOPPED' WHERE session_id = $1`, [sessionId]);
  }

  async function post(sessionId: string, events: Record<string, unknown>) {
    await withTransaction(client, (c) => writeBatch(c, sessionId, JSON.stringify({ sessionId, ...events })));
  }

  function fill(listingId: number, counter: number, net: number, version: number, extra: Record<string, unknown> = {}) {
    return {
      source: 'VENUE', listingId, clientOidCounter: counter, cumQtyAfter: Math.abs(net), side: 0, fillQty: Math.abs(net),
      fillPrice: 40 * CENT, fee: 0, eventTimeNs: 1, netQuantityAfter: net, totalCostAfter: Math.abs(net) * 400,
      realizedPnlAfter: 0, feesAfter: 0, positionVersion: version, ...extra,
    };
  }

  async function positions() {
    return (await client.query(
      'SELECT listing_id, account_id, net_quantity FROM ledger.position ORDER BY listing_id, account_id')).rows;
  }

  it('labels are gamer tags', () => {
    for (let i = 0; i < 200; i++) expect(isLabel(gamertag())).toBe(true);
    expect(isLabel('Sleepy-Otter-42')).toBe(false);
    expect(isLabel('arb-strategy')).toBe(false);
  });

  it('binds a live session to one account per exchange; a paper session to none', async () => {
    await register(1, 'steady-heron-01');
    await register(2, 'quiet-falcon-01');
    expect((await create('a', [500, 600])).statusCode).toBe(200);
    expect(await boundLabel('a', 1)).toBe('steady-heron-01');
    expect(await boundLabel('a', 2)).toBe('quiet-falcon-01');

    const paper = await sessions.createOne(JSON.stringify({
      sessionId: 'p', strategyId: 2, status: 'SUBMITTED', mode: 'paper', config: { listings: [600] },
    }));
    expect(paper.statusCode).toBe(200);
    expect(await sessionAccounts(client, 'p')).toEqual([]);
  });

  it('a pinned label wins; otherwise a strategy sticks to the account holding its positions; else the newest', async () => {
    await register(2, 'quiet-falcon-01');
    await register(2, 'sleepy-otter-42');
    expect((await create('a', [600])).statusCode).toBe(200);
    expect(await boundLabel('a', 2)).toBe('quiet-falcon-01');

    await post('a', { fills: [fill(600, 1, 5 * UNIT, 1)] });
    await stop('a');
    expect((await create('b', [600])).statusCode).toBe(200);
    expect(await boundLabel('b', 2)).toBe('quiet-falcon-01');
    await stop('b');

    expect((await create('c', [600], { accounts: { POLYMARKET_INTL: 'sleepy-otter-42' } })).statusCode).toBe(200);
    expect(await boundLabel('c', 2)).toBe('sleepy-otter-42');
    await stop('c');

    const missing = await create('d', [600], { accounts: { POLYMARKET_INTL: 'tiny-yak-07' } });
    expect(missing.statusCode).toBe(422);
  });

  it('never binds a draining account, and refuses when no account is ACTIVE', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await withTransaction(client, (c) => changeStatus(c, falcon, 'DRAINING', 'rotating'));
    const refused = await create('a', [600]);
    expect(refused.statusCode).toBe(422);
    expect(JSON.parse(refused.body).message).toMatch(/No ACTIVE POLYMARKET_INTL account/);
    expect((await client.query(`SELECT count(*)::int AS n FROM strategy.session`)).rows[0].n).toBe(0);
  });

  it('draining kills the sessions still trading on the account; retiring needs it empty', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    await post('a', { fills: [fill(600, 1, 5 * UNIT, 1)] });

    const drained = await withTransaction(client, (c) => changeStatus(c, falcon, 'DRAINING', 'rotating'),
      { actor: 'ops@example.com', reason: 'rotating' });
    expect(drained.haltedSessions).toEqual(['a']);
    const kill = (await client.query(
      `SELECT enabled FROM risk.policy WHERE policy_type = 'KILL_SWITCH' AND session_id = 'a'`)).rows[0];
    expect(kill.enabled).toBe(true);

    await expect(withTransaction(client, (c) => changeStatus(c, falcon, 'RETIRED', 'done')))
      .rejects.toThrow(/Sessions still run/);
    await stop('a');
    await expect(withTransaction(client, (c) => changeStatus(c, falcon, 'RETIRED', 'done')))
      .rejects.toThrow(/still holds 1 position/);
    await expect(withTransaction(client, (c) => changeStatus(c, falcon, 'PROVISIONING', 'x')))
      .rejects.toBeInstanceOf(AccountError);

    const history = (await client.query(
      'SELECT old_status, new_status, actor FROM account_master.venue_account_history ORDER BY history_id')).rows;
    expect(history.at(-1)).toEqual({ old_status: 'ACTIVE', new_status: 'DRAINING', actor: 'ops@example.com' });
  });

  it('a strategy moved to a new wallet holds the listing twice; each account keeps its own position', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    await post('a', { fills: [fill(600, 1, 5 * UNIT, 1)] });
    await stop('a');
    await withTransaction(client, (c) => changeStatus(c, falcon, 'DRAINING', 'rotating'));
    const otter = await register(2, 'sleepy-otter-42');

    expect((await create('b', [600])).statusCode).toBe(200);
    expect(await boundLabel('b', 2)).toBe('sleepy-otter-42');
    await post('b', { fills: [fill(600, 1, 2 * UNIT, 1)] });
    expect(await positions()).toEqual([
      { listing_id: 600, account_id: falcon, net_quantity: String(5 * UNIT) },
      { listing_id: 600, account_id: otter, net_quantity: String(2 * UNIT) },
    ]);

    const inherited = (await client.query(buildPositionsQuery({ strategyId: '1', mode: 'live', sessionId: 'b' }))).rows;
    expect(inherited.map(r => [r.account_id, r.net_quantity])).toEqual([[otter, String(2 * UNIT)]]);

    const summary = await summarize(client, { strategyId: '1', mode: 'live' }, new Date());
    expect((summary as { listings: { accountLabel: string; netQuantity: string }[] }).listings
      .map(l => [l.accountLabel, l.netQuantity])).toEqual([
      ['quiet-falcon-01', String(5 * UNIT)], ['sleepy-otter-42', String(2 * UNIT)],
    ]);
  });

  it('charts a listing held on two accounts as the sum of each account\'s own valuation', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    await post('a', { fills: [fill(600, 1, 5 * UNIT, 1)] });
    await stop('a');
    await withTransaction(client, (c) => changeStatus(c, falcon, 'DRAINING', 'rotating'));
    await register(2, 'sleepy-otter-42');
    await create('b', [600]);
    await post('b', { fills: [fill(600, 1, 2 * UNIT, 1, { fillPrice: 50 * CENT, totalCostAfter: 2 * UNIT * 500 })] });
    await client.query(`INSERT INTO ledger.mark (listing_id, ts, bid, ask, last_trade) VALUES (600, NOW(), $1, $1, 0)`,
      [60 * CENT]);

    const now = Date.now() + 1000;
    const walk = await walkLifetime(client, {
      mode: 'live', strategyId: 1, fromMs: now - 3_600_000, toMs: now, markStepMs: 1000, times: [now],
      sessionEvents: false,
    });
    // 5 bought at 40c and 2 at 50c, both now at 60c: 5 x 20c + 2 x 10c = $1.20.
    expect(walk.keys).toEqual([{ strategyId: 1, listingId: 600 }]);
    expect(walk.total).toEqual([120n * BigInt(CENT)]);
    expect(walk.keyNet[0]).toEqual([BigInt(7 * UNIT)]);
  });

  it('a gap flags only the session\'s own account\'s position', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    await post('a', { fills: [fill(600, 1, 5 * UNIT, 1)] });
    await stop('a');
    await withTransaction(client, (c) => changeStatus(c, falcon, 'DRAINING', 'rotating'));
    await register(2, 'sleepy-otter-42');
    await create('b', [600]);
    await post('b', { fills: [fill(600, 1, 2 * UNIT, 1), { ...fill(600, 0, 2 * UNIT, 1), source: 'GAP' }] });
    const review = (await client.query(
      'SELECT account_id, needs_review FROM ledger.position ORDER BY account_id')).rows;
    expect(review).toEqual([{ account_id: falcon, needs_review: false }, { account_id: falcon + 1, needs_review: true }]);
  });

  it('a recovery fill may only come from an order on the session\'s own account', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    await stop('a');
    await withTransaction(client, (c) => changeStatus(c, falcon, 'DRAINING', 'rotating'));
    await register(2, 'sleepy-otter-42');
    await create('b', [600]);
    await expect(post('b', {
      fills: [fill(600, 3, 1 * UNIT, 1, { source: 'RECOVERY', originSessionId: 'a' })],
    })).rejects.toThrow(/origin session of another strategy, mode or account/);
  });

  it('refuses to move a strategy off an account it still has open orders on', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    await post('a', { orderOpens: [{ clientOidCounter: 1, listingId: 600, exchangeId: 2, side: 0, price: 1, size: 5 }] });
    await stop('a');
    await withTransaction(client, (c) => changeStatus(c, falcon, 'DRAINING', 'rotating'));
    await register(2, 'sleepy-otter-42');
    const refused = await create('b', [600]);
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body).message).toMatch(/open order\(s\) on POLYMARKET_INTL account quiet-falcon-01/);
  });

  it('a starting session only sees and settles orders on its own account', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    await post('a', { orderOpens: [{ clientOidCounter: 1, listingId: 600, exchangeId: 2, side: 0, price: 1, size: 5 }] });
    await stop('a');
    await withTransaction(client, (c) => changeStatus(c, falcon, 'DRAINING', 'rotating'));
    await register(2, 'sleepy-otter-42');
    await client.query(`UPDATE ledger.order SET status = 'CLOSED'`);
    await create('b', [600]);
    await client.query(`UPDATE ledger.order SET status = 'OPEN'`);

    const seen = await client.query(buildOrdersQuery({ mode: 'live', listingIds: '600', sessionId: 'b' }));
    expect(seen.rowCount).toBe(0);
    await post('b', { orderRecoveries: [{ originSessionId: 'a', clientOidCounter: 1, listingId: 600 }] });
    expect((await client.query('SELECT status FROM ledger.order')).rows[0].status).toBe('OPEN');
  });

  it('a confirmed modify moves an open order\'s price and size', async () => {
    await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    const order = { clientOidCounter: 1, listingId: 600, exchangeId: 2 };
    await post('a', { orderOpens: [{ ...order, side: 0, price: 40 * CENT, size: 5 * UNIT }] });
    await post('a', { orderModifies: [{ ...order, price: 42 * CENT, size: 3 * UNIT, eventTimeNs: 2_000_000_000 }] });
    const row = (await client.query('SELECT price, size, modified_at FROM ledger.order')).rows[0];
    expect([row.price, row.size]).toEqual([String(42 * CENT), String(3 * UNIT)]);
    expect(row.modified_at).not.toBeNull();
  });

  it('settles a drained account\'s position while the strategy trades the listing elsewhere', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    await post('a', { fills: [fill(600, 1, 5 * UNIT, 1)] });
    await stop('a');
    await withTransaction(client, (c) => changeStatus(c, falcon, 'DRAINING', 'rotating'));
    await register(2, 'sleepy-otter-42');
    await create('b', [600]);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id) VALUES (1, 'Y?', 2, 'Y')`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label, settlement_price, settled_at)
      VALUES (1, 2, 'Yes', 1000000000, NOW())`);

    const result = await sweepSettlements(client);
    expect(result.booked).toBe(1);
    expect(await positions()).toEqual([{ listing_id: 600, account_id: falcon, net_quantity: '0' }]);
  });

  it('a live adjustment names its account, and only a session on that account blocks it', async () => {
    const falcon = await register(2, 'quiet-falcon-01');
    await create('a', [600]);
    const adjust = async (accountId?: number) => bookAdjustment(client, parseAdjustment(JSON.stringify({
      strategyId: 1, listingId: 600, mode: 'live', accountId, netQuantity: 0, totalCost: 0, reason: 'fix',
    })), 'ops@example.com');
    await expect(adjust()).rejects.toThrow(/accountId/);
    await expect(adjust(falcon)).rejects.toThrow(/holds this listing/);
    const otter = await register(2, 'sleepy-otter-42');
    await expect(adjust(otter)).resolves.toBeDefined();
  });

  it('halts a whole exchange or a strategy on it, idempotently, and shows the venue halt', async () => {
    const venue = await client.query(generateHaltUpsertQuery({ exchangeId: 2 }));
    const again = await client.query(generateHaltUpsertQuery({ exchangeId: 2 }));
    const strategy = await client.query(generateHaltUpsertQuery({ strategyId: 1, exchangeId: 2 }));
    expect(again.rows[0].policy_id).toBe(venue.rows[0].policy_id);
    expect(strategy.rows[0].policy_id).not.toBe(venue.rows[0].policy_id);
    const kinds = (await attention(client, 'live', new Date())).map(i => [i.kind, i.exchangeId]);
    expect(kinds).toEqual(expect.arrayContaining([['EXCHANGE_HALT', 2], ['STRATEGY_EXCHANGE_HALT', 2]]));
    expect(kinds.map(k => k[0])).not.toContain('GLOBAL_HALT');
  });
});
