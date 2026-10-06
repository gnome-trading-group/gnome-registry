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

export function createResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: CORS_HEADERS,
  };
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
