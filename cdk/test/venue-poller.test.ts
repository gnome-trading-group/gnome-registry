import { constants, createPublicKey, generateKeyPairSync, verify } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readKalshi } from '../lambda/sync/venues/kalshi';
import { readPolymarketIntl } from '../lambda/sync/venues/polymarket-intl';
import { kalshiHeaders, polymarketUsHeaders, polymarketUsKey } from '../lambda/sync/venues/signers';
import { parseBalances, parsePositions } from '../lambda/sync/venues/polymarket-us';
import { scaleDecimal } from '../lambda/sync/venues/types';
import { venueKeyOf } from '../lambda/endpoints/treasury';

describe('venue request signing', () => {
  it('signs a Kalshi request over the timestamp, method and path without its query, with RSA-PSS', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const headers = kalshiHeaders('key-id', pem, 'GET', '/trade-api/v2/portfolio/positions?limit=1000', 1_700_000_000_000);
    expect(headers['KALSHI-ACCESS-KEY']).toBe('key-id');
    expect(headers['KALSHI-ACCESS-TIMESTAMP']).toBe('1700000000000');
    expect(verify('sha256', Buffer.from('1700000000000GET/trade-api/v2/portfolio/positions'), {
      key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
    }, Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64'))).toBe(true);
  });

  it('signs a Polymarket US request with the Ed25519 seed, whether or not the public key follows it', () => {
    const seed = Buffer.alloc(32, 7);
    for (const secret of [seed, Buffer.concat([seed, Buffer.alloc(32, 9)])]) {
      const key = polymarketUsKey(secret.toString('base64'));
      const headers = polymarketUsHeaders('key-id', key, 'GET', '/v1/account/balances', 42);
      expect(headers['X-PM-Timestamp']).toBe('42');
      expect(verify(null, Buffer.from('42GET/v1/account/balances'), createPublicKey(key),
        Buffer.from(headers['X-PM-Signature'], 'base64'))).toBe(true);
    }
    expect(() => polymarketUsKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('venue readings', () => {
  it('scales decimals without floating point', () => {
    expect(scaleDecimal('18.62557', 1_000_000_000n)).toBe(18_625_570_000n);
    expect(scaleDecimal(5.135136, 1_000_000n)).toBe(5_135_136n);
    expect(scaleDecimal('-0.4', 1_000_000n)).toBe(-400_000n);
    expect(scaleDecimal(1e-7, 1_000_000_000n)).toBe(100n);
    expect(scaleDecimal(7.352, 1_000_000n)).toBe(7_352_000n);
    expect(() => scaleDecimal('1e5', 1_000_000n)).toThrow();
  });

  it('takes the USD balance from a Polymarket US answer, and refuses one it can\'t read', () => {
    expect(parseBalances([{ currency: 'USD', currentBalance: '19.959', buyingPower: '19.5' }]))
      .toEqual({ total: 19_959_000_000n, available: 19_500_000_000n, margin: 0n });
    expect(parseBalances({ balances: [] })).toEqual({ total: 0n, available: 0n, margin: 0n });
    const captured = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'venues', 'polymarket-us-balances.json'), 'utf8'));
    expect(parseBalances(captured)).toEqual({ total: 412_000_000n, available: 412_000_000n, margin: 0n });
    expect(() => parseBalances([{ currency: 'USD', mystery: 1 }])).toThrow(/Unrecognized/);
  });
});

describe('venue keys', () => {
  it('match each venue\'s own position identity', () => {
    expect(venueKeyOf('KALSHI', 'KXT-26:no')).toEqual({ key: 'KXT-26', sign: -1n });
    expect(venueKeyOf('POLYMARKET_US', 'tec-mlb:short')).toEqual({ key: 'tec-mlb', sign: -1n });
    expect(venueKeyOf('POLYMARKET_INTL', '0x4bab29:6585997505')).toEqual({ key: '6585997505', sign: 1n });
  });
});

// Real answers captured in Phase 0 (Kalshi demo, the Polymarket Intl test wallet), replayed through the readers.
describe('venue readers on captured answers', () => {
  const fixture = (name: string) =>
    JSON.parse(readFileSync(join(__dirname, 'fixtures', 'venues', name), 'utf8'));
  const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

  afterEach(() => jest.restoreAllMocks());

  it('reads Kalshi cash to the sub-cent from its dollars field', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => respond(String(url).includes('/balance')
      ? fixture('kalshi-balance.json') : { market_positions: [], cursor: '' }) as unknown as Response);
    const reading = await readKalshi(
      { account_id: 1, exchange_id: 1, exchange_code: 'KALSHI', label: 'x', venue_ref: {}, read_secret_name: null },
      { apiKey: 'k', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    expect(reading.cashTotal).toBe(99_309_900_000n);
    expect(reading.cashByPartition).toEqual({ 0: 89_309_900_000n, 1: 0n, 2: 10_000_000_000n, 3: 0n });
  });

  it('reads Polymarket Intl positions keyed by token, with resolved losers worth nothing', async () => {
    process.env.POLYGON_RPC_URL = 'https://rpc.example';
    process.env.PUSD_TOKEN_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => respond(String(url).includes('rpc.example')
      ? { result: '0x0000000000000000000000000000000000000000000000000000000000f38054' }
      : fixture('polymarket-intl-positions.json')) as unknown as Response);
    const reading = await readPolymarketIntl({
      account_id: 2, exchange_id: 2, exchange_code: 'POLYMARKET_INTL', label: 'x', read_secret_name: null,
      venue_ref: { funderAddress: '0xe65019f319d3b20a9883b43283c91ca9d8c81cfb' },
    });
    expect(reading.cashTotal).toBe(15_958_100_000n);
    expect(reading.positions?.[0]).toEqual({
      venueKey: '65859975054715735368129844287010108827814341883420891032920701239041923945418',
      quantity: 10_000_000n, redeemable: true, value: 0n,
    });
    expect(reading.positions?.[1].quantity).toBe(7_352_000n);
  });
});

describe('Polymarket US positions, as captured in Phase 0', () => {
  const captured = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'venues', 'polymarket-us-positions.json'), 'utf8'));

  it('keys each position by market slug, long positive and short negative', () => {
    expect(parsePositions(captured.long)).toEqual([
      { venueKey: 'tec-mlb-nlchamp-2026-09-27-lad', quantity: 1_000_000n, redeemable: false, value: 307_000_000n },
    ]);
    expect(parsePositions(captured.short)[0].quantity).toBe(-1_000_000n);
    expect(parsePositions({ positions: {} })).toEqual([]);
  });

  it('holds a short\'s dollar back as margin, which the poller counts as spent', () => {
    expect(parseBalances(captured.balancesWithShort)).toEqual({
      total: 10_674_000_000n, available: 9_674_000_000n, margin: 1_000_000_000n,
    });
  });
});
