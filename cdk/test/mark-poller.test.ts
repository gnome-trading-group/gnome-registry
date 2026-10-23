import { kalshiQuote, polymarketIntlQuote, polymarketUsQuote, UnwatchedListing } from '../lambda/sync/venues/books';

// The venues' public market data as they answered on 2026-10-23, trimmed to the fields read.
const listing = (exchange_security_id: string): UnwatchedListing =>
  ({ listing_id: 7, exchange_code: 'X', exchange_security_id });
const cents = (c: number) => BigInt(c) * 10_000_000n;

describe('Kalshi quotes', () => {
  const market = {
    ticker: 'KXNFLMOSTRECYDS-26OCT25NYGHOU-NYGMFIELDS88', status: 'active', last_price_dollars: '0.0300',
    yes_bid_dollars: '0.0100', yes_bid_size_fp: '543.00', yes_ask_dollars: '0.9400', yes_ask_size_fp: '16.00',
    no_bid_dollars: '0.0600', no_ask_dollars: '0.9900',
  };

  it('prices a YES listing from the YES book, with or without the side in its id', () => {
    for (const id of [market.ticker, `${market.ticker}:yes`]) {
      expect(kalshiQuote(listing(id), market)).toEqual({ listingId: 7, bid: cents(1), ask: cents(94), lastTrade: cents(3) });
    }
  });

  it('prices a NO listing as the complement of the YES book', () => {
    expect(kalshiQuote(listing(`${market.ticker}:no`), market))
      .toEqual({ listingId: 7, bid: cents(6), ask: cents(99), lastTrade: cents(97) });
  });

  it('reads an empty side from its zero size, whatever its price shows', () => {
    const empty = { ...market, last_price_dollars: '0.0000', yes_bid_dollars: '0.0000', yes_bid_size_fp: '0.00',
      yes_ask_dollars: '0.0000', yes_ask_size_fp: '0.00' };
    expect(kalshiQuote(listing(market.ticker), empty)).toEqual({ listingId: 7, bid: 0n, ask: 0n, lastTrade: 0n });
    expect(kalshiQuote(listing(`${market.ticker}:no`), { ...empty, yes_ask_dollars: '1.0000' }))
      .toEqual({ listingId: 7, bid: 0n, ask: 0n, lastTrade: 0n });
  });

  it('keeps sub-cent prices', () => {
    expect(kalshiQuote(listing(market.ticker), { ...market, yes_bid_dollars: '0.0125' })?.bid).toBe(12_500_000n);
  });

  it('gives no quote for a market that has stopped trading', () => {
    for (const status of ['closed', 'determined', 'finalized', 'settled', 'inactive']) {
      expect(kalshiQuote(listing(market.ticker), { ...market, status })).toBeNull();
    }
  });
});

describe('Polymarket Intl quotes', () => {
  it('takes the best level of each side, which the CLOB lists last', () => {
    const book = {
      asset_id: '1110', last_trade_price: '0.920',
      bids: [{ price: '0.01', size: '2220988.08' }, { price: '0.9', size: '243341.26' }, { price: '0.91', size: '28880.13' }],
      asks: [{ price: '0.99', size: '113359.44' }, { price: '0.93', size: '241855.61' }, { price: '0.92', size: '13294' }],
    };
    expect(polymarketIntlQuote(listing('0xdf9b:1110'), book))
      .toEqual({ listingId: 7, bid: cents(91), ask: cents(92), lastTrade: cents(92) });
  });

  it('reads a missing side or trade as unknown', () => {
    expect(polymarketIntlQuote(listing('0xdf9b:1110'), { bids: [{ price: '0.4', size: '0' }], asks: [], last_trade_price: '' }))
      .toEqual({ listingId: 7, bid: 0n, ask: 0n, lastTrade: 0n });
  });
});

describe('Polymarket US quotes', () => {
  const market = {
    slug: 'tec-mlb-champ-2026-09-27-mil', status: 'MARKET_STATUS_OPEN', closed: false,
    bestBidQuote: { value: '0.6480', currency: 'USD' }, bestAskQuote: { value: '0.6490', currency: 'USD' },
  };

  it('prices a long listing from the market\'s quotes and a short one as their complement', () => {
    expect(polymarketUsQuote(listing(`${market.slug}:long`), market))
      .toEqual({ listingId: 7, bid: 648_000_000n, ask: 649_000_000n, lastTrade: 0n });
    expect(polymarketUsQuote(listing(`${market.slug}:short`), market))
      .toEqual({ listingId: 7, bid: 351_000_000n, ask: 352_000_000n, lastTrade: 0n });
  });

  it('reads a side with no quote as empty', () => {
    expect(polymarketUsQuote(listing(`${market.slug}:short`), { ...market, bestAskQuote: undefined }))
      .toEqual({ listingId: 7, bid: 0n, ask: 352_000_000n, lastTrade: 0n });
  });

  it('gives no quote for a resolved or closed market', () => {
    expect(polymarketUsQuote(listing(`${market.slug}:long`), { ...market, status: 'MARKET_STATUS_RESOLVED', closed: true }))
      .toBeNull();
    expect(polymarketUsQuote(listing(`${market.slug}:long`), { ...market, closed: true })).toBeNull();
  });
});
