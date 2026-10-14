import { generateKeyPairSync } from 'crypto';
import {
  CreateError, credentialsFor, MARKET_DATA_EXCHANGES, marketDataKeyStatus, needsKey, readSecretFor,
} from '../lambda/endpoints/venue-account-create';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();

const polymarket = {
  apiKey: 'k', secret: 's', passphrase: 'p',
  ethereumPrivateKey: `0x${'ab'.repeat(32)}`,
  signerAddress: `0x${'1'.repeat(40)}`,
  funderAddress: `0x${'2'.repeat(40)}`,
  signatureType: 3,
};

describe('venue account credentials', () => {
  it('stores Kalshi credentials as the orchestrator reads them, with an optional subaccount', () => {
    expect(credentialsFor('KALSHI', { apiKey: ' key ', privateKey: pem }, 'credentials'))
      .toEqual({ secret: { apiKey: 'key', privateKey: pem.trim() }, venueRef: {} });
    expect(credentialsFor('KALSHI', { apiKey: 'key', privateKey: pem, subaccount: '2' }, 'credentials'))
      .toEqual({ secret: { apiKey: 'key', privateKey: pem.trim(), subaccount: '2' }, venueRef: { subaccount: 2 } });
    expect(() => credentialsFor('KALSHI', { apiKey: 'key', privateKey: 'not a key' }, 'credentials'))
      .toThrow(/readable PEM/);
  });

  it('stores a Kalshi key as PKCS#8, the only form the orchestrator reads, even when uploaded as PKCS#1', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    expect(pkcs1).toContain('BEGIN RSA PRIVATE KEY');
    const { secret } = credentialsFor('KALSHI', { apiKey: 'key', privateKey: pkcs1 }, 'credentials');
    expect(secret.privateKey).toBe(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim());
    expect(secret.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  it('takes a Polymarket wallet\'s public addresses from the very credentials it signs with', () => {
    const { secret, venueRef } = credentialsFor('POLYMARKET_INTL', polymarket, 'credentials');
    expect(secret.signatureType).toBe('3');
    expect(venueRef).toEqual({
      signerAddress: polymarket.signerAddress, funderAddress: polymarket.funderAddress, signatureType: '3',
    });
    expect(() => credentialsFor('POLYMARKET_INTL', { ...polymarket, funderAddress: '0x12' }, 'credentials'))
      .toThrow(/funderAddress must be a 0x address/);
    expect(() => credentialsFor('POLYMARKET_INTL', { ...polymarket, ethereumPrivateKey: 'nope' }, 'credentials'))
      .toThrow(/32 bytes of hex/);
    expect(() => credentialsFor('POLYMARKET_INTL', { ...polymarket, signatureType: 7 }, 'credentials'))
      .toThrow(/signatureType/);
  });

  it('needs a Polymarket US Ed25519 key of at least 32 bytes', () => {
    const secret = Buffer.alloc(32, 7).toString('base64');
    expect(credentialsFor('POLYMARKET_US', { apiKey: 'k', secret }, 'credentials').secret).toEqual({ apiKey: 'k', secret });
    expect(() => credentialsFor('POLYMARKET_US', { apiKey: 'k', secret: 'c2hvcnQ=' }, 'credentials')).toThrow(/32 bytes/);
  });

  it('refuses a missing field, naming it, and a venue it can\'t trade', () => {
    expect(() => credentialsFor('KALSHI', { privateKey: pem }, 'credentials')).toThrow('credentials needs apiKey');
    expect(() => credentialsFor('UNKNOWN_VENUE', {}, 'credentials')).toThrow(CreateError);
  });

  it('needs every venue\'s own poller key except where the venue has no use for one', () => {
    expect(() => readSecretFor('KALSHI', undefined)).toThrow(/separate key for the poller/);
    expect(readSecretFor('KALSHI', { apiKey: 'ro', privateKey: pem })).toEqual({ apiKey: 'ro', privateKey: pem.trim() });
    expect(() => readSecretFor('POLYMARKET_US', undefined)).toThrow(/separate key for the poller/);
    const us = { apiKey: 'ro', secret: Buffer.alloc(32, 1).toString('base64') };
    expect(readSecretFor('POLYMARKET_US', us)).toEqual(us);
    expect(readSecretFor('POLYMARKET_INTL', undefined)).toBeNull();
    expect(() => readSecretFor('POLYMARKET_INTL', { apiKey: 'k' })).toThrow(/without credentials/);
  });

  it('keeps a market data key for every venue whose market data is signed', () => {
    expect(MARKET_DATA_EXCHANGES).toEqual({
      KALSHI: 'gnome/market-data/kalshi',
      POLYMARKET_US: 'gnome/market-data/polymarket-us',
    });
    expect(needsKey('POLYMARKET_INTL', 'marketData')).toBe(false);
    expect(needsKey('KALSHI', 'read')).toBe(true);
  });

  it('shows a market data key as in sync only when every trading region holds its current value', () => {
    const described = (statuses: Record<string, string>) => ({
      $metadata: {},
      LastChangedDate: new Date('2026-10-14T12:00:00Z'),
      Tags: [{ Key: 'updated-by', Value: 'ops@example.com' }, { Key: 'api-key-id', Value: 'f054773a-1' }],
      ReplicationStatus: Object.entries(statuses).map(([Region, Status]) => ({ Region, Status: Status as 'InSync' })),
    });
    const synced = marketDataKeyStatus('KALSHI', described({ 'ap-northeast-1': 'InSync', 'eu-west-1': 'InSync' }));
    expect(synced).toMatchObject({
      secretName: 'gnome/market-data/kalshi', exists: true, apiKeyId: 'f054773a-1', updatedBy: 'ops@example.com',
      lastChangedAt: '2026-10-14T12:00:00.000Z', inSync: true,
    });
    expect(marketDataKeyStatus('KALSHI', described({ 'ap-northeast-1': 'InSync', 'eu-west-1': 'Failed' })).inSync).toBe(false);
    const missingReplica = marketDataKeyStatus('KALSHI', described({ 'ap-northeast-1': 'InSync' }));
    expect(missingReplica.inSync).toBe(false);
    expect(missingReplica.replicas).toContainEqual({ region: 'eu-west-1', status: 'Missing', message: null });
    expect(marketDataKeyStatus('POLYMARKET_US', null)).toMatchObject({
      secretName: 'gnome/market-data/polymarket-us', exists: false, inSync: false,
    });
  });
});
