import { Pool, PoolClient } from 'pg';
import { allowLiveLaunches, connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { withTransaction } from '../lambda/endpoints/base';
import { writeBatch } from '../lambda/endpoints/ledger-batch';
import { attention } from '../lambda/endpoints/monitoring-attention';
import { StrategySessionHandler } from '../lambda/endpoints/strategy-sessions';
import { recordSnapshot, SnapshotInput } from '../lambda/endpoints/treasury';
import { recordTransfer, summary, updateConfig } from '../lambda/endpoints/treasury-api';
import { registerAccount } from '../lambda/endpoints/venue-accounts';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const UNIT = 1_000_000;
const CENT = 10_000_000;
const DOLLAR = 1_000_000_000;
const MINUTE = 60_000;

// Kalshi (exchange 1): listing 500 trades market T's YES, 501 its NO. Polymarket Intl (exchange 2): listings 600 and
// 601 trade the two outcome tokens of condition 0xc1, identified as condition:token like the classifier writes them.
describeDb('treasury, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  let sessions: StrategySessionHandler;
  const opened = new Date(Date.now() - 60 * MINUTE);

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE ledger.fill, ledger.position, ledger.order, ledger.mark, strategy.session_listing,
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.event_contract, sm.event, sm.listing,
      sm.security, sm.exchange, account_master.venue_account, account_master.venue_account_history, treasury.transfer,
      treasury.balance_snapshot, treasury.recon_run, treasury.position_check RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'Kalshi', 'us-east-1', 'KALSHI'), (2, 'Polymarket', 'eu-west-1', 'POLYMARKET_INTL')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type)
      VALUES (1, 'T-YES', 4, 7), (2, 'T-NO', 4, 7), (3, 'A', 4, 8), (4, 'B', 4, 8)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id)
      VALUES (500, 1, 1, 'T:yes'), (501, 1, 2, 'T:no'), (600, 2, 3, '0xc1:111'), (601, 2, 4, '0xc1:222')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb'), ('mm')`);
    sessions = new StrategySessionHandler();
    sessions.client = client;
  });

  async function account(exchangeId: number, label: string): Promise<number> {
    const row = await registerAccount(client, {
      exchangeId, label, tradingSecretName: `gnome/accounts/${label}/trading`, actor: 'ops@example.com',
    });
    await client.query(`UPDATE account_master.venue_account SET status = 'ACTIVE', activated_at = NOW() WHERE account_id = $1`,
      [row.account_id]);
    return row.account_id;
  }

  async function open(accountId: number, dollars: number) {
    await recordTransfer(client, JSON.stringify({
      accountId, kind: 'OPENING', amount: dollars * DOLLAR, occurredAt: opened.toISOString(), reason: 'start',
    }), 'ops@example.com');
  }

  // ready: set up what a live launch needs first; false for the tests of those checks themselves.
  async function live(sessionId: string, listings: number[], strategyId = 1, ready = true) {
    if (ready) await allowLiveLaunches(client);
    const response = await sessions.createOne(JSON.stringify({
      sessionId, strategyId, status: 'RUNNING', mode: 'live', config: { listings },
    }));
    return response;
  }

  let counter = 0;
  async function trade(sessionId: string, listingId: number, side: 0 | 1, qty: number, cents: number, net: number,
    feeCents = 0) {
    counter++;
    await withTransaction(client, (c) => writeBatch(c, sessionId, JSON.stringify({
      sessionId,
      fills: [{
        source: 'VENUE', listingId, clientOidCounter: counter, cumQtyAfter: qty * UNIT, side, fillQty: qty * UNIT,
        fillPrice: Math.round(cents * CENT), fee: Math.round(feeCents * CENT), eventTimeNs: 1, netQuantityAfter: net * UNIT,
        totalCostAfter: Math.round(Math.abs(net) * cents * CENT), realizedPnlAfter: 0, feesAfter: feeCents * CENT,
        positionVersion: counter,
      }],
    })));
  }

  async function snapshot(accountId: number, cashCents: number, at: Date, extra: Partial<SnapshotInput> = {}) {
    return withTransaction(client, (c) => recordSnapshot(c, {
      accountId, source: 'POLLER', status: 'OK', cashTotal: Math.round(cashCents * CENT), cashAvailable: Math.round(cashCents * CENT),
      positions: [], ...extra,
    }, at));
  }

  async function policy(type: string, parameters: Record<string, number>, ids: Record<string, number> = {}) {
    await client.query(
      `INSERT INTO risk.policy (policy_type, strategy_id, exchange_id, listing_id, parameters)
       VALUES ($1, $2, $3, $4, $5)`,
      [type, ids.strategyId ?? null, ids.exchangeId ?? null, ids.listingId ?? null, JSON.stringify(parameters)]);
  }

  async function requiredPolicies(maxCapitalDollars: number, exchangeId: number, strategyId = 1) {
    await policy('MAX_COMMITTED_CAPITAL', { maxCapital: maxCapitalDollars * DOLLAR }, { strategyId, exchangeId });
    await policy('MAX_TOTAL_PNL_LOSS', { maxLoss: DOLLAR }, { strategyId });
    await policy('MAX_POSITION', { maxPosition: 100 * UNIT }, { strategyId });
    await policy('MAX_CONSECUTIVE_REJECTS', { maxRejects: 5 }, { strategyId });
  }

  it('says why an account can\'t be read, while keeping its last good balance', async () => {
    const heron = await account(1, 'steady-heron-01');
    const read = new Date(Date.now() - 60_000);
    await snapshot(heron, 5000, read);
    let [view] = (await summary(client, new Date())).accounts as any[];
    expect(view.lastReadingError).toBeNull();
    await snapshot(heron, 0, new Date(), { status: 'ERROR', error: 'This account has no read-only secret' });
    [view] = (await summary(client, new Date())).accounts as any[];
    expect(view.lastReadingError).toBe('This account has no read-only secret');
    expect(view.cashTotal).toBe(String(5000 * CENT));
    expect(new Date(view.snapshotAt).getTime()).toBe(read.getTime());
  });

  it('cash agrees when the venue holds the opening balance less what was bought and its fees', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    await live('a', [500]);
    await trade('a', 500, 0, 10, 40, 10, 1);
    const result = await snapshot(kalshi, 9599, new Date());
    expect(result.cashStatus).toBe('OK');
    expect(result.cashDiff).toBe('0');
  });

  it('Kalshi pays back a dollar per YES and NO held together, and charges one for a short', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    await live('a', [500, 501]);
    // 10 YES at 40c and 10 NO at 55c: the venue nets them at once and pays $10, so it holds $100.50.
    await trade('a', 500, 0, 10, 40, 10);
    await trade('a', 501, 0, 10, 55, 10);
    expect((await snapshot(kalshi, 10050, new Date(), {
      positions: [{ venueKey: 'T', quantity: 0 }],
    })).cashStatus).toBe('OK');
    expect((await client.query('SELECT status FROM treasury.position_check')).rows).toEqual([{ status: 'OK' }]);

    // Selling 15 YES leaves 5 short, which Kalshi books as buying 5 NO at 60c beside the 10 NO already held: the
    // 15 sold at 40c bring $6 and the pair term drops by $15, so the venue holds $91.50.
    await trade('a', 500, 1, 15, 40, -5);
    expect((await snapshot(kalshi, 9150, new Date(), {
      positions: [{ venueKey: 'T', quantity: -15 * UNIT }],
    })).cashStatus).toBe('OK');
  });

  it('a Polymarket US short reconciles once its held-back dollar counts as spent (Phase 0 numbers)', async () => {
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (3, 'Polymarket US', 'us-east-1', 'POLYMARKET_US')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type) VALUES (5, 'LAD', 4, 7)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id)
      VALUES (700, 3, 5, 'tec-mlb-nlchamp-2026-09-27-lad:long')`);
    const us = await account(3, 'brisk-badger-01');
    await recordTransfer(client, JSON.stringify({
      accountId: us, kind: 'OPENING', amount: '10382000000', occurredAt: opened.toISOString(), reason: 'start',
    }), 'ops@example.com');
    await live('u', [700]);
    // Sold 1 not held at $0.302 with a 1c fee: the venue's balance is $10.674 less the $1 it holds as margin.
    await trade('u', 700, 1, 1, 30.2, -1, 1);
    expect((await snapshot(us, 967.4, new Date(), {
      positions: [{ venueKey: 'tec-mlb-nlchamp-2026-09-27-lad', quantity: -UNIT }],
    })).cashStatus).toBe('OK');
    expect((await client.query(`SELECT status FROM treasury.position_check WHERE account_id = $1`, [us])).rows)
      .toEqual([{ status: 'OK' }]);
  });

  it('Polymarket US long and short listings net into one venue position, step by step (Phase 0 numbers)', async () => {
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (3, 'Polymarket US', 'us-east-1', 'POLYMARKET_US')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type) VALUES (5, 'LAD', 4, 7), (6, 'LAD-NO', 4, 7)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id)
      VALUES (700, 3, 5, 'tec-mlb-nlchamp-2026-09-27-lad:long'), (701, 3, 6, 'tec-mlb-nlchamp-2026-09-27-lad:short')`);
    const us = await account(3, 'brisk-badger-01');
    await recordTransfer(client, JSON.stringify({
      accountId: us, kind: 'OPENING', amount: '10352000000', occurredAt: opened.toISOString(), reason: 'start',
    }), 'ops@example.com');
    await live('u', [700, 701]);
    const lad = (quantity: number) => (quantity === 0 ? [] : [{ venueKey: 'tec-mlb-nlchamp-2026-09-27-lad', quantity: quantity * UNIT }]);
    let t = Date.now();
    const check = async (cents: number, venueNet: number) => {
      t += 10 * MINUTE;
      const result = await snapshot(us, cents, new Date(t), { positions: lad(venueNet) });
      const breaks = (await client.query(
        `SELECT venue_key, status FROM treasury.position_check WHERE account_id = $1 AND status <> 'OK'`, [us])).rows;
      return [result.cashStatus, breaks];
    };

    // Buy 1 long at 0.312, 1c fee.
    await trade('u', 700, 0, 1, 31.2, 1, 1);
    expect(await check(1003, 1)).toEqual(['OK', []]);
    // BUY_SHORT 1 at 0.306 in long terms is a NO bought at 0.694 on the short listing; the venue nets it against the
    // long and pays the dollar back.
    await trade('u', 701, 0, 1, 69.4, 1, 1);
    expect(await check(1032.6, 0)).toEqual(['OK', []]);
    // Another BUY_SHORT from flat: the venue is short 1, holding $1 back as margin (balance 10.622 less 1).
    await trade('u', 701, 0, 1, 69.4, 2, 1);
    expect(await check(962.2, -1)).toEqual(['OK', []]);
    // SELL_SHORT 1 at 0.312 in long terms sells the NO at 0.688.
    await trade('u', 701, 1, 1, 68.8, 1, 1);
    expect(await check(1030, 0)).toEqual(['OK', []]);
  });

  it('a difference becomes a break only when it persists minutes apart with nothing booked to explain it', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    const t0 = new Date();
    expect((await snapshot(kalshi, 9900, t0)).cashStatus).toBe('PENDING');
    expect((await snapshot(kalshi, 9900, new Date(t0.getTime() + MINUTE))).cashStatus).toBe('PENDING');
    expect((await snapshot(kalshi, 9900, new Date(t0.getTime() + 6 * MINUTE))).cashStatus).toBe('BREAK');
    const items = await attention(client, 'live', new Date(t0.getTime() + 6 * MINUTE));
    expect(items.find(i => i.kind === 'RECON_MISMATCH')?.accountLabel).toBe('steady-heron-01');

    await recordTransfer(client, JSON.stringify({
      accountId: kalshi, kind: 'WITHDRAWAL', amount: -1 * DOLLAR, occurredAt: t0.toISOString(), reason: 'paid out',
    }), 'ops@example.com');
    expect((await snapshot(kalshi, 9900, new Date(t0.getTime() + 7 * MINUTE))).cashStatus).toBe('OK');
  });

  it('a settled market the venue already paid counts before the sweeper books it', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    await live('a', [500]);
    await trade('a', 500, 0, 10, 40, 10);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id) VALUES (1, 'T?', 1, 'T')`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label, settlement_price, settled_at)
      VALUES (1, 1, 'Yes', $1, NOW())`, [DOLLAR]);
    expect((await snapshot(kalshi, 10600, new Date())).cashStatus).toBe('OK');
  });

  it('flags a position the venue holds differently, and one the ledger has never heard of', async () => {
    const pm = await account(2, 'quiet-falcon-01');
    await open(pm, 100);
    await live('a', [600]);
    await trade('a', 600, 0, 10, 40, 10);
    const t0 = new Date();
    const positions = [{ venueKey: '111', quantity: 7 * UNIT }, { venueKey: '999', quantity: 3 * UNIT }];
    await snapshot(pm, 9600, t0, { positions });
    await snapshot(pm, 9600, new Date(t0.getTime() + 6 * MINUTE), { positions });
    const checks = (await client.query(
      'SELECT venue_key, status, venue_qty, ledger_qty FROM treasury.position_check ORDER BY venue_key')).rows;
    expect(checks).toEqual([
      { venue_key: '111', status: 'BREAK', venue_qty: String(7 * UNIT), ledger_qty: String(10 * UNIT) },
      { venue_key: '999', status: 'UNKNOWN_VENUE_POSITION', venue_qty: String(3 * UNIT), ledger_qty: '0' },
    ]);
  });

  it('finds the listings behind a position the ledger never held, by the venue\'s key and nothing like it', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type)
      VALUES (5, 'TT-YES', 4, 7), (6, 'S-YES', 4, 7)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id)
      VALUES (502, 1, 5, 'TT:yes'), (503, 1, 6, 'S:yes')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id) VALUES (1, 'S?', 1, 'S')`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label, settlement_price, settled_at)
      VALUES (1, 6, 'Yes', $1, NOW())`, [DOLLAR]);
    const positions = [
      { venueKey: 'T', quantity: 4 * UNIT }, { venueKey: 'S', quantity: 2 * UNIT }, { venueKey: 'U', quantity: UNIT },
    ];
    await snapshot(kalshi, 10000, new Date(), { positions });
    const checks = (await client.query(
      'SELECT venue_key, listing_ids, status FROM treasury.position_check ORDER BY venue_key')).rows;
    // T is a market the ledger knows but holds nothing on (both sides, not TT's); S has settled, so cash checks it.
    expect(checks).toEqual([
      { venue_key: 'T', listing_ids: [500, 501], status: 'PENDING' },
      { venue_key: 'U', listing_ids: [], status: 'UNKNOWN_VENUE_POSITION' },
    ]);
  });

  it('clears a flagged position once it is closed outside the ledger, or its market resolves', async () => {
    const pm = await account(2, 'quiet-falcon-01');
    await open(pm, 100);
    const t0 = Date.now() - 30 * MINUTE;
    const at = (minutes: number) => new Date(t0 + minutes * MINUTE);
    const held = [{ venueKey: '222', quantity: 3 * UNIT }, { venueKey: '999', quantity: 2 * UNIT }];
    await snapshot(pm, 10000, at(0), { positions: held });
    await snapshot(pm, 10000, at(6), { positions: held });
    const statuses = async () => (await client.query(
      'SELECT venue_key, status FROM treasury.position_check ORDER BY venue_key')).rows;
    expect(await statuses()).toEqual([
      { venue_key: '222', status: 'BREAK' }, { venue_key: '999', status: 'UNKNOWN_VENUE_POSITION' },
    ]);
    // Sold by hand on the venue: neither side holds anything now.
    await snapshot(pm, 10000, at(12), { positions: [] });
    expect(await statuses()).toEqual([{ venue_key: '222', status: 'OK' }, { venue_key: '999', status: 'OK' }]);

    await snapshot(pm, 10000, at(18), { positions: held });
    await snapshot(pm, 10000, at(24), { positions: held });
    // Resolved and redeemable: settlement is cash's to check, so the position check lets it go.
    await snapshot(pm, 10000, at(30), { positions: [{ venueKey: '222', quantity: 3 * UNIT, redeemable: true }] });
    expect(await statuses()).toEqual([{ venue_key: '999', status: 'OK' }]);
  });

  it('reconciles each wallet in a pool on its own', async () => {
    const falcon = await account(2, 'quiet-falcon-01');
    const otter = await account(2, 'sleepy-otter-42');
    await open(falcon, 50);
    await open(otter, 50);
    await live('a', [600], 1);
    await live('b', [601], 2);
    expect(await (await client.query(
      `SELECT array_agg(account_id ORDER BY session_id) AS a FROM account_master.session_venue_account`)).rows[0].a)
      .toEqual([falcon, otter]);
    await trade('a', 600, 0, 10, 40, 10);
    await trade('b', 601, 0, 10, 30, 10);
    // Auto-pick spread the sessions by free capital, the first budget counting against the first wallet: each wallet
    // holds its $50 less what its own session spent.
    expect((await snapshot(falcon, 4600, new Date())).cashStatus).toBe('OK');
    expect((await snapshot(otter, 4700, new Date())).cashStatus).toBe('OK');
  });

  it('refuses a transfer whose sign contradicts its kind', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await expect(recordTransfer(client, JSON.stringify({
      accountId: kalshi, kind: 'WITHDRAWAL', amount: DOLLAR, reason: 'oops',
    }), 'ops@example.com')).rejects.toThrow(/wrong sign/);
  });

  it('a live session needs every required policy and the money behind its budget', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    await updateConfig(client, JSON.stringify({ accountId: kalshi, minBuffer: 10 * DOLLAR }), 'ops@example.com');

    const uncovered = await live('a', [500], 1, false);
    expect(uncovered.statusCode).toBe(422);
    expect(JSON.parse(uncovered.body).message).toMatch(/MAX_COMMITTED_CAPITAL on listing 500/);

    await requiredPolicies(50, 1);
    const stale = await live('a', [500], 1, false);
    expect(stale.statusCode).toBe(422);
    expect(JSON.parse(stale.body).message).toMatch(/no recent balance snapshot/);

    await snapshot(kalshi, 10000, new Date());
    expect((await live('a', [500], 1, false)).statusCode).toBe(200);
    // $100 held, $10 kept free, $50 allocated: another $50 doesn't fit.
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('third')`);
    await requiredPolicies(50, 1, 3);
    const full = await live('b', [501], 3, false);
    expect(full.statusCode).toBe(422);
    expect(JSON.parse(full.body).message).toMatch(/can't take a further \$50\.00/);

    const items = await attention(client, 'live', new Date());
    expect(items.map(i => i.kind)).not.toContain('ALLOCATION_EXCEEDS_BALANCE');
  });

  it('auto-pick takes the wallet with the most free capital that fits', async () => {
    const falcon = await account(2, 'quiet-falcon-01');
    const otter = await account(2, 'sleepy-otter-42');
    await open(falcon, 100);
    await open(otter, 30);
    await snapshot(falcon, 10000, new Date());
    await snapshot(otter, 3000, new Date());
    await requiredPolicies(40, 2);
    expect((await live('a', [600], 1, false)).statusCode).toBe(200);
    const bound = (await client.query(`SELECT account_id FROM account_master.session_venue_account`)).rows[0];
    expect(bound.account_id).toBe(falcon);

    const view = await summary(client, new Date());
    const row = view.accounts.find(a => (a as Record<string, unknown>).accountId === falcon) as Record<string, unknown>;
    expect([row.allocated, row.free]).toEqual([String(40 * DOLLAR), String(60 * DOLLAR)]);
  });

  it('flags a Kalshi shard below its threshold even when the account total is healthy', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await updateConfig(client, JSON.stringify({ accountId: kalshi, partitionLowThresholds: { 3: 20 * DOLLAR } }),
      'ops@example.com');
    // The demo account's real split: most cash on shard 0, none on shard 3.
    await snapshot(kalshi, 9930, new Date(), {
      cashByPartition: { 0: '89309900000', 1: '0', 2: '10000000000', 3: '0' },
    });
    const items = (await attention(client, 'live', new Date())).filter(i => i.kind === 'SHARD_BALANCE_LOW');
    expect(items.map(i => i.title)).toEqual(['steady-heron-01 shard 3 is low on cash']);
    const view = await summary(client, new Date());
    expect((view.accounts[0] as Record<string, any>).cashByPartition['0']).toBe('89309900000');
    await expect(updateConfig(client, JSON.stringify({ accountId: kalshi, partitionLowThresholds: { x: 1 } }),
      'ops@example.com')).rejects.toThrow(/partition numbers/);
  });

  it('flags a draining wallet that is empty as ready to retire', async () => {
    const falcon = await account(2, 'quiet-falcon-01');
    await client.query(`UPDATE account_master.venue_account SET status = 'DRAINING' WHERE account_id = $1`, [falcon]);
    await snapshot(falcon, 0, new Date());
    const items = await attention(client, 'live', new Date());
    expect(items.find(i => i.kind === 'ACCOUNT_READY_TO_RETIRE')?.accountId).toBe(falcon);
  });
});
