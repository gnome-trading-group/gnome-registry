import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { getActor, withTransaction } from './base';
import { isLabel } from './gamertag';
import { connectLedgerDatabase, createResponse, isPositiveInt, isSessionId, WRITABLE_SESSION_STATUSES } from './ledger-common';
import { generateHaltUpsertQuery } from './risk-halts';
import { ACCOUNT_LOCK } from './venue-account-assignment';

// Venue accounts and the sessions bound to them. Registering one is the API key's (the account-creation Lambda, which
// puts the credentials in Secrets Manager: only the secret's name comes here); reading a session's bindings is the
// API key's too (a starting orchestrator); everything else, listing accounts and moving them through their
// lifecycle, is Cognito only, so each change is attributed to a person.

const SECRET_NAME_PATTERN = /^[A-Za-z0-9/_+=.@-]+$/;

// Which statuses an account may move to from each, and DRAINING may return to ACTIVE if it was drained by mistake.
const TRANSITIONS: Record<string, string[]> = {
  PROVISIONING: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['DRAINING'],
  DRAINING: ['ACTIVE', 'RETIRED'],
  RETIRED: [],
};

export class AccountError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

interface IRegisterAccount {
  exchangeId: number;
  label: string;
  venueRef?: Record<string, unknown>;
  tradingSecretName: string;
  readSecretName?: string | null;
  actor: string;
  note?: string;
}

export function parseRegistration(body: string): IRegisterAccount {
  const a = JSON.parse(body) as IRegisterAccount;
  if (!isPositiveInt(a.exchangeId)) throw new AccountError(400, 'exchangeId must be a positive integer');
  if (!isLabel(a.label)) throw new AccountError(400, 'label must be a gamer tag like sleepy-otter-42');
  if (typeof a.tradingSecretName !== 'string' || !SECRET_NAME_PATTERN.test(a.tradingSecretName)) {
    throw new AccountError(400, 'tradingSecretName must be a Secrets Manager secret name');
  }
  if (a.readSecretName != null && (typeof a.readSecretName !== 'string' || !SECRET_NAME_PATTERN.test(a.readSecretName))) {
    throw new AccountError(400, 'readSecretName must be a Secrets Manager secret name');
  }
  if (a.venueRef != null && (typeof a.venueRef !== 'object' || Array.isArray(a.venueRef))) {
    throw new AccountError(400, 'venueRef must be an object');
  }
  if (typeof a.actor !== 'string' || a.actor.trim().length === 0) throw new AccountError(400, 'actor is required');
  return a;
}

export async function registerAccount(client: PoolClient, a: IRegisterAccount) {
  try {
    const account = (await client.query(
      `INSERT INTO account_master.venue_account
         (exchange_id, label, venue_ref, trading_secret_name, read_secret_name, actor, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [a.exchangeId, a.label, a.venueRef ?? {}, a.tradingSecretName, a.readSecretName ?? null, a.actor, a.note ?? null],
    )).rows[0];
    await client.query('INSERT INTO treasury.account_config (account_id, actor) VALUES ($1, $2)', [account.account_id, a.actor]);
    return account;
  } catch (error) {
    const constraint = (error as { constraint?: string })?.constraint;
    if (constraint === 'venue_account_label_key') throw new AccountError(409, `Label ${a.label} is taken`);
    if ((error as { code?: string })?.code === '23503') throw new AccountError(400, `Unknown exchange ${a.exchangeId}`);
    throw error;
  }
}

export async function sessionAccounts(client: PoolClient, sessionId: string) {
  return (await client.query(
    `SELECT a.account_id, a.exchange_id, a.label, a.status, a.trading_secret_name, a.venue_ref
     FROM account_master.session_venue_account sva
     JOIN account_master.venue_account a USING (account_id)
     WHERE sva.session_id = $1 ORDER BY a.exchange_id`,
    [sessionId])).rows;
}

export async function listAccounts(client: PoolClient, exchangeId?: number) {
  return (await client.query(
    `SELECT a.account_id, a.exchange_id, e.exchange_code, a.label, a.status, a.venue_ref, a.trading_secret_name,
       a.read_secret_name, a.created_at, a.activated_at, a.draining_at, a.retired_at, a.actor, a.note,
       (SELECT COUNT(*) FROM account_master.session_venue_account sva
        JOIN strategy.session s USING (session_id)
        WHERE sva.account_id = a.account_id AND s.status = ANY($2::text[]))::int AS active_sessions,
       (SELECT COUNT(*) FROM ledger.position p
        WHERE p.account_id = a.account_id AND p.net_quantity <> 0)::int AS open_positions
     FROM account_master.venue_account a JOIN sm.exchange e USING (exchange_id)
     WHERE ($1::int IS NULL OR a.exchange_id = $1)
     ORDER BY a.exchange_id, a.status, a.label`,
    [exchangeId ?? null, WRITABLE_SESSION_STATUSES])).rows;
}

// Moves an account to a new status. Draining stops every session still trading on it at once, by enabling its
// session kill switch: a draining wallet must not open anything new, and its sessions are relaunched onto another
// account. Retiring needs it to be empty of sessions, positions and open orders.
export async function changeStatus(client: PoolClient, accountId: number, status: string, reason: string) {
  const current = (await client.query(
    'SELECT account_id, exchange_id, label, status FROM account_master.venue_account WHERE account_id = $1',
    [accountId])).rows[0];
  if (!current) throw new AccountError(404, `Unknown account ${accountId}`);
  // Same lock as choosing an account for a new session, so no session can be bound while this account changes.
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ACCOUNT_LOCK, current.exchange_id]);
  const account = (await client.query(
    'SELECT * FROM account_master.venue_account WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0];
  if (!(TRANSITIONS[account.status] ?? []).includes(status)) {
    throw new AccountError(409, `Account ${account.label} can't go from ${account.status} to ${status}`);
  }

  const sessions = (await client.query(
    `SELECT s.session_id FROM account_master.session_venue_account sva JOIN strategy.session s USING (session_id)
     WHERE sva.account_id = $1 AND s.status = ANY($2::text[]) ORDER BY s.session_id`,
    [accountId, WRITABLE_SESSION_STATUSES])).rows.map(r => r.session_id as string);

  if (status === 'RETIRED') {
    if (sessions.length > 0) throw new AccountError(409, `Sessions still run on ${account.label}: ${sessions.join(', ')}`);
    const held = (await client.query(
      `SELECT
         (SELECT COUNT(*) FROM ledger.position WHERE account_id = $1 AND net_quantity <> 0)::int AS positions,
         (SELECT COUNT(*) FROM ledger.order WHERE account_id = $1 AND status = 'OPEN')::int AS orders`,
      [accountId])).rows[0];
    if (held.positions > 0 || held.orders > 0) {
      throw new AccountError(409,
        `${account.label} still holds ${held.positions} position(s) and ${held.orders} open order(s)`);
    }
  }
  if (status === 'DRAINING') {
    for (const sessionId of sessions) {
      await client.query(generateHaltUpsertQuery({ sessionId }));
    }
  }

  const column = { ACTIVE: 'activated_at', DRAINING: 'draining_at', RETIRED: 'retired_at' }[status];
  const updated = (await client.query(
    `UPDATE account_master.venue_account SET status = $2${column ? `, ${column} = NOW()` : ''}
     WHERE account_id = $1 RETURNING *`,
    [accountId, status])).rows[0];
  return { account: updated, haltedSessions: status === 'DRAINING' ? sessions : [], reason };
}

function isCognito(event: APIGatewayProxyEvent): boolean {
  return event.resource?.startsWith('/cognito/') ?? false;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const resource = (event.resource ?? '').replace(/^\/cognito\//, '/');
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    if (resource === '/strategy-sessions/accounts' && event.httpMethod === 'GET') {
      const sessionId = event.queryStringParameters?.sessionId;
      if (!isSessionId(sessionId)) return createResponse(400, { message: 'sessionId must be a session id' });
      return createResponse(200, await sessionAccounts(client, sessionId));
    }
    // The account-creation Lambda (outside the VPC) deleting a retired account's secrets: names and status only.
    if (resource === '/venue-accounts/secrets' && event.httpMethod === 'GET' && !isCognito(event)) {
      const accountId = Number(event.queryStringParameters?.accountId);
      if (!isPositiveInt(accountId)) return createResponse(400, { message: 'accountId must be a positive integer' });
      const row = (await client.query(
        `SELECT label, status, trading_secret_name, read_secret_name FROM account_master.venue_account
         WHERE account_id = $1`, [accountId])).rows[0];
      return row ? createResponse(200, row) : createResponse(404, { message: `Unknown account ${accountId}` });
    }
    if (resource === '/venue-accounts' && event.httpMethod === 'POST' && !isCognito(event)) {
      const registration = parseRegistration(event.body ?? '');
      const row = await withTransaction(client, (c) => registerAccount(c, registration),
        { actor: registration.actor, reason: 'registered' });
      return createResponse(200, row);
    }
    if (resource === '/venue-accounts' && event.httpMethod === 'GET' && isCognito(event)) {
      const exchangeId = event.queryStringParameters?.exchangeId;
      return createResponse(200, await listAccounts(client, exchangeId ? Number(exchangeId) : undefined));
    }
    if (resource === '/venue-accounts/status' && event.httpMethod === 'PATCH' && isCognito(event)) {
      const body = JSON.parse(event.body ?? '{}') as { accountId?: number; status?: string; reason?: string };
      if (!isPositiveInt(body.accountId)) return createResponse(400, { message: 'accountId must be a positive integer' });
      if (typeof body.status !== 'string' || !(body.status in TRANSITIONS)) {
        return createResponse(400, { message: `status must be one of ${Object.keys(TRANSITIONS).join(', ')}` });
      }
      if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
        return createResponse(400, { message: 'reason is required' });
      }
      const actor = getActor(event);
      const result = await withTransaction(
        client, (c) => changeStatus(c, body.accountId as number, body.status as string, body.reason as string),
        { actor, reason: body.reason });
      return createResponse(200, result);
    }
    return createResponse(400, { message: `Unsupported ${event.httpMethod} ${event.resource}` });
  } catch (error) {
    if (error instanceof AccountError) return createResponse(error.statusCode, { message: error.message });
    if (error instanceof SyntaxError) return createResponse(400, { message: 'Body is not valid JSON' });
    const message = error instanceof Error ? error.message : String(error);
    console.error('Venue account error:', message);
    return createResponse(500, { message });
  } finally {
    client.release();
  }
};
