import { readFileSync } from 'fs';
import { join } from 'path';
import { parseRefreshRequests, refreshMessage, RefreshError } from '../lambda/endpoints/listing-spec-refresh';
import { hyperliquidOutcomeSpec, hyperliquidPriceBands } from '../lambda/sync/venues/hyperliquid';
import { readLighterSpecs } from '../lambda/sync/venues/lighter';
import { SQSEvent } from 'aws-lambda';
import { SPEC_SYNC_EXCHANGES } from '../lambda/endpoints/spec-refresh-queue';
import {
  NEW_LISTING_WINDOW_MS, planSpecs, postInChunks, READERS, refreshes, refreshListing, Registry, scheduled, SpecRow,
  SpecSnapshot, SpecSnapshots, syncVenue, Target,
} from '../lambda/sync/spec-sync';
import { hashOf, SnapshotStore, Stored } from '../lambda/sync/metadata/snapshot';
import { kalshiPriceBands, readKalshiChangedSpecs, readKalshiSpecs } from '../lambda/sync/venues/kalshi';
import { readPolymarketIntlSpecs } from '../lambda/sync/venues/polymarket-intl';
import { readPolymarketUsSpecs } from '../lambda/sync/venues/polymarket-us';
import { complementBands, VenueSpec } from '../lambda/sync/venues/specs';

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'venues', name), 'utf8'));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const VECTORS = JSON.parse(readFileSync(join(__dirname, '..', '..', 'src', 'test', 'resources', 'price-grid-vectors.json'), 'utf8'));
const grid = (name: string) => VECTORS.grids[name].map(([start, end, step]: [number, number | null, number]) => ({ start, end, step }));

const LINEAR = [{ start: 0, end: 1_000_000_000, step: 10_000_000 }];
const TAPERED = grid('tapered_deci_cent');
const spec = (priceBands = LINEAR, extra: Partial<VenueSpec> = {}): VenueSpec =>
  ({ priceBands, lotSize: 10_000, minNotional: 0, minSize: 0, contractMultiplier: 1_000_000_000, ...extra });

afterEach(() => jest.restoreAllMocks());

/** Snapshots held in memory, one per venue, versioned so a save over a stale version fails as on S3. */
function memorySnapshots(initial: Record<string, SpecSnapshot> = {}) {
  const held = new Map<string, Stored<SpecSnapshot>>(
    Object.entries(initial).map(([venue, value]) => [venue, { value: structuredClone(value), version: '1' }]));
  let versions = 1;
  const snapshots: SpecSnapshots = (venue): SnapshotStore<SpecSnapshot> => ({
    load: async () => { const s = held.get(venue); return s ? structuredClone(s) : null; },
    save: async (value, version) => {
      if ((held.get(venue)?.version ?? null) !== version) return false;
      held.set(venue, { value: structuredClone(value), version: String(++versions) });
      return true;
    },
    replace: async (value) => { held.set(venue, { value: structuredClone(value), version: String(++versions) }); },
  });
  return { snapshots, held: (venue: string) => held.get(venue)?.value };
}
const noSnapshots = () => memorySnapshots().snapshots;

describe('Kalshi specs', () => {
  const markets: Record<string, any>[] = fixture('kalshi-markets.json').markets;
  const byStructure = (structure: string) => markets.find(m => m.price_level_structure === structure)!;

  it("reads each structure's price_ranges as the registry's bands", () => {
    expect(kalshiPriceBands(byStructure('linear_cent'))).toEqual(LINEAR);
    expect(kalshiPriceBands(byStructure('tapered_deci_cent'))).toEqual(TAPERED);
    expect(kalshiPriceBands(byStructure('center_deci_edge_centi_cent'))).toEqual(grid('center_deci_edge_centi_cent'));
    expect(kalshiPriceBands(byStructure('center_centi_edge_centi_cent'))).toEqual([{ start: 0, end: 1_000_000_000, step: 100_000 }]);
    expect(kalshiPriceBands({ price_ranges: [] })).toBeNull();
    expect(kalshiPriceBands({ price_ranges: [{ start: '0', end: '1', step: 'x' }] })).toBeNull();
  });

  it('mirrors a NO listing, and finds a market settled before the cutoff under /historical/markets', async () => {
    const tapered = byStructure('tapered_deci_cent').ticker;
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      if (String(url).includes('/historical/markets')) return json(fixture('kalshi-historical-markets.json'));
      return json(fixture('kalshi-markets.json'));
    });
    const specs = await readKalshiSpecs([`${tapered}:yes`, `${tapered}:no`, 'PRES-2024-DJT:yes', 'GONE-1:yes']);

    expect(specs.get(`${tapered}:yes`)).toEqual(spec(TAPERED));
    expect(specs.get(`${tapered}:no`)!.priceBands).toEqual(complementBands(TAPERED));
    expect(specs.get('PRES-2024-DJT:yes')).toEqual(spec(LINEAR));
    expect(specs.has('GONE-1:yes')).toBe(false);
    expect(urls.filter(u => u.includes('/historical/markets'))[0]).toContain('tickers=PRES-2024-DJT,GONE-1');
  });

  it('asks only the live endpoint when only listed markets are wanted', async () => {
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return json(fixture('kalshi-markets.json'));
    });
    const specs = await readKalshiSpecs(['PRES-2024-DJT:yes'], { listedOnly: true });
    expect(specs.has('PRES-2024-DJT:yes')).toBe(false);
    expect(urls.some(u => u.includes('/historical/markets'))).toBe(false);
  });
});

describe('Kalshi specs changed since a time', () => {
  const markets: Record<string, any>[] = fixture('kalshi-markets.json').markets;
  const tapered = markets.find(m => m.price_level_structure === 'tapered_deci_cent')!;

  it('pages through the metadata-updated markets, keying each under its YES and NO listings', async () => {
    const urls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return json(urls.length === 1 ? { markets: [tapered], cursor: 'next' } : { markets: [], cursor: '' });
    });
    const specs = await readKalshiChangedSpecs(new Date('2026-11-20T17:00:00Z'));
    expect(urls[0]).toContain('min_updated_ts=1795194000');
    expect(urls[0]).toContain('mve_filter=exclude');
    expect(urls[1]).toContain('cursor=next');
    expect(specs.get(tapered.ticker)).toEqual(spec(TAPERED));
    expect(specs.get(`${tapered.ticker}:yes`)).toEqual(spec(TAPERED));
    expect(specs.get(`${tapered.ticker}:no`)!.priceBands).toEqual(complementBands(TAPERED));
  });

  it('fails when Kalshi does', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));
    await expect(readKalshiChangedSpecs(new Date())).rejects.toThrow('changed since');
  });
});

describe('complementBands', () => {
  it("mirrors an asymmetric grid into its complement's prices", () => {
    expect(complementBands(grid('asymmetric'))).toEqual(grid('asymmetric_complement'));
    expect(complementBands(TAPERED)).toEqual(TAPERED);
  });
});

describe('Polymarket Intl specs', () => {
  it("reads each market's tick and minimum from Gamma, asking the CLOB for what Gamma leaves out", async () => {
    const markets: Record<string, any>[] = fixture('polymarket-intl-gamma-markets.json');
    const [full, missingTick] = markets;
    const gamma = [full, { ...missingTick, orderPriceMinTickSize: undefined }];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('clob.polymarket.com/markets/0xnone')) return new Response('', { status: 404 });
      if (u.includes('clob.polymarket.com/markets/')) return json({ minimum_tick_size: 0.001, minimum_order_size: 5 });
      return json(u.includes('closed=true') ? [] : gamma);
    });
    const specs = await readPolymarketIntlSpecs([`${full.conditionId}:1`, `${full.conditionId}:2`, `${missingTick.conditionId}:3`, '0xnone:4']);

    const tick = Math.round(Number(full.orderPriceMinTickSize) * 1e9);
    expect(specs.get(`${full.conditionId}:1`)).toEqual(spec([{ start: 0, end: 1_000_000_000, step: tick }],
      { minSize: Number(full.orderMinSize) * 1e6 }));
    expect(specs.get(`${full.conditionId}:2`)).toEqual(specs.get(`${full.conditionId}:1`));
    expect(specs.get(`${missingTick.conditionId}:3`)!.priceBands).toEqual([{ start: 0, end: 1_000_000_000, step: 1_000_000 }]);
    expect(specs.has('0xnone:4')).toBe(false);
  });

  it('reads only markets Gamma lists as open when asked for listed ones, asking neither its closed list nor the CLOB',
    async () => {
      const [open] = fixture('polymarket-intl-gamma-markets.json') as Record<string, any>[];
      const urls: string[] = [];
      jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
        urls.push(String(url));
        return json(String(url).includes('gamma-api') ? [open] : { minimum_tick_size: 0.01, minimum_order_size: 5 });
      });
      const specs = await readPolymarketIntlSpecs([`${open.conditionId}:1`, '0xold:2'], { listedOnly: true });

      expect([...specs.keys()]).toEqual([`${open.conditionId}:1`]);
      expect(urls.some(u => u.includes('closed=true'))).toBe(false);
      expect(urls.some(u => u.includes('clob.polymarket.com'))).toBe(false);
    });

  it('reads a market Gamma no longer lists from the CLOB', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('clob.polymarket.com/markets/0xold')) return json({ minimum_tick_size: 0.01, minimum_order_size: 5 });
      return json([]);
    });
    const specs = await readPolymarketIntlSpecs(['0xold:1']);

    expect(specs.get('0xold:1')).toEqual(spec([{ start: 0, end: 1_000_000_000, step: 10_000_000 }], { minSize: 5_000_000 }));
  });

  it('fails rather than skip a market the CLOB refuses to answer for', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('clob.polymarket.com')) return new Response('forbidden', { status: 403 });
      return json([]);
    });
    await expect(readPolymarketIntlSpecs(['0xold:1'])).rejects.toThrow('403');
  });

  it('writes nothing for a market neither Gamma nor the CLOB gives a tick', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('clob.polymarket.com')) return new Response('', { status: 404 });
      return json(u.includes('closed=true') ? [] : [{ conditionId: '0xa', orderMinSize: 5 }]);
    });
    expect((await readPolymarketIntlSpecs(['0xa:1'])).size).toBe(0);
  });
});

describe('Polymarket US specs', () => {
  it("reads each market's tick and minimum trade quantity for both legs", async () => {
    const markets: Record<string, any>[] = fixture('polymarket-us-markets.json').markets;
    jest.spyOn(global, 'fetch').mockImplementation(async () => json({ markets }));
    const slug = markets[0].slug;
    const specs = await readPolymarketUsSpecs([`${slug}:long`, `${slug}:short`]);
    const expected = spec([{ start: 0, end: 1_000_000_000, step: Math.round(markets[0].orderPriceMinTickSize * 1e9) }],
      { lotSize: markets[0].minimumTradeQty * 1e6 });
    expect(specs.get(`${slug}:long`)).toEqual(expected);
    expect(specs.get(`${slug}:short`)).toEqual(expected);
  });
});

describe('Hyperliquid price bands', () => {
  it('match the Java grid on the shared vectors', () => {
    expect(hyperliquidPriceBands(6, 5)).toEqual(grid('hyperliquid_perp_sz5'));
    expect(hyperliquidPriceBands(8, 0)).toEqual(grid('hyperliquid_spot_sz0'));
  });

  it('step a dollar everywhere when no decimals are allowed, and give up past a price unit', () => {
    expect(hyperliquidPriceBands(6, 6)).toEqual([{ start: 0, end: null, step: 1_000_000_000 }]);
    expect(hyperliquidPriceBands(12, 0)).toBeNull();
  });

  it('give outcome contracts their fixed spec and nothing else one', () => {
    expect(hyperliquidOutcomeSpec('#62070')!.priceBands).toEqual([{ start: 0, end: 1_000_000_000, step: 1_000_000 }]);
    expect(hyperliquidOutcomeSpec('BTC')).toBeNull();
  });
});

describe('Lighter specs', () => {
  it('give each market one open band at its price decimals', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => json({
      order_book_details: [{ market_id: 1, symbol: 'ETH', price_decimals: 2, size_decimals: 4, min_quote_amount: '10', status: 'active' }],
      spot_order_book_details: [],
    }));
    expect((await readLighterSpecs(['1', '2'])).get('1')).toEqual({
      priceBands: [{ start: 0, end: null, step: 10_000_000 }], lotSize: 100, minNotional: 10_000_000_000, minSize: 0,
      contractMultiplier: 1_000_000_000,
    });
  });
});

describe('planSpecs', () => {
  const seenAt = new Date('2026-11-18T12:00:00Z');
  const target = (listingId: number, current: VenueSpec | null): Target => ({ listingId, exchangeSecurityId: `M${listingId}`, current });

  it('writes a first spec undated, a change dated when it was seen, and nothing for the rest', () => {
    const read = new Map([
      ['M1', spec(TAPERED)],
      ['M2', spec(TAPERED)],
      ['M3', spec(LINEAR)],
      ['M5', spec([{ start: 0, end: 1_000_000_000, step: 30 }])],
    ]);
    const plan = planSpecs([target(1, null), target(2, spec(LINEAR)), target(3, spec(LINEAR)), target(4, spec()), target(5, null)],
      read, seenAt);
    expect(plan.rows).toEqual([
      { listingId: 1, ...spec(TAPERED) },
      { listingId: 2, ...spec(TAPERED), effectiveFrom: '2026-11-18T12:00:00.000Z' },
    ]);
    expect([plan.unchanged, plan.unknown, plan.invalid]).toEqual([1, 1, 1]);
  });

  it('sees a change in any band or size rule', () => {
    const changed = (other: VenueSpec) => planSpecs([target(1, spec())], new Map([['M1', other]]), seenAt).rows.length;
    expect(changed(spec(LINEAR, { lotSize: 1 }))).toBe(1);
    expect(changed(spec(LINEAR, { minSize: 5_000_000 }))).toBe(1);
    expect(changed(spec([{ start: 0, end: 1_000_000_000, step: 1_000_000 }]))).toBe(1);
    expect(changed(spec())).toBe(0);
  });
});

describe('postInChunks', () => {
  it('posts a refused chunk row by row, so one bad row costs only itself', async () => {
    const rows: SpecRow[] = [1, 2, 3].map(listingId => ({ listingId, ...spec() }));
    const sent: unknown[] = [];
    const result = await postInChunks(rows, async (body) => {
      sent.push(body);
      if (Array.isArray(body) || body.listingId === 2) throw new Error('refused');
    });
    expect(result).toEqual({ written: 2, refused: [2] });
    expect(sent).toHaveLength(4);
  });
});

describe('a refresh', () => {
  const posted: SpecRow[][] = [];
  const registry = (current: VenueSpec | null, exists = true): Registry => ({
    exchangeIds: async () => new Map([['POLYMARKET_INTL', 7]]),
    activeTargets: async () => [],
    unspeccedTargets: async () => [],
    target: async (_id, exchangeSecurityId) => (exists ? { listingId: 9, exchangeSecurityId, current } : null),
    createdListings: async () => [],
    currentSpecs: async () => new Map(),
    post: async (rows) => { posted.push(rows); return { written: rows.length, refused: [] }; },
  });
  const exchangeIds = new Map([['POLYMARKET_INTL', 7]]);
  const fine = spec([{ start: 0, end: 1_000_000_000, step: 1_000_000 }]);
  const request = { exchangeCode: 'POLYMARKET_INTL', exchangeSecurityId: '0xa:1', observedAt: '2026-11-18T12:00:00.000Z', newTick: 1_000_000 };

  beforeEach(() => { posted.length = 0; });

  it("records the venue's new tick dated when the shard saw it", async () => {
    const readers = { POLYMARKET_INTL: async () => new Map([['0xa:1', fine]]) };
    await refreshListing(request, registry(spec()), exchangeIds, readers);
    expect(posted).toEqual([[{ listingId: 9, ...fine, effectiveFrom: '2026-11-18T12:00:00.000Z' }]]);
  });

  it('is read again while the venue still shows the old tick', async () => {
    const readers = { POLYMARKET_INTL: async () => new Map([['0xa:1', spec()]]) };
    await expect(refreshListing(request, registry(spec()), exchangeIds, readers)).rejects.toThrow('still shows');
    expect(posted).toEqual([]);
  });

  it('is read again when the registry refuses the write', async () => {
    const readers = { POLYMARKET_INTL: async () => new Map([['0xa:1', fine]]) };
    const refusing = { ...registry(spec()), post: async (rows: SpecRow[]) => ({ written: 0, refused: rows.map(r => r.listingId) }) };
    await expect(refreshListing(request, refusing, exchangeIds, readers)).rejects.toThrow('refused');
  });

  it("holds back a listing's later notices once one of them fails, and lets other listings' through", async () => {
    let tick = spec();
    const readers = { POLYMARKET_INTL: async (ids: string[]) => new Map(ids.map(id => [id, tick])) };
    const record = (messageId: string, group: string, body: object) =>
      ({ messageId, body: JSON.stringify(body), attributes: { MessageGroupId: group } });
    const event = { Records: [
      record('m1', 'A', request),
      record('m2', 'A', { ...request, observedAt: '2026-11-18T12:01:00.000Z', newTick: undefined }),
      record('m3', 'B', { ...request, exchangeSecurityId: '0xb:2', newTick: undefined }),
    ] } as unknown as SQSEvent;
    tick = spec();
    const result = await refreshes(event, registry(spec([{ start: 0, end: 1_000_000_000, step: 5_000_000 }])), readers);
    expect(result.batchItemFailures.map(f => f.itemIdentifier)).toEqual(['m1', 'm2']);
    expect(posted.map(rows => rows.map(r => r.listingId))).toEqual([[9]]);
  });

  it('does nothing for a listing the registry has no row for', async () => {
    const readers = { POLYMARKET_INTL: async () => new Map([['0xa:1', fine]]) };
    expect(await refreshListing(request, registry(null, false), exchangeIds, readers)).toEqual({ written: 0 });
  });
});

describe('a pass', () => {
  it('reads the venue only when there are listings to check, and leaves first specs to the other passes', async () => {
    const read = jest.fn(async () => new Map([['M1', spec(TAPERED)], ['M2', spec(TAPERED)]]));
    const posted: SpecRow[] = [];
    const registry = {
      unspeccedTargets: async () => [],
      activeTargets: async () => [
        { listingId: 1, exchangeSecurityId: 'M1', current: spec() },
        { listingId: 2, exchangeSecurityId: 'M2', current: null },
      ],
      post: async (rows: SpecRow[]) => { posted.push(...rows); return { written: rows.length, refused: [] }; },
    } as unknown as Registry;
    expect(await syncVenue('KALSHI', 1, 'missing', registry, new Date(), { KALSHI: read }, noSnapshots()))
      .toEqual({ venue: 'KALSHI', targets: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(await syncVenue('KALSHI', 1, 'full', registry, new Date(), { KALSHI: read }, noSnapshots()))
      .toMatchObject({ venue: 'KALSHI', targets: 1, written: 1 });
    expect(read).toHaveBeenCalledWith(['M1'], { listedOnly: true });
    expect(posted.map(r => r.listingId)).toEqual([1]);
  });

  it('gives first specs to listings created within the window every minute, and to older ones in the daily pass', async () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const windowStart = new Date(now.getTime() - NEW_LISTING_WINDOW_MS);
    const asked: { after?: Date; before?: Date }[] = [];
    const read = jest.fn(async () => new Map([['M1', spec()]]));
    const posted: SpecRow[] = [];
    const registry = {
      unspeccedTargets: async (_exchangeId: number, created: { after?: Date; before?: Date }) => {
        asked.push(created);
        return [{ listingId: 1, exchangeSecurityId: 'M1', current: null }];
      },
      post: async (rows: SpecRow[]) => { posted.push(...rows); return { written: rows.length, refused: [] }; },
    } as unknown as Registry;
    await syncVenue('KALSHI', 1, 'new', registry, now, { KALSHI: read }, noSnapshots());
    await syncVenue('KALSHI', 1, 'missing', registry, now, { KALSHI: read }, noSnapshots());
    expect(asked).toEqual([{ after: windowStart }, { before: windowStart }]);
    expect(read).toHaveBeenCalledWith(['M1'], { listedOnly: false });
    expect(posted).toEqual([{ listingId: 1, ...spec() }, { listingId: 1, ...spec() }]);
  });

  it('runs one venue when asked, leaving the others to their own runs', async () => {
    const kalshi = jest.fn(async () => new Map());
    const lighter = jest.fn(async () => new Map());
    const registry = {
      exchangeIds: async () => new Map([['KALSHI', 1], ['LIGHTER', 2]]),
      activeTargets: async () => [{ listingId: 1, exchangeSecurityId: 'M1', current: spec() }],
      post: async () => ({ written: 0, refused: [] }),
    } as unknown as Registry;
    await scheduled('full', registry, noSnapshots(), 'LIGHTER', { KALSHI: kalshi, LIGHTER: lighter });
    expect(kalshi).not.toHaveBeenCalled();
    expect(lighter).toHaveBeenCalledTimes(1);
  });

  it('fails the run and reports it when the registry refuses a write', async () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = {
      exchangeIds: async () => new Map([['LIGHTER', 2]]),
      activeTargets: async () => [{ listingId: 1, exchangeSecurityId: 'M1', current: spec() }],
      post: async () => ({ written: 0, refused: [1] }),
    } as unknown as Registry;
    const lighter = async () => new Map([['M1', spec(TAPERED)]]);
    await expect(scheduled('full', registry, noSnapshots(), 'LIGHTER', { LIGHTER: lighter })).rejects.toThrow('LIGHTER');
    const metrics = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).find(m => m?._aws);
    expect(metrics).toMatchObject({ Kind: 'specs', Mode: 'full', Venue: 'LIGHTER', Ok: 0, Refused: 1, Listings: 1 });
  });

  it('has a reader for exactly the exchanges the refresh endpoint takes', () => {
    expect(Object.keys(READERS).sort()).toEqual([...SPEC_SYNC_EXCHANGES].sort());
  });
});

describe('the snapshot', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  const tick = spec([{ start: 0, end: 1_000_000_000, step: 1_000_000 }]);

  function fakeRegistry(opts: { current?: Map<number, VenueSpec>; created?: Omit<Target, 'current'>[]; refuse?: number[] } = {}) {
    const posted: SpecRow[] = [];
    const confirmed: number[][] = [];
    const createdSince: Date[] = [];
    const registry = {
      activeTargets: async () => [
        { listingId: 1, exchangeSecurityId: 'M1', current: spec() },
        { listingId: 2, exchangeSecurityId: 'M2', current: spec() },
        { listingId: 3, exchangeSecurityId: 'M3', current: null },
      ],
      createdListings: async (_id: number, after: Date) => { createdSince.push(after); return opts.created ?? []; },
      currentSpecs: async (ids: number[]) => {
        confirmed.push(ids);
        return new Map([...(opts.current ?? new Map())].filter(([id]) => ids.includes(id)));
      },
      post: async (rows: SpecRow[]) => {
        posted.push(...rows);
        const refused = rows.map(r => r.listingId).filter(id => opts.refuse?.includes(id));
        return { written: rows.length - refused.length, refused };
      },
    } as unknown as Registry;
    return { registry, posted, confirmed, createdSince };
  }

  it('is rebuilt by a full pass from every active listing, recording nothing where the write was refused', async () => {
    const { snapshots, held } = memorySnapshots();
    const { registry } = fakeRegistry({ refuse: [2] });
    const read = async () => new Map([['M1', spec()], ['M2', tick]]);
    await syncVenue('KALSHI', 1, 'full', registry, now, { KALSHI: read }, snapshots);
    expect(held('KALSHI')).toEqual({
      listedThrough: now.toISOString(),
      listings: { 1: ['M1', hashOf(spec())], 2: ['M2', null], 3: ['M3', null] },
    });
  });

  it('lets a sweep check the registry only for listings whose venue spec moved, and records what it wrote', async () => {
    const { snapshots, held } = memorySnapshots({ KALSHI: {
      listedThrough: '2026-11-18T11:45:00.000Z',
      listings: { 1: ['M1', hashOf(spec())], 2: ['M2', hashOf(spec())], 3: ['M3', null] },
    } });
    const { registry, posted, confirmed, createdSince } = fakeRegistry({
      current: new Map([[1, spec()], [2, spec()]]),
      created: [{ listingId: 4, exchangeSecurityId: 'M4' }],
    });
    const read = jest.fn(async () => new Map([['M1', spec()], ['M2', tick], ['M3', spec()], ['M4', spec()]]));
    const result = await syncVenue('KALSHI', 1, 'sweep', registry, now, { KALSHI: read }, snapshots);

    expect(createdSince).toEqual([new Date('2026-11-18T11:40:00.000Z')]);
    expect(read).toHaveBeenCalledWith(['M1', 'M2', 'M3', 'M4'], { listedOnly: true });
    // M3 and M4 have no spec yet: theirs are the new and missing passes' to give.
    expect(confirmed).toEqual([[2, 3, 4]]);
    expect(posted).toEqual([{ listingId: 2, ...tick, effectiveFrom: now.toISOString() }]);
    expect(result).toMatchObject({ targets: 4, moved: 3, written: 1, snapshotSaved: true });
    expect(held('KALSHI')).toEqual({
      listedThrough: now.toISOString(),
      listings: { 1: ['M1', hashOf(spec())], 2: ['M2', hashOf(tick)], 3: ['M3', null], 4: ['M4', null] },
    });
  });

  it("counts the moves a venue's changed-since read would have missed, leaving listings with nothing recorded out", async () => {
    const { snapshots } = memorySnapshots({ KALSHI: {
      listedThrough: '2026-11-18T11:45:00.000Z',
      listings: { 1: ['M1', hashOf(spec())], 2: ['M2', hashOf(spec())], 3: ['M3', null] },
    } });
    const { registry } = fakeRegistry({ current: new Map([[1, spec()], [2, spec()]]) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const asked: Date[] = [];
    const changed = async (since: Date) => { asked.push(since); return new Map([['M1', tick]]); };
    const read = async () => new Map([['M1', tick], ['M2', tick], ['M3', spec()]]);
    const result = await syncVenue('KALSHI', 1, 'sweep', registry, now, { KALSHI: read }, snapshots, { KALSHI: changed });
    expect(asked).toEqual([new Date('2026-11-18T11:40:00.000Z')]);
    expect(result).toMatchObject({ moved: 3, written: 2, changedRead: 1, changedMissed: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missed 1 moved listings, e.g. M2'));
  });

  it('keeps nothing recorded for a listing the registry refused, so the next sweep tries it again', async () => {
    const { snapshots, held } = memorySnapshots({ KALSHI: { listedThrough: now.toISOString(), listings: { 2: ['M2', hashOf(spec())] } } });
    const { registry } = fakeRegistry({ current: new Map([[2, spec()]]), refuse: [2] });
    await syncVenue('KALSHI', 1, 'sweep', registry, now, { KALSHI: async () => new Map([['M2', tick]]) }, snapshots);
    expect(held('KALSHI')!.listings[2]).toEqual(['M2', null]);
  });

  it('lets a sweep do nothing until a full pass has made the snapshot', async () => {
    const { registry } = fakeRegistry();
    const read = jest.fn(async () => new Map());
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await syncVenue('KALSHI', 1, 'sweep', registry, now, { KALSHI: read }, noSnapshots())).toEqual({ venue: 'KALSHI', targets: 0 });
    expect(read).not.toHaveBeenCalled();
  });

  it("doesn't save a sweep over a snapshot another run saved meanwhile", async () => {
    const { snapshots, held } = memorySnapshots({ KALSHI: { listedThrough: now.toISOString(), listings: { 1: ['M1', null] } } });
    const { registry } = fakeRegistry({ current: new Map([[1, spec()]]) });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const read = async () => {
      await snapshots('KALSHI').replace({ listedThrough: 'rebuilt', listings: {} });
      return new Map([['M1', spec()]]);
    };
    const result = await syncVenue('KALSHI', 1, 'sweep', registry, now, { KALSHI: read }, snapshots);
    expect(result.snapshotSaved).toBe(false);
    expect(held('KALSHI')!.listedThrough).toBe('rebuilt');
  });
});

describe('the refresh endpoint', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const body = (items: unknown) => JSON.stringify(items);
  const ok = { exchangeCode: 'POLYMARKET_INTL', exchangeSecurityId: '0xabc:123', observedAt: '2026-11-18T11:59:00Z', newTick: 1_000_000 };

  it('takes one notice or a batch', () => {
    expect(parseRefreshRequests(body(ok), now)).toEqual([{ ...ok, observedAt: '2026-11-18T11:59:00.000Z' }]);
    expect(parseRefreshRequests(body([ok, { ...ok, newTick: undefined }]), now)).toHaveLength(2);
  });

  it.each([
    ['no body', null],
    ['an empty batch', body([])],
    ['a lowercase exchange', body({ ...ok, exchangeCode: 'kalshi' })],
    ['an exchange the spec sync has no reader for', body({ ...ok, exchangeCode: 'BINANCE_SPOT' })],
    ['no listing', body({ ...ok, exchangeSecurityId: '' })],
    ['an old notice', body({ ...ok, observedAt: '2026-11-16T00:00:00Z' })],
    ['a notice from the future', body({ ...ok, observedAt: '2026-11-18T13:00:00Z' })],
    ['a fractional tick', body({ ...ok, newTick: 0.001 })],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseRefreshRequests(raw, now)).toThrow(RefreshError);
  });

  it('groups by listing and lets a repeat of one notice through once', () => {
    const [a, b] = [refreshMessage(parseRefreshRequests(body(ok), now)[0], 0),
      refreshMessage(parseRefreshRequests(body({ ...ok, observedAt: '2026-11-18T11:59:30Z' }), now)[0], 1)];
    expect(a.MessageGroupId).toBe(b.MessageGroupId);
    expect(a.MessageDeduplicationId).not.toBe(b.MessageDeduplicationId);
    expect(a.MessageGroupId.length).toBeLessThanOrEqual(128);
    expect(a.MessageDeduplicationId).toBe(refreshMessage(parseRefreshRequests(body(ok), now)[0], 5).MessageDeduplicationId);
  });
});
