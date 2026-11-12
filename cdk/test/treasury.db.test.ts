import { Pool, PoolClient } from 'pg';
import { allowLiveLaunches, connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { withTransaction } from '../lambda/endpoints/base';
import { writeBatch } from '../lambda/endpoints/ledger-batch';
import { attention } from '../lambda/endpoints/monitoring-attention';
import { StrategySessionHandler } from '../lambda/endpoints/strategy-sessions';
import { recordSnapshot, SnapshotInput } from '../lambda/endpoints/treasury';
import { pollTargets, recordTransfer, summary, transfers, updateConfig } from '../lambda/endpoints/treasury-api';
import { CreditInput, parseSnapshot } from '../lambda/endpoints/treasury';
import { allocatePending } from '../lambda/endpoints/treasury-allocate';
import { summarize } from '../lambda/endpoints/pnl-summary';
import { payoutDay } from '../lambda/sync/venues/types';
import { series } from '../lambda/endpoints/pnl-series';
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
      accountId: kalshi, kind: 'CORRECTION', amount: -1 * DOLLAR, occurredAt: t0.toISOString(), reason: 'paid out',
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
      accountId: kalshi, kind: 'INTEREST', amount: -DOLLAR, reason: 'oops',
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

  it('refuses a launch onto a Kalshi shard without the cash for it, though the account total covers it', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    await client.query(`UPDATE sm.listing SET venue_partition = '3' WHERE listing_id = 501`);
    await requiredPolicies(30, 1);
    await requiredPolicies(30, 1, 2);
    const split = { cashByPartition: { 0: String(80 * DOLLAR), 3: String(20 * DOLLAR) } };

    await snapshot(kalshi, 10000, new Date(), split);
    const unknown = await live('a', [500], 1, false);
    expect(unknown.statusCode).toBe(422);
    expect(JSON.parse(unknown.body).message).toMatch(/listing\(s\) 500 have no known shard/);

    await client.query(`UPDATE sm.listing SET venue_partition = '0' WHERE listing_id = 500`);
    const short = await live('b', [501], 2, false);
    expect(short.statusCode).toBe(422);
    expect(JSON.parse(short.body).message)
      .toMatch(/holds \$20\.00 on shard 3 with \$0\.00 allocated there, so it can't take a further \$30\.00/);
    expect((await live('c', [500], 1, false)).statusCode).toBe(200);

    const view = await summary(client, new Date());
    const partitions = (view.accounts[0] as Record<string, any>).partitions;
    expect(partitions['0']).toMatchObject({ cash: String(80 * DOLLAR), allocated: String(30 * DOLLAR) });
    expect(partitions['3']).toMatchObject({ cash: String(20 * DOLLAR), allocated: '0' });
  });

  it('flags a shard live sessions trade with less behind it than their budgets, with no threshold set', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    await client.query(`UPDATE sm.listing SET venue_partition = '0' WHERE listing_id IN (500, 501)`);
    await requiredPolicies(60, 1);
    await snapshot(kalshi, 10000, new Date(), { cashByPartition: { 0: String(100 * DOLLAR), 3: '0' } });
    expect((await live('a', [500], 1, false)).statusCode).toBe(200);
    expect((await attention(client, 'live', new Date())).filter(i => i.kind === 'SHARD_BALANCE_LOW')).toEqual([]);

    // Cash moved off shard 0 after the launch.
    await snapshot(kalshi, 10000, new Date(), { cashByPartition: { 0: String(40 * DOLLAR), 3: String(60 * DOLLAR) } });
    const items = (await attention(client, 'live', new Date())).filter(i => i.kind === 'SHARD_BALANCE_LOW');
    expect(items.map(i => [i.title, i.detail])).toEqual([[
      'steady-heron-01 shard 0 is low on cash',
      '$40.00 on shard 0, behind $60.00 of live budgets ($40.00 with positions at cost); move cash onto it',
    ]]);
  });

  it('raises orders refused for insufficient funds by the shard they were on', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    await client.query(`UPDATE sm.listing SET venue_partition = '3' WHERE listing_id = 501`);
    await requiredPolicies(10, 1);
    await snapshot(kalshi, 10000, new Date(), { cashByPartition: { 0: String(100 * DOLLAR), 3: '0' } });
    await client.query(`UPDATE sm.listing SET venue_partition = '0' WHERE listing_id = 500`);
    expect((await live('a', [500, 501], 1, false)).statusCode).toBe(422);
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config)
      VALUES ('s', 1, 'RUNNING', 'live', '{}')`);
    const now = new Date();
    const closings = [now, new Date(now.getTime() - 5 * MINUTE), new Date(now.getTime() - 30 * MINUTE)];
    for (const [counter, closedAt] of closings.entries()) {
      await client.query(
        `INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id, mode, status,
           closed_at, close_state, reject_reason, account_id)
         VALUES ('s', $1, 1, 501, 1, 'live', 'CLOSED', $2, 'REJECTED', 'INSUFFICIENT_FUNDS', $3)`,
        [counter, closedAt, kalshi]);
    }
    const items = (await attention(client, 'live', now)).filter(i => i.kind === 'SHARD_FUNDS_REJECTED');
    expect(items.map(i => [i.title, i.detail])).toEqual([[
      'steady-heron-01 shard 3 is refusing orders for want of cash',
      '2 order(s) refused for insufficient funds in 15 minutes (arb); move cash onto shard 3',
    ]]);
  });

  it('takes shard rebalancing targets that add up to 100, or none, and flags Kalshi not matching them', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    const set = (body: Record<string, unknown>) =>
      updateConfig(client, JSON.stringify({ accountId: kalshi, ...body }), 'ops@example.com');
    await expect(set({ partitionTargets: { 0: 80, 3: 10 } })).rejects.toThrow(/add up to 100.*not 90/);
    await expect(set({ partitionTargets: { x: 100 } })).rejects.toThrow(/shard numbers/);
    await expect(set({ rebalanceReservation: 'all' })).rejects.toThrow(/none, max or sum/);
    await set({ partitionTargets: { 0: 80, 3: 20 }, rebalanceReservation: 'max' });
    const [target] = await pollTargets(client);
    expect([target.partition_targets, target.rebalance_reservation]).toEqual([{ 0: 80, 3: 20 }, 'max']);

    const drift = async () => (await attention(client, 'live', new Date())).filter(i => i.kind === 'REBALANCE_DRIFT');
    const cash = { cashByPartition: { 0: String(80 * DOLLAR), 3: String(20 * DOLLAR) } };
    await snapshot(kalshi, 10000, new Date(), { ...cash, rebalanceTargets: {
      allocations: {}, restingMarginReservation: 'sum', error: 'setting the targets failed: 403 forbidden',
    } });
    expect((await drift()).map(i => i.detail)).toEqual(['setting the targets failed: 403 forbidden']);
    await snapshot(kalshi, 10000, new Date(), { ...cash, rebalanceTargets: {
      allocations: { 0: 80, 2: 0, 3: 20 }, restingMarginReservation: 'max',
    } });
    expect(await drift()).toEqual([]);
    await set({ partitionTargets: { 0: 100 } });
    expect((await drift()).map(i => i.detail)).toEqual(['Kalshi is set to shard 0 80%, shard 3 20%, not shard 0 100%']);
  });

  it('refuses a launch onto a shard rebalancing sweeps, and flags one live sessions already trade', async () => {
    const kalshi = await account(1, 'steady-heron-01');
    await open(kalshi, 100);
    await client.query(`UPDATE sm.listing SET venue_partition = '0' WHERE listing_id = 500`);
    await client.query(`UPDATE sm.listing SET venue_partition = '3' WHERE listing_id = 501`);
    await requiredPolicies(10, 1);
    await requiredPolicies(10, 1, 2);
    await snapshot(kalshi, 10000, new Date(), {
      cashByPartition: { 0: String(80 * DOLLAR), 3: String(20 * DOLLAR) },
      rebalanceTargets: { allocations: { 0: 100 }, restingMarginReservation: 'sum' },
    });
    const swept = await live('a', [501], 2, false);
    expect(swept.statusCode).toBe(422);
    expect(JSON.parse(swept.body).message).toMatch(/rebalances its cash off shard 3, which this session trades/);
    expect((await live('b', [500], 1, false)).statusCode).toBe(200);

    const untargeted = async () => (await attention(client, 'live', new Date())).filter(i => i.kind === 'SHARD_UNTARGETED');
    expect(await untargeted()).toEqual([]);
    await updateConfig(client, JSON.stringify({ accountId: kalshi, partitionTargets: { 3: 100 } }), 'ops@example.com');
    expect((await untargeted()).map(i => i.title))
      .toEqual(['steady-heron-01 rebalances cash off shard 0, which live sessions trade']);
  });

  it('flags a draining wallet that is empty as ready to retire', async () => {
    const falcon = await account(2, 'quiet-falcon-01');
    await client.query(`UPDATE account_master.venue_account SET status = 'DRAINING' WHERE account_id = $1`, [falcon]);
    await snapshot(falcon, 0, new Date());
    const items = await attention(client, 'live', new Date());
    expect(items.find(i => i.kind === 'ACCOUNT_READY_TO_RETIRE')?.accountId).toBe(falcon);
  });
  describe('venue credits', () => {
    const credit = (externalRef: string, cents: number, at: Date, fields: Partial<CreditInput> = {}): CreditInput => ({
      externalRef, kind: 'REWARD', program: 'LIQUIDITY', amount: String(Math.round(cents * CENT)), occurredAt: at.toISOString(),
      venueMarket: null, venueType: 'REWARD', reverses: null, ...fields,
    });

    it('books each credit once, before reconciling, so the cash it added is explained in the same run', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      const paid = new Date(Date.now() - 2 * MINUTE);
      const credits = [credit('kalshi:credit:1', 250, paid), credit('kalshi:credit:2', 75, paid, { kind: 'INTEREST', program: 'INTEREST' })];
      const first = await snapshot(heron, 10_325, new Date(), { credits });
      expect(first).toMatchObject({ cashStatus: 'OK', creditsBooked: 2 });
      const again = await snapshot(heron, 10_325, new Date(), { credits });
      expect(again).toMatchObject({ cashStatus: 'OK', creditsBooked: 0 });
      const rows = await transfers(client, { accountId: heron });
      expect(rows.filter(r => r.actor === 'venue-poller').map(r => [r.external_ref, r.kind, r.program, r.allocation_state]))
        .toEqual(expect.arrayContaining([
          // A Kalshi liquidity credit naming no market can't be given to a strategy.
          ['kalshi:credit:1', 'REWARD', 'LIQUIDITY', 'FAILED'],
          ['kalshi:credit:2', 'INTEREST', 'INTEREST', null],
        ]));
    });

    it('leaves out credits from before reconciliation started, and a reversal of something never booked', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      const before = new Date(opened.getTime() - MINUTE);
      const after = new Date(opened.getTime() + MINUTE);
      const booked = await snapshot(heron, 10_000, new Date(), {
        credits: [
          credit('kalshi:dep:old', 500, before, { kind: 'DEPOSIT', program: null }),
          credit('kalshi:wd:x:reversal', 40, after, { kind: 'CORRECTION', program: null, reverses: 'kalshi:wd:x' }),
          credit('kalshi:wd:y', -40, after, { kind: 'WITHDRAWAL', program: null }),
          credit('kalshi:wd:y:reversal', 40, after, { kind: 'CORRECTION', program: null, reverses: 'kalshi:wd:y' }),
        ],
      });
      expect(booked).toMatchObject({ creditsBooked: 2, cashStatus: 'OK' });
    });

    it('starts reading from reconciliation, then from a little before the newest credit booked', async () => {
      const heron = await account(1, 'steady-heron-01');
      let [target] = await pollTargets(client);
      expect(target.credits_since).toBeNull();
      await open(heron, 100);
      [target] = await pollTargets(client);
      expect(new Date(target.credits_since).getTime()).toBe(opened.getTime());
      const since = new Date(Date.now() - 10 * 86_400_000);
      await updateConfig(client, JSON.stringify({ accountId: heron, reconSince: since.toISOString() }), 'ops@example.com');
      const paid = new Date(Date.now() - 2 * 86_400_000);
      await snapshot(heron, 10_100, new Date(), { credits: [credit('kalshi:credit:9', 100, paid)] });
      [target] = await pollTargets(client);
      expect(new Date(target.credits_since).getTime()).toBe(paid.getTime() - 3 * 86_400_000);
      // A credit dated in the future is a bad date: booking it would move every later read past what follows it.
      const future = new Date(Date.now() + 5 * 86_400_000);
      expect(await snapshot(heron, 10_100, new Date(), { credits: [credit('kalshi:credit:10', 100, future)] }))
        .toMatchObject({ creditsBooked: 0 });
      [target] = await pollTargets(client);
      expect(new Date(target.credits_since).getTime()).toBe(paid.getTime() - 3 * 86_400_000);
    });

    it('takes credits only from the venue poller', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      expect(() => parseSnapshot(JSON.stringify({
        accountId: heron, status: 'OK', cashTotal: '1', credits: [credit('kalshi:dep:x', 100, new Date(), { kind: 'DEPOSIT', program: null })],
      }), 'MANUAL', 'ops@example.com')).toThrow(/only the venue poller/);
    });

    it('leaves deposits and withdrawals on polled venues to the poller, and filters the list', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      const record = (fields: Record<string, unknown>) => recordTransfer(client, JSON.stringify({
        accountId: heron, amount: 5 * DOLLAR, reason: 'test', ...fields,
      }), 'ops@example.com');
      await expect(record({ kind: 'DEPOSIT' })).rejects.toThrow(/poller books KALSHI deposits/);
      await expect(record({ kind: 'CORRECTION', program: 'LIQUIDITY' })).rejects.toThrow(/only a REWARD or INTEREST/);
      await record({ kind: 'CORRECTION' });
      await record({ kind: 'REWARD', program: 'REFERRAL' });
      expect((await transfers(client, { accountId: heron, program: 'REFERRAL' })).map(r => r.kind)).toEqual(['REWARD']);
      expect((await transfers(client, { accountId: null, kind: 'OPENING' }))).toHaveLength(1);
    });
  });
  describe('reward allocation', () => {
    const HOUR = 60 * MINUTE;
    const reward = (externalRef: string, cents: number, at: Date, program: string, venueMarket: string | null = null) => ({
      externalRef, kind: 'REWARD', program, amount: String(Math.round(cents * CENT)), occurredAt: at.toISOString(),
      venueMarket, venueType: program, reverses: null,
    });

    let fills = 1000;
    async function fill(sessionId: string, listingId: number, qty: number, cents: number, liquidity: 'MAKER' | 'TAKER',
      feeCents = 0, at = new Date()) {
      fills++;
      await withTransaction(client, (c) => writeBatch(c, sessionId, JSON.stringify({
        sessionId,
        fills: [{
          source: 'VENUE', listingId, clientOidCounter: fills, cumQtyAfter: qty * UNIT, side: 0, fillQty: qty * UNIT,
          fillPrice: Math.round(cents * CENT), fee: Math.round(feeCents * CENT), eventTimeNs: at.getTime() * 1_000_000,
          netQuantityAfter: qty * UNIT,
          totalCostAfter: Math.round(qty * cents * CENT), realizedPnlAfter: 0, feesAfter: Math.round(feeCents * CENT),
          positionVersion: fills, liquidity,
        }],
      })));
    }

    async function resting(sessionId: string, strategyId: number, listingId: number, accountId: number, size: number,
      from: Date, to: Date) {
      fills++;
      await client.query(
        `INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id, mode, side, price,
           size, status, opened_at, acked_at, closed_at, account_id)
         SELECT $1, $2, $3, $4, exchange_id, 'live', 0, $5, $6, 'CLOSED', $7, $7, $8, $9 FROM sm.listing WHERE listing_id = $4`,
        [sessionId, fills, strategyId, listingId, 40 * CENT, size * UNIT, from, to, accountId]);
    }

    // Two strategies with $10 budgets each, on an account holding enough for both.
    async function launchBoth(accountId: number, exchangeId: number, first: number, second: number) {
      await requiredPolicies(10, exchangeId, 1);
      await requiredPolicies(10, exchangeId, 2);
      await snapshot(accountId, 10_000, new Date(Date.now() - MINUTE));
      expect((await live('a', [first], 1, false)).statusCode).toBe(200);
      expect((await live('b', [second], 2, false)).statusCode).toBe(200);
    }

    const allocations = async () => (await client.query(
      `SELECT t.external_ref, al.strategy_id, al.listing_id, al.venue_market, al.amount::text, al.basis
       FROM treasury.transfer_allocation al JOIN treasury.transfer t USING (transfer_id) ORDER BY al.allocation_id`)).rows;
    const state = async (ref: string) => (await client.query(
      'SELECT allocation_state FROM treasury.transfer WHERE external_ref = $1', [ref])).rows[0]?.allocation_state;

    it('gives a Polymarket maker rebate to the strategies whose maker fills earned it, market by market', async () => {
      const falcon = await account(2, 'quiet-falcon-01');
      await open(falcon, 100);
      await launchBoth(falcon, 2, 600, 601);
      // Paid now for the UTC day it covers; the fills happened on that day, on the venue.
      const now = new Date();
      const paid = now;
      const day = payoutDay(paid);
      const dayEnd = new Date(day.getTime() + 24 * HOUR);
      await fill('a', 600, 10, 40, 'MAKER', 0, new Date(day.getTime() + HOUR));
      await fill('b', 601, 30, 40, 'MAKER', 0, new Date(day.getTime() + HOUR));
      const ref = 'pm:MAKER_REBATE:0xabc:4000000000:0';
      const result = await snapshot(falcon, 8_800, now, {
        credits: [reward(ref, 400, paid, 'MAKER_REBATE')],
        breakdowns: [{
          externalRef: ref,
          markets: [
            { venueMarket: '0xc1', amount: String(300 * CENT), from: day.toISOString(), to: dayEnd.toISOString(),
              periodStart: day.toISOString(), periodEnd: dayEnd.toISOString() },
            { venueMarket: '0xc2', amount: String(100 * CENT), from: day.toISOString(), to: dayEnd.toISOString(),
              periodStart: day.toISOString(), periodEnd: dayEnd.toISOString() },
          ],
        }],
      });
      expect(result).toMatchObject({ creditsBooked: 1, rewardsAllocated: 1, cashStatus: 'OK' });
      expect(await allocations()).toEqual([
        { external_ref: ref, strategy_id: 1, listing_id: 600, venue_market: '0xc1', amount: String(75 * CENT), basis: 'MAKER_FILLS' },
        { external_ref: ref, strategy_id: 2, listing_id: 601, venue_market: '0xc1', amount: String(225 * CENT), basis: 'MAKER_FILLS' },
      ]);
      // No strategy of ours made on 0xc2: its part stays the firm's, listed with why.
      expect(await state(ref)).toBe('PARTIAL');
      const kept = (await client.query(
        `SELECT t.unallocated, al.period_start, al.period_end, al.strategies FROM treasury.transfer t
         JOIN treasury.transfer_allocation al USING (transfer_id) WHERE t.external_ref = $1`, [ref])).rows;
      expect(kept[0].unallocated).toEqual([expect.objectContaining({ venueMarket: '0xc2', amount: String(100 * CENT) })]);
      expect(kept.map(r => [r.period_start.getTime(), r.period_end.getTime(), r.strategies]))
        .toEqual([[day.getTime(), dayEnd.getTime(), 2], [day.getTime(), dayEnd.getTime(), 2]]);
      const [row] = await transfers(client, { accountId: null, strategyId: 2 });
      expect(row.allocations).toEqual([
        expect.objectContaining({ strategyId: 1, amount: String(75 * CENT) }),
        expect.objectContaining({ strategyId: 2, amount: String(225 * CENT) }),
      ]);
    });

    it('splits a liquidity reward between strategies by how long their quotes rested on the market', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      await launchBoth(heron, 1, 500, 501);
      const now = new Date();
      await resting('a', 1, 500, heron, 100, new Date(now.getTime() - 10 * HOUR), new Date(now.getTime() - 8 * HOUR));
      await resting('b', 2, 501, heron, 100, new Date(now.getTime() - 9 * HOUR), new Date(now.getTime() - 3 * HOUR));
      await resting('b', 2, 501, heron, 100, new Date(now.getTime() - 60 * HOUR), new Date(now.getTime() - 50 * HOUR));
      await snapshot(heron, 10_100, now, { credits: [reward('kalshi:credit:lip', 100, now, 'LIQUIDITY', 'T')] });
      expect(await allocations()).toEqual([
        { external_ref: 'kalshi:credit:lip', strategy_id: 1, listing_id: 500, venue_market: 'T', amount: String(25 * CENT), basis: 'RESTING_TIME' },
        { external_ref: 'kalshi:credit:lip', strategy_id: 2, listing_id: 501, venue_market: 'T', amount: String(75 * CENT), basis: 'RESTING_TIME' },
      ]);
    });

    it('gives a taker rebate by taker fees paid, and leaves it to the firm when none were', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      await snapshot(heron, 10_003, new Date(), { credits: [reward('pmus:early', 3, new Date(), 'TAKER_REBATE')] });
      expect(await state('pmus:early')).toBe('FAILED');
      await launchBoth(heron, 1, 500, 501);
      await fill('a', 500, 1, 40, 'TAKER', 3);
      await fill('b', 501, 1, 40, 'TAKER', 1);
      await snapshot(heron, 10_003 - 80 - 4 + 8, new Date(), { credits: [reward('pmus:week', 8, new Date(), 'TAKER_REBATE')] });
      expect(await allocations()).toEqual([
        { external_ref: 'pmus:week', strategy_id: 1, listing_id: null, venue_market: null, amount: String(6 * CENT), basis: 'TAKER_FEES' },
        { external_ref: 'pmus:week', strategy_id: 2, listing_id: null, venue_market: null, amount: String(2 * CENT), basis: 'TAKER_FEES' },
      ]);
    });

    it('waits for a breakdown that adds up to the payout, then leaves it to the firm and flags it', async () => {
      const falcon = await account(2, 'quiet-falcon-01');
      await open(falcon, 100);
      const now = new Date();
      const ref = 'pm:REWARD:0xdef:5000000000:0';
      const wrong = [{ externalRef: ref, markets: [
        { venueMarket: '0xc1', amount: String(300 * CENT), from: now.toISOString(), to: now.toISOString() },
      ] }];
      await snapshot(falcon, 10_500, now, { credits: [reward(ref, 500, now, 'LIQUIDITY')], breakdowns: wrong });
      expect(await state(ref)).toBe('PENDING');
      const [target] = (await pollTargets(client)).filter(t => t.account_id === falcon);
      expect(target.pending_credits).toEqual([expect.objectContaining({ external_ref: ref, program: 'LIQUIDITY' })]);
      const later = new Date(now.getTime() + 11 * 24 * HOUR);
      await snapshot(falcon, 10_500, later);
      expect(await state(ref)).toBe('FAILED');
      expect((await attention(client, 'live', later)).filter(i => i.kind === 'REWARD_UNALLOCATED').map(i => i.accountId))
        .toEqual([falcon]);
    });

    it('counts a strategy\'s rewards in its PnL outside sessions, and the rest in the firm\'s non-trading PnL', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      await launchBoth(heron, 1, 500, 501);
      const now = new Date();
      await resting('a', 1, 500, heron, 100, new Date(now.getTime() - 4 * HOUR), new Date(now.getTime() - 2 * HOUR));
      await snapshot(heron, 10_350, now, { credits: [
        reward('kalshi:credit:lip', 100, now, 'LIQUIDITY', 'T'),
        { ...reward('kalshi:credit:apy', 250, now, 'INTEREST'), kind: 'INTEREST' },
      ] });
      const later = new Date(now.getTime() + MINUTE);
      const strategy = await summarize(client, { strategyId: '1', mode: 'live' }, later) as any;
      expect(strategy.totals).toMatchObject({
        lifetime: String(100 * CENT), today: String(100 * CENT), rewards: String(100 * CENT),
        outsideSessions: expect.objectContaining({ rewards: String(100 * CENT), carry: '0' }),
      });
      const firm = await summarize(client, { mode: 'live' }, later) as any;
      expect(firm.totals).toMatchObject({ lifetime: String(350 * CENT), rewards: String(100 * CENT), nonTrading: String(250 * CENT) });
      expect(firm.nonTrading.byProgram).toEqual({ INTEREST: { lifetime: String(250 * CENT), today: String(250 * CENT) } });
      expect(firm.strategies.find((x: any) => x.strategyId === 1)).toMatchObject({ lifetime: String(100 * CENT) });
      expect((await summarize(client, { mode: 'paper' }, later) as any).totals.nonTrading).toBe('0');
      const chart = await series(client, { mode: 'live', start: new Date(now.getTime() - HOUR).toISOString() }, later) as any;
      expect(chart.total.at(-1)).toBe(String(350 * CENT));
      expect(chart.strategies.find((x: any) => x.strategyId === 1).total.at(-1)).toBe(String(100 * CENT));
      expect(chart.events.map((e: any) => e.kind).sort()).toEqual(['NON_TRADING', 'REWARD']);
      // A listing's own line is its trading PnL, as its summary row is.
      const listingChart = await series(client, {
        strategyId: '1', mode: 'live', listingId: '500', start: new Date(now.getTime() - HOUR).toISOString(),
      }, later) as any;
      expect(listingChart.total.at(-1)).toBe('0');
      const strategyChart = await series(client, { strategyId: '1', mode: 'live', start: new Date(now.getTime() - HOUR).toISOString() }, later) as any;
      expect(strategyChart.total.at(-1)).toBe(String(100 * CENT));
    });

    it('allocates a reward once when two readings of the account race', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      await launchBoth(heron, 1, 500, 501);
      await fill('a', 500, 1, 40, 'TAKER', 3);
      // Booked by one reading, allocated by two at once: the second waits on the first's row lock, then finds it done.
      const now = new Date();
      await withTransaction(client, (c) => c.query(
        `INSERT INTO treasury.transfer (account_id, kind, amount, occurred_at, external_ref, reason, actor, program,
           allocation_state) VALUES ($1, 'REWARD', $2, $3, 'pmus:race', 'test', 'venue-poller', 'TAKER_REBATE', 'PENDING')`,
        [heron, 3 * CENT, now]));
      const other = await pool.connect();
      try {
        const accountRow = { account_id: heron, exchange_code: 'KALSHI' };
        const settled = await Promise.all([
          withTransaction(client, (c) => allocatePending(c, accountRow, [], now)),
          withTransaction(other, (c) => allocatePending(c, accountRow, [], now)),
        ]);
        expect(settled.sort()).toEqual([0, 1]);
      } finally {
        other.release();
      }
      expect((await allocations()).filter(a => a.external_ref === 'pmus:race')).toHaveLength(1);
    });

    it('finds the markets of a Kalshi event a credit names by its event ticker', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      await client.query(`UPDATE sm.listing SET exchange_security_id = 'KXRT-26NOV14-EBEN-75:yes' WHERE listing_id = 500`);
      await launchBoth(heron, 1, 500, 501);
      const now = new Date();
      await resting('a', 1, 500, heron, 100, new Date(now.getTime() - 4 * HOUR), new Date(now.getTime() - 2 * HOUR));
      await snapshot(heron, 10_100, now, { credits: [reward('kalshi:credit:ev', 100, now, 'LIQUIDITY', 'KXRT-26NOV14-EBEN')] });
      expect((await allocations()).map(a => [a.strategy_id, a.listing_id, a.amount])).toEqual([[1, 500, String(100 * CENT)]]);
      expect(await state('kalshi:credit:ev')).toBe('DONE');
    });

    it('pays a Polymarket US liquidity payout in arrears from its oldest unpaid days, never a day twice', async () => {
      await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
        VALUES (3, 'Polymarket US', 'us-east-1', 'POLYMARKET_US')`);
      await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type) VALUES (5, 'S', 4, 7)`);
      await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id)
        VALUES (700, 3, 5, 'slug-a:long')`);
      const otter = await account(3, 'brisk-badger-01');
      await open(otter, 100);
      await requiredPolicies(10, 3, 1);
      await snapshot(otter, 10_000, new Date(Date.now() - MINUTE));
      expect((await live('a', [700], 1, false)).statusCode).toBe(200);
      const now = new Date();
      await resting('a', 1, 700, otter, 100, new Date(now.getTime() - 3 * 24 * HOUR), now);
      const day = (daysAgo: number, dollars: number) => {
        const from = new Date(now.getTime() - daysAgo * 24 * HOUR);
        const to = new Date(from.getTime() + 20 * HOUR);
        return { venueMarket: 'slug-a', amount: String(dollars * 100 * Number(CENT)), from: from.toISOString(), to: to.toISOString(),
          periodStart: from.toISOString(), periodEnd: to.toISOString() };
      };
      const earned = [day(3, 1), day(2, 2), day(1, 4)];
      await snapshot(otter, 10_300, now, {
        credits: [reward('pmus:L1', 300, now, 'LIQUIDITY')], breakdowns: [{ externalRef: 'pmus:L1', markets: earned, inArrears: true }],
      });
      // The next payout is the days left, though the venue lists the paid ones again.
      await snapshot(otter, 10_700, now, {
        credits: [reward('pmus:L2', 400, now, 'LIQUIDITY')], breakdowns: [{ externalRef: 'pmus:L2', markets: earned, inArrears: true }],
      });
      expect((await allocations()).map(a => [a.external_ref, a.amount])).toEqual([
        ['pmus:L1', String(100 * CENT)], ['pmus:L1', String(200 * CENT)], ['pmus:L2', String(400 * CENT)],
      ]);
    });

    it('never gives out more of a transfer than was paid', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      await snapshot(heron, 10_001, new Date(), { credits: [reward('k:1', 1, new Date(), 'VOLUME')] });
      const { transfer_id } = (await client.query(`SELECT transfer_id FROM treasury.transfer WHERE external_ref = 'k:1'`)).rows[0];
      await expect(withTransaction(client, (c) => c.query(
        `INSERT INTO treasury.transfer_allocation (transfer_id, strategy_id, amount, earned_from, earned_to, basis, strategies)
         VALUES ($1, 1, $2, NOW() - INTERVAL '1 day', NOW(), 'RESTING_TIME', 1)`,
        [transfer_id, 2 * CENT]))).rejects.toThrow(/allocates/);
    });

    it('flags a credit booked under a type the poller doesn\'t know', async () => {
      const heron = await account(1, 'steady-heron-01');
      await open(heron, 100);
      await snapshot(heron, 10_200, new Date(), { credits: [reward('kalshi:credit:x', 200, new Date(), 'UNCLASSIFIED')] });
      const items = (await attention(client, 'live', new Date())).filter(i => i.kind === 'VENUE_CREDIT_UNCLASSIFIED');
      expect(items.map(i => i.title)).toEqual(['steady-heron-01 was paid $2.00 under a type the poller doesn\'t know']);
    });
  });
});
