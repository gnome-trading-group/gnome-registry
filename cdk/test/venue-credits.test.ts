import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { matchBreakdown, split } from '../lambda/endpoints/treasury-allocate';
import { handler as pollVenues, wantedBreakdowns } from '../lambda/sync/venue-poller';
import { polymarketIntlHeaders } from '../lambda/sync/venues/signers';
import { parseKalshiCredit, parseKalshiMove, readKalshiCredits } from '../lambda/sync/venues/kalshi';
import {
  parsePolymarketIntlActivity, readPolymarketIntlBreakdowns, readPolymarketIntlCredits,
} from '../lambda/sync/venues/polymarket-intl';
import { easternMidnight, liquidityBreakdown, parsePolymarketUsActivity } from '../lambda/sync/venues/polymarket-us';
import { PollTarget } from '../lambda/sync/venues/types';

const DOLLAR = 1_000_000_000n;
const CENT = 10_000_000n;
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'venues', name), 'utf8'));

describe('Kalshi credits', () => {
  const credit = (fields: Record<string, unknown>) => ({
    credit_id: 'c1', type: 'liquidity_incentive', status: 'applied', amount_dollars: '12.3456',
    reason: 'LIP reward KXRT-26NOV14-EBEN-75', created_time: '2026-11-12T11:00:00Z', ...fields,
  });

  it('books an applied liquidity credit as a reward for the market its reason names', () => {
    expect(parseKalshiCredit(credit({}))).toMatchObject({
      externalRef: 'kalshi:credit:c1', kind: 'REWARD', program: 'LIQUIDITY', amount: 12_345_600_000n,
      venueMarket: 'KXRT-26NOV14-EBEN-75', occurredAt: new Date('2026-11-12T11:00:00Z'),
    });
  });

  it('books interest as INTEREST, skips credits not yet applied, and flags types it doesn\'t know', () => {
    expect(parseKalshiCredit(credit({ type: 'apy_interest', reason: '' }))).toMatchObject({ kind: 'INTEREST', program: 'INTEREST' });
    expect(parseKalshiCredit(credit({ status: 'pending' }))).toBeNull();
    expect(parseKalshiCredit(credit({ type: 'promo' }))).toMatchObject({ kind: 'REWARD', program: 'UNCLASSIFIED' });
    // Money out under an unknown type is left for recon to flag, not written off.
    expect(parseKalshiCredit(credit({ type: 'promo', amount_dollars: '-1.00' }))).toBeNull();
  });

  it('reads credits for the main account only, as every subaccount on the login would see the same ones', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const target = (subaccount?: number): PollTarget => ({
      account_id: 1, exchange_id: 1, exchange_code: 'KALSHI', label: 'x', read_secret_name: null, partition_targets: null,
      rebalance_reservation: 'sum', credits_since: null, pending_credits: [],
      venue_ref: subaccount === undefined ? {} : { subaccount },
    });
    expect(await readKalshiCredits(target(2), { apiKey: 'k', privateKey: 'unused' }, new Date())).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('books applied deposits and withdrawals with their fee apart, and undoes a returned one', () => {
    const deposit = { id: 'd1', status: 'applied', type: 'ach', amount_cents: 50_000, fee_cents: 0, created_ts: 1_794_000_000, finalized_ts: 1_794_100_000 };
    expect(parseKalshiMove(deposit, 'DEPOSIT')).toEqual([expect.objectContaining({
      externalRef: 'kalshi:dep:d1', kind: 'DEPOSIT', amount: 500n * DOLLAR, occurredAt: new Date(1_794_100_000_000),
    })]);
    expect(parseKalshiMove({ ...deposit, status: 'pending' }, 'DEPOSIT')).toEqual([]);
    const withdrawal = parseKalshiMove({ ...deposit, id: 'w1', status: 'returned', fee_cents: 200 }, 'WITHDRAWAL');
    expect(withdrawal.map(c => [c.externalRef, c.kind, c.amount, c.reverses])).toEqual([
      ['kalshi:wd:w1', 'WITHDRAWAL', -500n * DOLLAR, undefined],
      ['kalshi:wd:w1:fee', 'FEE_ADJUSTMENT', -200n * CENT, undefined],
      ['kalshi:wd:w1:reversal', 'CORRECTION', 500n * DOLLAR, 'kalshi:wd:w1'],
    ]);
  });
});

describe('Polymarket Intl credits', () => {
  const rows = fixture('polymarket-intl-credit-activity.json').data;

  it('maps each payout type to its program, and a withdrawal to cash out', () => {
    const credits = parsePolymarketIntlActivity(rows);
    expect(credits.map(c => [c.kind, c.program]).filter((v, i, all) => all.findIndex(x => x.join() === v.join()) === i))
      .toEqual([['REWARD', 'TAKER_REBATE'], ['REWARD', 'MAKER_REBATE'], ['REWARD', 'REFERRAL'], ['WITHDRAWAL', null]]);
    expect(credits.at(-1)!.amount).toBe(-600n * DOLLAR);
    expect(credits.every(c => c.venueMarket === null)).toBe(true);
  });

  // A taker rebate's level-up bonuses came as three rows of one transaction, alike but for the amount.
  it('names each of several payouts in one transaction apart, the same way on every reading', () => {
    const bonuses = parsePolymarketIntlActivity(rows).filter(c => c.externalRef.includes(':0x3164deb2d7'));
    expect(bonuses.map(c => c.amount)).toEqual([50n * DOLLAR, 250n * DOLLAR, 10n * DOLLAR]);
    expect(new Set(bonuses.map(c => c.externalRef)).size).toBe(3);
    const twice = parsePolymarketIntlActivity([rows[0], rows[0]]);
    expect(twice.map(c => c.externalRef.split(':').at(-1))).toEqual(['0', '1']);
    expect(parsePolymarketIntlActivity(rows).map(c => c.externalRef))
      .toEqual(parsePolymarketIntlActivity(rows).map(c => c.externalRef));
  });

  it('asks for every page with the wallet and the start time', async () => {
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      const page = urls.length === 1
        ? { data: rows.slice(0, 3), pagination: { next_cursor: 'abc' } }
        : { data: rows.slice(3), pagination: { next_cursor: null } };
      return new Response(JSON.stringify(page));
    });
    const funder = '0x' + 'ab'.repeat(20);
    const credits = await readPolymarketIntlCredits({
      account_id: 2, exchange_id: 2, exchange_code: 'POLYMARKET_INTL', label: 'x', read_secret_name: null,
      partition_targets: null, rebalance_reservation: 'sum', credits_since: null, pending_credits: [],
      venue_ref: { funderAddress: funder },
    }, new Date('2026-11-01T00:00:00Z'));
    jest.restoreAllMocks();
    expect(credits).toHaveLength(rows.length);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url).toContain(`user=${funder}`);
      expect(url).toContain(`start=${Date.parse('2026-11-01T00:00:00Z') / 1000}`);
    }
    expect(urls[1]).toContain('cursor=abc');
  });
});

describe('Polymarket US credits', () => {
  const activities = fixture('polymarket-us-credit-activities.json').activities;

  it('takes a reasonless transfer in for the weekly taker rebate, and a deposit\'s advance from when it was made', () => {
    const credits = activities.flatMap(parsePolymarketUsActivity);
    expect(credits.map((c: any) => [c.externalRef, c.kind, c.program, c.amount, c.occurredAt.toISOString()])).toEqual([
      ['pmus:D4CF2F5GE010', 'REWARD', 'TAKER_REBATE', 3n * CENT, '2026-10-16T16:34:40.093Z'],
      ['pmus:D2WC1C548010', 'DEPOSIT', null, 10n * DOLLAR, '2026-10-14T01:24:12.196Z'],
      ['pmus:CZVHM2VP4010', 'REWARD', 'TAKER_REBATE', 1n * CENT, '2026-10-09T16:32:35.653Z'],
      ['pmus:CZ4JRQWME010', 'DEPOSIT', null, 20n * DOLLAR, expect.any(String)],
    ]);
  });

  const change = (type: string, status: string, value: string, extra: Record<string, unknown> = {}) => ({
    type,
    accountBalanceChange: {
      transactionId: 'T1', status: `ACCOUNT_BALANCE_CHANGE_STATUS_${status}`, amount: { value, currency: 'USD' },
      createTime: '2026-11-01T10:00:00Z', updateTime: '2026-11-03T10:00:00Z', transferReason: 'TRANSFER_REASON_UNSPECIFIED',
      transactions: [], ...extra,
    },
  });

  it('books a withdrawal when asked for and undoes a rejected one; waits for a deposit with no advance to complete', () => {
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_ACCOUNT_WITHDRAWAL', 'PENDING', '25')))
      .toEqual([expect.objectContaining({ externalRef: 'pmus:T1', kind: 'WITHDRAWAL', amount: -25n * DOLLAR })]);
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_ACCOUNT_WITHDRAWAL', 'REJECTED', '25')).map(c => [c.kind, c.amount, c.reverses]))
      .toEqual([['WITHDRAWAL', -25n * DOLLAR, undefined], ['CORRECTION', 25n * DOLLAR, 'pmus:T1']]);
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_ACCOUNT_DEPOSIT', 'PENDING', '25'))).toEqual([]);
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_ACCOUNT_DEPOSIT', 'COMPLETED', '25')))
      .toEqual([expect.objectContaining({ kind: 'DEPOSIT', amount: 25n * DOLLAR, occurredAt: new Date('2026-11-03T10:00:00Z') })]);
  });

  it('books the rest of a partly advanced deposit when it completes', () => {
    const credits = parsePolymarketUsActivity(change('ACTIVITY_TYPE_ACCOUNT_DEPOSIT', 'COMPLETED', '100', {
      transactions: [{ advancedAmount: { value: '40', currency: 'USD' } }],
    }));
    expect(credits.map(c => [c.externalRef, c.amount])).toEqual([['pmus:T1', 40n * DOLLAR], ['pmus:T1:rest', 60n * DOLLAR]]);
  });

  it('takes only a small reasonless Friday transfer for the weekly taker rebate', () => {
    const friday = { createTime: '2026-11-13T16:30:00Z' };
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_TRANSFER', 'COMPLETED', '0.05', friday)))
      .toEqual([expect.objectContaining({ program: 'TAKER_REBATE' })]);
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_TRANSFER', 'COMPLETED', '0.05', { createTime: '2026-11-12T16:30:00Z' })))
      .toEqual([expect.objectContaining({ program: 'UNCLASSIFIED' })]);
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_TRANSFER', 'COMPLETED', '900', friday)))
      .toEqual([expect.objectContaining({ program: 'UNCLASSIFIED' })]);
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_TRANSFER', 'COMPLETED', '-3', friday))).toEqual([]);
  });

  it('flags a partly refunded withdrawal for a person, keeping the withdrawal booked', () => {
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_ACCOUNT_WITHDRAWAL', 'PARTIALLY_REFUNDED', '25'))
      .map(c => [c.externalRef, c.kind, c.program, c.amount]))
      .toEqual([['pmus:T1', 'WITHDRAWAL', null, -25n * DOLLAR], ['pmus:T1:partial-refund', 'REWARD', 'UNCLASSIFIED', 0n]]);
  });

  it('books program payouts once completed, and a transfer with a reason as unclassified', () => {
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_LIQUIDITY_PROGRAM', 'COMPLETED', '4.5')))
      .toEqual([expect.objectContaining({ kind: 'REWARD', program: 'LIQUIDITY', amount: 4_500_000_000n })]);
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_LIQUIDITY_PROGRAM', 'PENDING', '4.5'))).toEqual([]);
    expect(parsePolymarketUsActivity(change('ACTIVITY_TYPE_TRANSFER', 'COMPLETED', '2', { transferReason: 'TRANSFER_REASON_PROMO' })))
      .toEqual([expect.objectContaining({ kind: 'REWARD', program: 'UNCLASSIFIED' })]);
  });
});

describe('reward breakdowns', () => {
  const pmIntl = (fields: Partial<PollTarget> = {}): PollTarget => ({
    account_id: 2, exchange_id: 2, exchange_code: 'POLYMARKET_INTL', label: 'x', read_secret_name: null,
    partition_targets: null, rebalance_reservation: 'sum', credits_since: null, pending_credits: [],
    venue_ref: { funderAddress: '0x' + 'ab'.repeat(20), signerAddress: '0x' + 'cd'.repeat(20), signatureType: '3' }, ...fields,
  });

  it('splits an amount in proportion, to the unit', () => {
    expect(split(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(split(10n, [3n, 1n])).toEqual([8n, 2n]);
    expect(split(5n, [0n, 0n])).toEqual([0n, 0n]);
  });

  it('signs a CLOB request as Polymarket\'s L2 auth wants, over the path without its query', () => {
    const secret = Buffer.from('a-very-secret-key-of-some-length').toString('base64url');
    const headers = polymarketIntlHeaders({ apiKey: 'k', secret, passphrase: 'p' }, '0xabc', 'GET',
      '/rewards/user?date=2026-11-11', 1_700_000_000_500);
    const expected = createHmac('sha256', Buffer.from(secret, 'base64url')).update('1700000000GET/rewards/user')
      .digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(headers).toEqual({
      POLY_ADDRESS: '0xabc', POLY_API_KEY: 'k', POLY_PASSPHRASE: 'p', POLY_SIGNATURE: expected, POLY_TIMESTAMP: '1700000000',
    });
  });

  it('asks only for programs the venue breaks down, for what is pending and what was just read', () => {
    const pending = [{ external_ref: 'old', program: 'MAKER_REBATE' as const, occurred_at: '2026-11-10T00:45:00Z', amount: '1' }];
    const credits = parsePolymarketIntlActivity(fixture('polymarket-intl-credit-activity.json').data);
    const wanted = wantedBreakdowns(pmIntl({ pending_credits: pending }), credits);
    expect(wanted.map(w => w.program)).toEqual(['MAKER_REBATE', 'MAKER_REBATE', 'MAKER_REBATE', 'MAKER_REBATE']);
    expect(wanted[0].external_ref).toBe('old');
    expect(wantedBreakdowns({ ...pmIntl(), exchange_code: 'KALSHI' }, credits)).toEqual([]);
  });

  it('reads the day before a Polymarket maker rebate was paid, summed by market', async () => {
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify([
        { condition_id: '0xc1', rebated_fees_usdc: '1.25' }, { condition_id: '0xc1', rebated_fees_usdc: '0.75' },
        { condition_id: '0xc2', rebated_fees_usdc: '0.5' },
      ]));
    });
    const [b] = await readPolymarketIntlBreakdowns(pmIntl(), null, [
      { external_ref: 'r', program: 'MAKER_REBATE', occurred_at: '2026-11-12T00:45:00Z', amount: '2500000000' },
      { external_ref: 'l', program: 'LIQUIDITY', occurred_at: '2026-11-12T00:01:00Z', amount: '1' },
    ]);
    jest.restoreAllMocks();
    expect(urls).toEqual([expect.stringContaining('/rebates/current?date=2026-11-11&maker_address=0xabab')]);
    expect(b.markets.map(m => [m.venueMarket, m.amount, m.periodStart?.toISOString(), m.periodEnd?.toISOString()])).toEqual([
      ['0xc1', 2n * DOLLAR, '2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z'],
      ['0xc2', DOLLAR / 2n, '2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z'],
    ]);
  });

  it('reads a day\'s liquidity rewards in dollars, with and without the sponsored ones', async () => {
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      const sponsored = String(url).includes('sponsored=true');
      return new Response(JSON.stringify({
        data: sponsored ? [{ condition_id: '0xc2', earnings: 4, asset_rate: 0.5 }] : [{ condition_id: '0xc1', earnings: '3', asset_rate: '1' }],
        next_cursor: 'LTE=',
      }));
    });
    const [b] = await readPolymarketIntlBreakdowns(pmIntl(), { apiKey: 'k', secret: 'c2VjcmV0', passphrase: 'p' }, [
      { external_ref: 'l', program: 'LIQUIDITY', occurred_at: '2026-11-12T00:01:00Z', amount: '1' },
    ]);
    jest.restoreAllMocks();
    expect(urls).toHaveLength(2);
    expect(b.markets.map(m => [m.venueMarket, m.amount])).toEqual([['0xc1', 3n * DOLLAR]]);
    expect(b.alternatives?.[0].map(m => [m.venueMarket, m.amount])).toEqual([['0xc1', 3n * DOLLAR], ['0xc2', 2n * DOLLAR]]);
  });

  it('starts a Polymarket US day at Eastern midnight, in winter and in summer', () => {
    expect(easternMidnight('2026-11-12').toISOString()).toBe('2026-11-12T05:00:00.000Z');
    expect(easternMidnight('2026-07-04').toISOString()).toBe('2026-07-04T04:00:00.000Z');
  });

  it('lists everything earned up to a Polymarket US payout, by Eastern day, for the oldest unpaid days to be matched', () => {
    const b = liquidityBreakdown(
      { external_ref: 'p', program: 'LIQUIDITY', occurred_at: '2026-11-12T16:00:00Z', amount: '1' },
      [
        { reward: '1.5', marketSlug: 'a', date: '2026-11-04' },
        { reward: { value: '2' }, marketSlug: 'b', date: '2026-11-06' },
        { reward: 0.25, marketSlug: 'a', date: '2026-11-12' },
      ]);
    expect(b.inArrears).toBe(true);
    expect(b.markets.map(m => [m.venueMarket, m.amount, m.periodStart?.toISOString()])).toEqual([
      ['a', 1_500_000_000n, '2026-11-04T05:00:00.000Z'], ['b', 2n * DOLLAR, '2026-11-06T05:00:00.000Z'],
    ]);
  });

  it('matches a payout made in arrears to its oldest whole days, and a breakdown only if it adds up', () => {
    const day = (d: string, market: string, dollars: number) => ({
      venueMarket: market, amount: String(BigInt(dollars * 100) * CENT), from: `${d}T05:00:00Z`, to: `${d}T23:00:00Z`,
      periodStart: `${d}T05:00:00Z`, periodEnd: `${d}T23:00:00Z`,
    });
    const earned = [day('2026-11-04', 'a', 1), day('2026-11-04', 'b', 2), day('2026-11-05', 'a', 4), day('2026-11-06', 'a', 8)];
    expect(matchBreakdown(earned, 7n * DOLLAR, true)?.map(p => [p.venueMarket, p.amount])).toEqual([
      ['a', DOLLAR], ['b', 2n * DOLLAR], ['a', 4n * DOLLAR],
    ]);
    expect(matchBreakdown(earned, 5n * DOLLAR, true)).toBeNull();
    expect(matchBreakdown(earned, 15n * DOLLAR, false)?.map(p => p.amount).reduce((a, b) => a + b)).toBe(15n * DOLLAR);
    expect(matchBreakdown(earned, 14n * DOLLAR, false)).toBeNull();
  });
});

describe('the venue poller', () => {
  it('still posts the balance, and the pending rewards\' breakdowns, when the credits can\'t be read', async () => {
    process.env.REGISTRY_API_URL = 'https://registry.test/api';
    process.env.REGISTRY_API_KEY = 'key';
    process.env.POLYGON_RPC_URL = 'https://rpc.test';
    process.env.PUSD_TOKEN_ADDRESS = '0x' + '11'.repeat(20);
    const posted: any[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.endsWith('/treasury/poll-targets')) {
        return new Response(JSON.stringify([{
          account_id: 2, exchange_id: 2, exchange_code: 'POLYMARKET_INTL', label: 'quiet-falcon-01', read_secret_name: null,
          partition_targets: null, rebalance_reservation: 'sum', credits_since: '2026-11-01T00:00:00Z',
          venue_ref: { funderAddress: '0x' + 'ab'.repeat(20) },
          pending_credits: [{ external_ref: 'pm:MAKER_REBATE:0x1:1:0', program: 'MAKER_REBATE', occurred_at: '2026-11-12T00:45:00Z', amount: '1' }],
        }]));
      }
      if (target === 'https://rpc.test') return new Response(JSON.stringify({ result: '0x' + '0'.repeat(63) + '1' }));
      if (target.includes('/positions')) return new Response(JSON.stringify({ data: [], pagination: { next_cursor: null } }));
      if (target.includes('/activity')) return new Response('bad request', { status: 400 });
      if (target.includes('/rebates/current')) return new Response(JSON.stringify([{ condition_id: '0xc1', rebated_fees_usdc: '1' }]));
      if (target.endsWith('/treasury/snapshots')) {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ cashStatus: 'OK', positionBreaks: 0, creditsBooked: 0 }));
      }
      throw new Error(`unexpected ${target}`);
    });
    await pollVenues();
    jest.restoreAllMocks();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ accountId: 2, status: 'OK' });
    expect(posted[0].credits).toBeUndefined();
    expect(posted[0].raw.creditsErrors).toEqual([expect.stringMatching(/^credits: Polymarket activity failed: 400/)]);
    expect(posted[0].breakdowns).toEqual([expect.objectContaining({
      externalRef: 'pm:MAKER_REBATE:0x1:1:0', markets: [expect.objectContaining({ venueMarket: '0xc1', amount: String(DOLLAR) })],
    })]);
  });
});
