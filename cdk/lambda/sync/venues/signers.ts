import { createHmac, createPrivateKey, KeyObject, sign } from 'crypto';

// Request signing for the venues' account APIs, matching the gateways' Java signers: each signs the timestamp in
// milliseconds, the method and the path without its query string.

function signedPath(path: string): string {
  const query = path.indexOf('?');
  return query < 0 ? path : path.slice(0, query);
}

// Kalshi: Ed25519 (KalshiAuthSigner). Accounts hold Ed25519 keys only, as the gateway signs with nothing else.
export function kalshiHeaders(apiKey: string, privateKeyPem: string, method: string, path: string, nowMs: number) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Kalshi private key must be Ed25519, got ${key.asymmetricKeyType}`);
  }
  const timestamp = String(nowMs);
  const signature = sign(null, Buffer.from(`${timestamp}${method}${signedPath(path)}`), key);
  return {
    'KALSHI-ACCESS-KEY': apiKey,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
  };
}

// PKCS#8 wrapping for a raw 32-byte Ed25519 seed, which is how Node takes one.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// Polymarket US issues its secret as a base64 Ed25519 key, the 32-byte seed alone or followed by the public key
// (PolymarketUsAuthSigner.parseSecretKey).
export function polymarketUsKey(base64Secret: string): KeyObject {
  const decoded = Buffer.from(base64Secret, 'base64');
  if (decoded.length < 32) throw new Error(`Polymarket US secret must decode to at least 32 bytes, got ${decoded.length}`);
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, decoded.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
}

export function polymarketUsHeaders(apiKey: string, key: KeyObject, method: string, path: string, nowMs: number) {
  const timestamp = String(nowMs);
  const signature = sign(null, Buffer.from(`${timestamp}${method}${signedPath(path)}`), key);
  return {
    'X-PM-Access-Key': apiKey,
    'X-PM-Timestamp': timestamp,
    'X-PM-Signature': signature.toString('base64'),
  };
}

// Polymarket Intl's CLOB L2 auth (PolymarketIntlAuthHeaders): URL-safe base64 HMAC-SHA256, under the API key's
// URL-safe base64 secret, over the timestamp in seconds, the method and the path without its query.
export function polymarketIntlHeaders(
  credentials: { apiKey: string; secret: string; passphrase: string }, address: string, method: string, path: string,
  nowMs: number,
) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const key = Buffer.from(credentials.secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const signature = createHmac('sha256', key).update(`${timestamp}${method}${signedPath(path)}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
  return {
    POLY_ADDRESS: address,
    POLY_API_KEY: credentials.apiKey,
    POLY_PASSPHRASE: credentials.passphrase,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
  };
}
