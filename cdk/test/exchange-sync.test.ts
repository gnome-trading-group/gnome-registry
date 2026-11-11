import { listingPatches } from '../lambda/sync/exchange-sync';
import { HyperliquidAdapter } from '../lambda/sync/exchanges/hyperliquid';
import { LighterAdapter } from '../lambda/sync/exchanges/lighter';
import { ExchangeFetch, ExchangeSecurityData, ListingResponse, SecurityType } from '../lambda/sync/exchanges/types';

// The venues' public market data as they answered on 2026-11-11, trimmed to the fields read.
const hyperliquid: Record<string, unknown> = {
  metaAndAssetCtxs: [
    { collateralToken: 0, universe: [
      { name: 'BTC', szDecimals: 5 },
      { name: 'MATIC', szDecimals: 1, isDelisted: true },
    ] },
    [{ dayNtlVlm: '2762856108.5' }, { dayNtlVlm: '0.0' }],
  ],
  spotMetaAndAssetCtxs: [
    {
      tokens: [{ name: 'USDC', szDecimals: 8 }, { name: 'PURR', szDecimals: 0 }, { name: 'HYPE', szDecimals: 2 }],
      universe: [{ name: 'PURR/USDC', tokens: [1, 0] }, { name: '@107', tokens: [2, 0] }],
    },
    [
      { coin: 'PURR/USDC', dayNtlVlm: '468067.69' },
      { coin: '@3', dayNtlVlm: '12.0' },
      { coin: '@107', dayNtlVlm: '91000000.0' },
    ],
  ],
  perpDexs: [null, { name: 'xyz' }, { name: 'flx' }],
  'metaAndAssetCtxs:xyz': [
    { collateralToken: 0, universe: [{ name: 'xyz:TSLA', szDecimals: 3 }] },
    [{ dayNtlVlm: '364940495.9' }],
  ],
};

function mockHyperliquid(failingDexes: string[] = []) {
  global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { type: string; dex?: string };
    const key = body.dex ? `${body.type}:${body.dex}` : body.type;
    if (body.dex && (failingDexes.includes(body.dex) || !(key in hyperliquid))) {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => hyperliquid[key] } as Response;
  }) as unknown as typeof fetch;
}

const bySymbol = (fetched: ExchangeFetch) =>
  new Map(fetched.securities.map((sec) => [sec.exchangeSecurityId, sec]));

describe('Hyperliquid adapter', () => {
  it('reads each perp and spot pair with its 24h volume and whether it still trades', async () => {
    mockHyperliquid();
    const securities = bySymbol(await new HyperliquidAdapter().fetchSecurities());

    expect(securities.get('BTC')).toMatchObject(
      { securityType: SecurityType.PERPETUAL, active: true, volume24h: 2762856108.5 });
    expect(securities.get('MATIC')).toMatchObject({ active: false, volume24h: 0 });
    expect(securities.get('xyz:TSLA')).toMatchObject({ securitySymbol: 'TSLA-USDC-PERP', volume24h: 364940495.9 });
    // A spot pair's context is found by its name, not its position: there are more contexts than pairs.
    expect(securities.get('PURR/USDC')).toMatchObject({ securityType: SecurityType.SPOT, volume24h: 468067.69 });
    expect(securities.get('@107')).toMatchObject({ securitySymbol: 'HYPE-USDC-SPOT', volume24h: 91000000 });
  });

  it('covers every listing but those of a DEX that failed to load', async () => {
    mockHyperliquid(['xyz']);
    const fetched = await new HyperliquidAdapter().fetchSecurities();

    expect(bySymbol(fetched).has('xyz:TSLA')).toBe(false);
    expect(fetched.covers('xyz:TSLA')).toBe(false);
    expect(fetched.covers('BTC')).toBe(true);
    expect(fetched.covers('@107')).toBe(true);
    expect(fetched.covers('gone:ABC')).toBe(true);
  });
});

describe('Lighter adapter', () => {
  it('reads each market with its 24h volume, active only while its status is', async () => {
    const market = (market_id: number, symbol: string, status: string, daily_quote_token_volume: number) => ({
      market_id, symbol, status, daily_quote_token_volume, price_decimals: 1, size_decimals: 5, min_quote_amount: '10',
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        order_book_details: [market(1, 'BTC', 'active', 824926683.2), market(90, 'MYX', 'inactive', 0)],
        spot_order_book_details: [market(2048, 'ETH/USDC', 'active', 51234.5)],
      }),
    })) as unknown as typeof fetch;

    const fetched = await new LighterAdapter().fetchSecurities();
    const securities = bySymbol(fetched);

    expect(securities.get('1')).toMatchObject({ securitySymbol: 'BTC-USDC-PERP', active: true, volume24h: 824926683.2 });
    expect(securities.get('90')).toMatchObject({ active: false, volume24h: 0 });
    expect(securities.get('2048')).toMatchObject({ securitySymbol: 'ETH-USDC-SPOT', volume24h: 51234.5 });
    expect(fetched.covers('12345')).toBe(true);
  });
});

describe('listing patches', () => {
  const sec = (exchangeSecurityId: string, overrides: Partial<ExchangeSecurityData> = {}): ExchangeSecurityData => ({
    baseCurrency: 'X', quoteCurrency: 'USDC', settleCurrency: 'USDC', securitySymbol: `${exchangeSecurityId}-PERP`,
    securityType: SecurityType.PERPETUAL, contractType: 1, assetClass: 0, inverse: false, isQuanto: false,
    exchangeSecurityId, exchangeSecuritySymbol: exchangeSecurityId, tickSize: 1, lotSize: 1, minNotional: 0,
    contractMultiplier: 1, active: true, volume24h: 100, ...overrides,
  });
  const listing = (listing_id: number, exchange_security_id: string, active: boolean, volume_24h: number | null):
    ListingResponse => ({
    listing_id, exchange_id: 3, security_id: listing_id, exchange_security_id,
    exchange_security_symbol: exchange_security_id, active, volume_24h,
  });
  const fetchOf = (securities: ExchangeSecurityData[], covers = (_: string) => true): ExchangeFetch =>
    ({ securities, covers });
  const types = (entries: [number, number][]) => new Map(entries);

  it('writes a changed volume or active flag, and nothing for a listing already up to date', () => {
    const patches = listingPatches(
      fetchOf([sec('BTC', { volume24h: 250 }), sec('ETH'), sec('MATIC', { active: false, volume24h: 0 }), sec('NEW')]),
      [listing(1, 'BTC', true, 100), listing(2, 'ETH', true, 100), listing(3, 'MATIC', true, null)],
      types([[1, SecurityType.PERPETUAL], [2, SecurityType.PERPETUAL], [3, SecurityType.PERPETUAL]]),
    );

    expect(patches).toEqual([
      { listingId: 1, volume24h: 250 },
      { listingId: 3, active: false, volume24h: 0 },
    ]);
  });

  it('brings back a listing the venue trades again', () => {
    expect(listingPatches(fetchOf([sec('BTC')]), [listing(1, 'BTC', false, 100)], types([[1, SecurityType.PERPETUAL]])))
      .toEqual([{ listingId: 1, active: true }]);
  });

  it('leaves the volume alone when the venue reports none', () => {
    expect(listingPatches(
      fetchOf([sec('BTC', { volume24h: undefined })]), [listing(1, 'BTC', true, 100)], types([[1, SecurityType.PERPETUAL]])))
      .toEqual([]);
  });

  it('retires an active listing the venue no longer returns, of a type it syncs, when the fetch covers it', () => {
    const patches = listingPatches(
      fetchOf([sec('BTC', { volume24h: 100 })], (id) => !id.startsWith('xyz:')),
      [
        listing(1, 'BTC', true, 100),
        listing(2, 'GONE', true, 5),
        listing(3, 'xyz:TSLA', true, 5),
        listing(4, 'OLD', false, 0),
        listing(5, '#120', true, null),
      ],
      types([
        [1, SecurityType.PERPETUAL], [2, SecurityType.PERPETUAL], [3, SecurityType.PERPETUAL],
        [4, SecurityType.PERPETUAL], [5, SecurityType.EVENT_CONTRACT],
      ]),
    );

    // xyz:TSLA's DEX failed to load, OLD is already retired, and #120 is an outcome contract the classifier keeps.
    expect(patches).toEqual([{ listingId: 2, active: false }]);
  });

  it('retires nothing on an empty fetch', () => {
    expect(listingPatches(fetchOf([]), [listing(1, 'BTC', true, 100)], types([[1, SecurityType.PERPETUAL]])))
      .toEqual([]);
  });
});
