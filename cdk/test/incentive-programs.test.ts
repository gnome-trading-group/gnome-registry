import { readFileSync } from 'fs';
import { join } from 'path';
import { ValidationError } from '../lambda/endpoints/base';
import { dollars, parseProgram, ProgramVersion, trimToWindow } from '../lambda/endpoints/incentive-programs';
import { validateIncentiveDefinition } from '../lambda/incentives/definition';
import { isKalshiPayoutRun, postInChunks, syncVenue, unlistedEnded } from '../lambda/sync/incentive-sync';
import { parseKalshiIncentiveProgram } from '../lambda/sync/venues/kalshi';
import { parsePolymarketIntlRewardMarket } from '../lambda/sync/venues/polymarket-intl';
import { IncentiveProgramReading } from '../lambda/sync/venues/types';

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'venues', name), 'utf8'));

describe('Kalshi incentive programs', () => {
  const programs: Record<string, any>[] = fixture('kalshi-incentive-programs.json').incentive_programs;
  const byTicker = (prefix: string) => programs.find(p => p.market_ticker.startsWith(prefix))!;

  it('reads a liquidity program: reward from hundredths of a cent, terms as numbers', () => {
    expect(parseKalshiIncentiveProgram(byTicker('KXRT-VIO-60'))).toMatchObject({
      venueProgramId: 'ff8a66d6-67cc-4ca0-ac4f-cc5adadfcbf2',
      program: 'LIQUIDITY',
      venueMarket: 'KXRT-VIO-60',
      periodStart: '2026-11-11T05:00:00.000Z',
      periodEnd: '2026-11-12T05:00:00.000Z',
      reward: '100.0000',
      rewardPer: 'PERIOD',
      definition: { targetSize: 1000, discountFactor: 0.5 },
      paidOut: true,
    });
  });

  it('keeps sub-dollar precision', () => {
    expect(parseKalshiIncentiveProgram(byTicker('KXVOTEGENERAL'))!.reward).toBe('129.6200');
  });

  it('reads a cancelled program as the venue shows it, ending before it starts', () => {
    const p = parseKalshiIncentiveProgram(byTicker('KXKEVCOUNT'))!;
    expect(Date.parse(p.periodEnd!)).toBeLessThan(Date.parse(p.periodStart));
  });

  it('skips volume programs', () => {
    expect(parseKalshiIncentiveProgram(byTicker('KXMARATHON'))).toBeNull();
  });

  it('gives terms the registry accepts', () => {
    for (const p of programs.map(parseKalshiIncentiveProgram).filter(Boolean)) {
      expect(() => validateIncentiveDefinition('KALSHI', p!.definition)).not.toThrow();
    }
  });

  it('sweeps payouts only on the first run after 11:00 UTC', () => {
    expect(isKalshiPayoutRun(new Date('2026-11-12T11:07:00Z'))).toBe(true);
    expect(isKalshiPayoutRun(new Date('2026-11-12T11:15:00Z'))).toBe(false);
    expect(isKalshiPayoutRun(new Date('2026-11-12T10:59:00Z'))).toBe(false);
  });
});

describe('Polymarket Intl reward markets', () => {
  const markets: Record<string, any>[] = fixture('polymarket-intl-rewards-current.json').data;

  it('reads one program per reward config, paid per day, open-ended when the venue says 2500', () => {
    const [p] = parsePolymarketIntlRewardMarket(markets[0]);
    expect(p).toMatchObject({
      venueProgramId: '0x0002b6b6b307b97bf91a56b57209270db8bece06f3b86c3db50f58c8b3b0a2b0:'
        + '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb:2026-11-12',
      venueMarket: '0x0002b6b6b307b97bf91a56b57209270db8bece06f3b86c3db50f58c8b3b0a2b0',
      periodStart: '2026-11-12T00:00:00.000Z',
      periodEnd: null,
      reward: '5',
      rewardPer: 'DAY',
      definition: { minSize: 20, maxSpreadCents: 4.5, asset: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' },
      paidOut: null,
    });
    expect(() => validateIncentiveDefinition('POLYMARKET_INTL', p.definition)).not.toThrow();
  });

  it('records the native rate only: sponsored rewards carry no config', () => {
    const sponsored = markets[1];
    expect(sponsored.sponsored_daily_rate).toBeGreaterThan(0);
    expect(parsePolymarketIntlRewardMarket(sponsored).map(p => p.reward)).toEqual([String(sponsored.native_daily_rate)]);
    expect(parsePolymarketIntlRewardMarket(markets[2])).toEqual([]);
  });

  it('keeps a placeholder program no order can earn, as the venue lists it', () => {
    expect(() => validateIncentiveDefinition('POLYMARKET_INTL',
      { minSize: 0, maxSpreadCents: 0, asset: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' })).not.toThrow();
  });

  it('ends a dated config after its last paid day', () => {
    const market = { ...markets[0], rewards_config: [{ ...markets[0].rewards_config[0], end_date: '2026-11-20' }] };
    expect(parsePolymarketIntlRewardMarket(market)[0].periodEnd).toBe('2026-11-21T00:00:00.000Z');
  });
});

describe('incentive program posts', () => {
  const row = (fields: Record<string, unknown> = {}) => ({
    exchangeCode: 'KALSHI', venueProgramId: 'p1', program: 'LIQUIDITY', venueMarket: 'KXRT-VIO-60',
    periodStart: '2026-11-11T05:00:00Z', periodEnd: '2026-11-12T05:00:00Z', reward: '100.0000', rewardPer: 'PERIOD',
    definition: { targetSize: 1000, discountFactor: 0.5 }, paidOut: false, source: 'VENUE_API', ...fields,
  });

  it('scales the reward to price units', () => {
    expect(parseProgram(row() as any, 0).reward).toBe('100000000000');
    expect(dollars(100_000_000_000n)).toBe('100');
    expect(dollars(129_620_000_000n)).toBe('129.62');
  });

  it.each([
    ['an unknown program', { program: 'VOLUME' }],
    ['a negative reward', { reward: '-1' }],
    ['a reward that is not a number', { reward: 'lots' }],
    ['an unknown reward basis', { rewardPer: 'HOUR' }],
    ['a bad start', { periodStart: 'soon' }],
    ['Kalshi terms with a Polymarket field', { definition: { targetSize: 1000, discountFactor: 0.5, minSize: 20 } }],
    ['a discount factor over one', { definition: { targetSize: 1000, discountFactor: 2 } }],
    ['a venue with no programs', { exchangeCode: 'HYPERLIQUID' }],
  ])('rejects %s', (_name, fields) => {
    expect(() => parseProgram(row(fields) as any, 0)).toThrow(ValidationError);
  });
});

describe('program versions in a window', () => {
  const version = (effectiveFrom: string): ProgramVersion => ({
    venueProgramId: 'p1', program: 'LIQUIDITY', venueMarket: 'M', periodStart: '2026-11-01T00:00:00Z', periodEnd: null,
    reward: '1', rewardPer: 'DAY', definition: {}, paidOut: null, effectiveFrom,
  });

  it('starts from the version in force at the window start', () => {
    const versions = ['2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z', '2026-11-10T00:00:00Z'].map(version);
    expect(trimToWindow(versions, new Date('2026-11-07T00:00:00Z')).map(v => v.effectiveFrom))
      .toEqual(['2026-11-05T00:00:00Z', '2026-11-10T00:00:00Z']);
    expect(trimToWindow(versions, new Date('2026-10-01T00:00:00Z'))).toHaveLength(3);
    expect(trimToWindow(versions, null)).toHaveLength(3);
  });
});

describe('incentive sync', () => {
  const reading = (id: string): IncentiveProgramReading => ({
    venueProgramId: id, program: 'LIQUIDITY', venueMarket: `M-${id}`, periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: null, reward: '5', rewardPer: 'DAY', definition: { minSize: 20, maxSpreadCents: 4.5, asset: '0x' },
    paidOut: null, sourceRef: 'x', raw: null,
  });

  it('ends the open programs a complete read no longer lists, keeping their terms', () => {
    const end = new Date('2026-11-12T00:00:00Z');
    expect(unlistedEnded([reading('a'), reading('b')], [reading('a')], end))
      .toEqual([{ ...reading('b'), periodEnd: '2026-11-12T00:00:00.000Z' }]);
  });

  it('posts in chunks of 1000 and adds up what the registry kept', async () => {
    const sizes: number[] = [];
    const post = async (rows: IncentiveProgramReading[]) => {
      sizes.push(rows.length);
      return { inserted: 1, unchanged: rows.length - 1 };
    };
    const rows = Array.from({ length: 2500 }, (_, i) => reading(String(i)));
    expect(await postInChunks(post, rows, 'KALSHI', 'VENUE_API')).toEqual({ inserted: 3, unchanged: 2497 });
    expect(sizes).toEqual([1000, 1000, 500]);
  });

  it('closes unlisted programs at the UTC day start for a venue that lists only current programs', async () => {
    const posted: { rows: IncentiveProgramReading[]; source: string }[] = [];
    const result = await syncVenue('POLYMARKET_INTL', {
      read: async () => [reading('a')],
      closeUnlisted: (now) => new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000),
    }, new Date('2026-11-12T17:30:00Z'),
    async (rows, _code, source) => {
      posted.push({ rows, source });
      return { inserted: rows.length, unchanged: 0 };
    },
    async () => [reading('a'), reading('gone')]);
    expect(result).toMatchObject({ venue: 'POLYMARKET_INTL', read: 1, ended: 1, inserted: 2 });
    expect(posted[1].rows).toEqual([{ ...reading('gone'), periodEnd: '2026-11-12T00:00:00.000Z' }]);
  });
});
