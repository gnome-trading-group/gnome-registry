import { readFileSync } from 'fs';
import { join } from 'path';
import { ValidationError } from '../lambda/endpoints/base';
import { dollars, parseProgram, ProgramVersion, trimToWindow } from '../lambda/endpoints/incentive-programs';
import { validateIncentiveDefinition } from '../lambda/incentives/definition';
import { isKalshiPayoutRun, postInChunks, syncVenue, unlistedEnded } from '../lambda/sync/incentive-sync';
import { parseKalshiIncentiveProgram, readKalshiIncentivePrograms, UNPAID_INCENTIVE_STATUSES } from '../lambda/sync/venues/kalshi';
import { parsePolymarketIntlRewardMarket } from '../lambda/sync/venues/polymarket-intl';
import {
  easternDayStart, kickoffTime, nextEasternMidnight, parsePolymarketUsIncentiveMarket, polymarketUsUnlistedEnd,
  readPolymarketUsIncentivePrograms,
} from '../lambda/sync/venues/polymarket-us';
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

  it('reads a payout sweep of hundreds of thousands of programs', async () => {
    const PAGES = 300;
    const program = byTicker('KXRT-VIO-60');
    const page = Array.from({ length: 1000 }, () => program);
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const params = new URL(String(url)).searchParams;
      const n = Number(params.get('cursor') ?? 0) + 1;
      const last = params.get('status') !== 'paid_out' || n === PAGES;
      return new Response(JSON.stringify({ incentive_programs: page, next_cursor: last ? '' : String(n) }));
    });
    try {
      const read = await readKalshiIncentivePrograms(new Date('2026-01-01T00:00:00Z'));
      expect(read).toHaveLength((UNPAID_INCENTIVE_STATUSES.length + PAGES) * 1000);
    } finally {
      jest.restoreAllMocks();
    }
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
      raw: null,
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

describe('Polymarket US incentive programs', () => {
  const markets: Record<string, any>[] = fixture('polymarket-us-incentives.json').programs;
  const market = (slug: string) => markets.find(m => m.marketSlug === slug)!;
  const read = (slug: string) => parsePolymarketUsIncentiveMarket(market(slug));
  const window = (slug: string) => Object.fromEntries(read(slug).map(p => [p.definition.period, [p.periodStart, p.periodEnd, p.rewardPer]]));

  it('reads a daily_event program: the program\'s pool per Eastern day, spread in cents', () => {
    const [p] = read('rotc-t-avedoo-2026-12-21-gte55');
    expect(p).toMatchObject({
      venueProgramId: 'culture_low_20260924_v2:rotc-t-avedoo-2026-12-21-gte55:daily_event',
      program: 'LIQUIDITY',
      venueMarket: 'rotc-t-avedoo-2026-12-21-gte55',
      periodStart: '2026-09-24T21:00:00.000Z',
      periodEnd: null,
      reward: '40',
      rewardPer: 'DAY',
      definition: {
        targetSize: 500, discountFactor: 0.25, maxSpreadCents: 6, period: 'daily_event', programId: 'culture_low_20260924_v2',
      },
      paidOut: null,
    });
    expect(() => validateIncentiveDefinition('POLYMARKET_US', p.definition)).not.toThrow();
  });

  it('reads a futures daily program per day too, with no spread when the venue gives none', () => {
    const [p] = read('aachc-bun-2027-05-22-relegation-aug');
    expect(p).toMatchObject({ reward: '8', rewardPer: 'DAY', periodEnd: null });
    expect(p.definition).toEqual({ targetSize: 2500, discountFactor: 0.35, period: 'daily', programId: 'soccer_futures_20261019' });
    expect(() => validateIncentiveDefinition('POLYMARKET_US', p.definition)).not.toThrow();
  });

  it('names the program whose pool a reward is, the same on every market it covers', () => {
    const markets = ['rotc-t-avedoo-2026-12-21-gte55', 'rotc-t-avedoo-2026-12-21-gte60'];
    const programs = markets.map(slug => parsePolymarketUsIncentiveMarket({ ...market('rotc-t-avedoo-2026-12-21-gte55'), marketSlug: slug })[0]);
    expect(programs.map(p => [p.venueProgramId, p.reward, p.definition.programId])).toEqual([
      ['culture_low_20260924_v2:rotc-t-avedoo-2026-12-21-gte55:daily_event', '40', 'culture_low_20260924_v2'],
      ['culture_low_20260924_v2:rotc-t-avedoo-2026-12-21-gte60:daily_event', '40', 'culture_low_20260924_v2'],
    ]);
  });

  it('keeps each of a market\'s programs on its own', () => {
    expect(read('aaagaspc-usgas-day-2026-11-17-gt3pt7700').map(p => [p.venueProgramId, p.reward])).toEqual([
      ['macro_low_20260924:aaagaspc-usgas-day-2026-11-17-gt3pt7700:daily_event', '15'],
      ['usgas_daily_ladder_20261110:aaagaspc-usgas-day-2026-11-17-gt3pt7700:daily_event', '200'],
    ]);
  });

  it('places pre-game and live periods on the market\'s kickoff, not the venue program\'s start', () => {
    // Kickoff 14:30 UTC; the venue programs began 2026-10-18 across every market they cover.
    expect(window('atc-bun-aug-mai-2026-11-22-aug')).toEqual({
      early: ['2026-10-18T18:00:00.000Z', '2026-11-22T08:30:00.000Z', 'PERIOD'],
      day_of: ['2026-11-22T08:30:00.000Z', '2026-11-22T14:30:00.000Z', 'PERIOD'],
      live: ['2026-11-22T14:30:00.000Z', null, 'PERIOD'],
    });
    expect(window('asc-cfb-akron-umass-2026-11-18-neg-10pt5')).toEqual({
      day_of: ['2026-11-18T18:00:00.000Z', '2026-11-19T00:00:00.000Z', 'PERIOD'],
      live: ['2026-11-19T00:00:00.000Z', null, 'PERIOD'],
    });
  });

  it('starts a window at the venue program\'s start when that comes later, and takes an end the venue gives', () => {
    const m = market('asc-cfb-akron-umass-2026-11-18-neg-10pt5');
    const late = { ...m, timePeriods: m.timePeriods.map((p: any) => ({ ...p, start: '2026-11-18T21:00:00Z', end: '2026-11-19T03:10:00Z' })) };
    expect(Object.fromEntries(parsePolymarketUsIncentiveMarket(late).map(p => [p.definition.period, [p.periodStart, p.periodEnd]])))
      .toEqual({
        day_of: ['2026-11-18T21:00:00.000Z', '2026-11-19T03:10:00.000Z'],
        live: ['2026-11-19T00:00:00.000Z', '2026-11-19T03:10:00.000Z'],
      });
  });

  it('reads the three ways the venue writes a kickoff', () => {
    expect(kickoffTime('2026-11-19 00:00:00+00')?.toISOString()).toBe('2026-11-19T00:00:00.000Z');
    expect(kickoffTime('2026-11-10T05:00:00.000Z')?.toISOString()).toBe('2026-11-10T05:00:00.000Z');
    expect(kickoffTime('2026-10-16T12:00:00-04:00')?.toISOString()).toBe('2026-10-16T16:00:00.000Z');
    expect(kickoffTime('')).toBeNull();
    expect(kickoffTime(undefined)).toBeNull();
  });

  it('posts nothing for a market that no longer trades', () => {
    expect(read('asc-nba-chi-cle-2026-11-16-q1-neg-2pt5')).toEqual([]);
    expect(read('astatc-nba-hou-mia-2026-11-16-ast-ametho-gte2')).toEqual([]);
  });

  it('skips a window period whose market has no kickoff, and programs that aren\'t liquidity', () => {
    const m = market('asc-cfb-akron-umass-2026-11-18-neg-10pt5');
    expect(parsePolymarketUsIncentiveMarket({ ...m, eventStartTime: '' })).toEqual([]);
    expect(parsePolymarketUsIncentiveMarket({ ...m, timePeriods: m.timePeriods.map((p: any) => ({ ...p, programType: 'volumeProgram' })) }))
      .toEqual([]);
  });

  it('fails on a period kind whose window it doesn\'t know', () => {
    const m = market('rotc-t-avedoo-2026-12-21-gte55');
    expect(() => parsePolymarketUsIncentiveMarket({ ...m, timePeriods: [{ ...m.timePeriods[0], period: 'overnight' }] }))
      .toThrow('overnight');
  });

  it('gives the spread in cents without floating-point noise', () => {
    const m = market('rotc-t-avedoo-2026-12-21-gte55');
    const [p] = parsePolymarketUsIncentiveMarket({ ...m, timePeriods: [{ ...m.timePeriods[0], maxSpread: 0.07 }] });
    expect(p.definition.maxSpreadCents).toBe(7);
  });

  it('gives terms the registry accepts, and refuses ones it couldn\'t score', () => {
    for (const m of markets) {
      for (const p of parsePolymarketUsIncentiveMarket(m)) {
        expect(() => validateIncentiveDefinition('POLYMARKET_US', p.definition)).not.toThrow();
      }
    }
    const ok = { targetSize: 500, discountFactor: 0.25, period: 'live', programId: 'nfl_spreads_live_20261110' };
    expect(() => validateIncentiveDefinition('POLYMARKET_US', { ...ok, discountFactor: 1.5 })).toThrow(ValidationError);
    expect(() => validateIncentiveDefinition('POLYMARKET_US', { ...ok, maxSpreadCents: 0 })).toThrow(ValidationError);
    expect(() => validateIncentiveDefinition('POLYMARKET_US', ok)).not.toThrow();
    expect(() => validateIncentiveDefinition('POLYMARKET_US', { ...ok, period: '' })).toThrow(ValidationError);
    expect(() => validateIncentiveDefinition('POLYMARKET_US', { targetSize: 500, discountFactor: 0.25, period: 'live' }))
      .toThrow(ValidationError);
    expect(() => validateIncentiveDefinition('POLYMARKET_US', { ...ok, minSize: 1 })).toThrow(ValidationError);
  });

  describe('reading the list', () => {
    afterEach(() => jest.restoreAllMocks());
    const page = (programs: Record<string, any>[], nextPageToken = '') => new Response(JSON.stringify({ programs, nextPageToken }));

    it('follows page_token, which the gateway reads where it ignores the documented pageToken', async () => {
      const urls: URL[] = [];
      jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const u = new URL(String(url));
        urls.push(u);
        return u.searchParams.get('page_token') === 'two' ? page(markets.slice(5)) : page(markets.slice(0, 5), 'two');
      });
      const result = await readPolymarketUsIncentivePrograms();
      expect(urls.map(u => [u.searchParams.get('page_size'), u.searchParams.get('page_token')])).toEqual([['500', null], ['500', 'two']]);
      expect(result.programs.map(p => p.venueMarket)).toContain('rotc-t-avedoo-2026-12-21-gte55');
      expect([...result.stopped].sort()).toEqual(['asc-nba-chi-cle-2026-11-16-q1-neg-2pt5', 'astatc-nba-hou-mia-2026-11-16-ast-ametho-gte2']);
    });

    it('fails when a page brings back only markets already read, as the documented parameters do', async () => {
      let n = 0;
      jest.spyOn(global, 'fetch').mockImplementation(async () => page(markets.slice(0, 5), `fresh-token-${n++}`));
      await expect(readPolymarketUsIncentivePrograms()).rejects.toThrow('repeats markets');
    });

    it('fails rather than return part of the list', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
        new URL(String(url)).searchParams.get('page_token') ? new Response('bad', { status: 400 }) : page(markets.slice(0, 5), 'two'));
      await expect(readPolymarketUsIncentivePrograms()).rejects.toThrow('page 1 failed: 400');
    });
  });

  describe('ending programs that leave the list', () => {
    const [daily] = read('rotc-t-avedoo-2026-12-21-gte55');
    const live = read('asc-cfb-akron-umass-2026-11-18-neg-10pt5').find(p => p.definition.period === 'live')!;
    const now = new Date('2026-11-17T02:30:00Z');

    it('runs a daily program to the end of the Eastern day its market stopped trading on', () => {
      expect(polymarketUsUnlistedEnd(daily, now, new Set([daily.venueMarket])).toISOString()).toBe('2026-11-17T05:00:00.000Z');
    });

    it('ends a daily program the venue dropped from a trading market with the last whole Eastern day', () => {
      expect(polymarketUsUnlistedEnd(daily, now, new Set()).toISOString()).toBe('2026-11-16T05:00:00.000Z');
    });

    it('ends a windowed program now', () => {
      expect(polymarketUsUnlistedEnd(live, now, new Set([live.venueMarket]))).toBe(now);
      expect(polymarketUsUnlistedEnd(live, now, new Set())).toBe(now);
    });

    it('finds Eastern midnight on the days daylight saving changes', () => {
      expect(easternDayStart(new Date('2026-03-08T12:00:00Z')).toISOString()).toBe('2026-03-08T05:00:00.000Z');
      expect(nextEasternMidnight(new Date('2026-03-08T12:00:00Z')).toISOString()).toBe('2026-03-09T04:00:00.000Z');
      expect(easternDayStart(new Date('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-11-01T04:00:00.000Z');
      expect(nextEasternMidnight(new Date('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-11-02T05:00:00.000Z');
      expect(easternDayStart(new Date('2026-11-17T04:59:59Z')).toISOString()).toBe('2026-11-16T05:00:00.000Z');
    });

    it('closes the market\'s programs once, through the sync, and leaves the ones still listed', async () => {
      const posted: IncentiveProgramReading[][] = [];
      const result = await syncVenue('POLYMARKET_US', {
        read: async () => ({ programs: [live], stopped: new Set([daily.venueMarket]) }),
        closeUnlisted: (program, at, venueRead) => polymarketUsUnlistedEnd(program, at, venueRead.stopped!),
      }, now, async (rows) => {
        posted.push(rows);
        return { inserted: rows.length, unchanged: 0 };
      }, async () => [live, daily]);
      expect(result).toMatchObject({ read: 1, ended: 1 });
      expect(posted[1]).toEqual([{ ...daily, periodEnd: '2026-11-17T05:00:00.000Z' }]);
    });
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
    expect(unlistedEnded([reading('a'), reading('b')], [reading('a')], () => end))
      .toEqual([{ ...reading('b'), periodEnd: '2026-11-12T00:00:00.000Z' }]);
  });

  it('keeps an end already recorded when it comes sooner, so a later run cannot push it back', () => {
    const ending = { ...reading('b'), periodEnd: '2026-11-13T05:00:00.000Z' };
    expect(unlistedEnded([ending], [], () => new Date('2026-11-14T05:00:00Z'))).toEqual([]);
    expect(unlistedEnded([ending], [], () => new Date('2026-11-12T17:00:00Z')))
      .toEqual([{ ...ending, periodEnd: '2026-11-12T17:00:00.000Z' }]);
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
      read: async () => ({ programs: [reading('a')] }),
      closeUnlisted: (_program, now) => new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000),
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
