import { generateKeyPairSync } from 'crypto';
import { CreateError, credentialsFor } from '../lambda/endpoints/venue-account-create';

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
    expect(() => credentialsFor('BINANCE', {}, 'credentials')).toThrow(CreateError);
  });
});
