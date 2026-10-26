import { connectDatabase } from '../connections';

// Ledger writes arrive several times a second from every running session; a small pool per container keeps a busy
// fleet from exhausting the database's connections.
export const LEDGER_POOL_SIZE = 2;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_INT = 2147483647;

// Lambda drops a response over 6 MB and API Gateway answers an opaque 502 that no log ties to a route, so a body near
// the limit is refused here, where the caller can be told to ask for less.
export const MAX_RESPONSE_BYTES = 5_500_000;

export function createResponse(statusCode: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_RESPONSE_BYTES) {
    return {
      statusCode: 413,
      body: JSON.stringify({ message: `Response of ${bytes} bytes is too large; ask for a narrower window or fewer rows` }),
      headers: CORS_HEADERS,
    };
  }
  return { statusCode, body: text, headers: CORS_HEADERS };
}

export function connectLedgerDatabase() {
  return connectDatabase(LEDGER_POOL_SIZE);
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_INT;
}

export function parsePositiveInt(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return isPositiveInt(parsed) ? parsed : NaN;
}

export function parseMode(value: string | undefined): 'paper' | 'live' | undefined {
  if (value == null || value === '') return undefined;
  const mode = value.toLowerCase();
  if (mode !== 'paper' && mode !== 'live') throw new Error(`mode must be paper or live, not ${value}`);
  return mode;
}

// Sessions that may still have a running process: their ledger writes are accepted while they hold their leases.
export const WRITABLE_SESSION_STATUSES = ['SUBMITTED', 'STARTING', 'RUNNING', 'STOPPING'];

// A listing some running session is on, in any strategy or mode: its OMS records the listing's marks. A session still
// waiting for its instance holds the lease but prices nothing yet, so the mark poller keeps the listing until it runs.
export function watchedListing(listingId: string): string {
  return `EXISTS (SELECT 1 FROM strategy.session_listing wl
    JOIN strategy.session ws ON ws.session_id = wl.session_id
    WHERE wl.listing_id = ${listingId} AND wl.active AND ws.status IN ('RUNNING', 'STOPPING'))`;
}
