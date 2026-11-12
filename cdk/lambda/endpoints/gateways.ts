import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { PoolClient } from 'pg';
import { getActor, ResourceHandler, ValidationError, withTransaction } from './base';
import { connectLedgerDatabase, createResponse, isPositiveInt } from './ledger-common';
import { NOW, set, Sql, sql, where } from './sql';

// Order gateways: what an operator decides about each one (profile, pinned release), when a session last asked for it,
// and which venue accounts it holds. A live gateway's row is created by migration, one per venue with order entry; a
// paper gateway's (one per venue, simulating it) is created the first time a paper session wants it, so every exchange
// that can be paper-traded gets one without anything per exchange being written down.

const LIVE_PROFILES = ['standard', 'low_latency'];
const PAPER_KEY = /^paper:([a-z0-9_]+):[a-z0-9-]+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

interface IUpdateGateway {
  profile?: string;
  // null clears the pin.
  orchestratorVersion?: string | null;
  // Records that a session wants the gateway now; the registry's clock stamps it, not the caller's.
  wanted?: boolean;
}

export class AssignmentError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function profile(row: { mode: string }, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const allowed = row.mode === 'paper' ? ['paper'] : LIVE_PROFILES;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ValidationError(`profile must be one of ${allowed.join(', ')} for a ${row.mode} gateway`);
  }
  return value;
}

function orchestratorVersion(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new ValidationError('orchestratorVersion must be a release like 1.29.0, or null to clear it');
  }
  return value;
}

/**
 * Marks a paper gateway wanted, creating its row first if no paper session wanted it before: on its exchange (named by
 * the key, in lower case), in that exchange's region. Nothing is returned for an exchange that doesn't exist.
 */
export function generateWantPaperQuery(gatewayKey: string): Sql {
  const exchangeCode = PAPER_KEY.exec(gatewayKey)?.[1];
  if (!exchangeCode) throw new ValidationError(`${gatewayKey} isn't a paper gateway's key`);
  return sql`
    INSERT INTO account_master.gateway (gateway_key, mode, exchange_id, region, profile, wanted_at)
    SELECT ${gatewayKey}, 'paper', e.exchange_id, e.region, 'paper', ${NOW}
    FROM sm.exchange e WHERE lower(e.exchange_code) = ${exchangeCode}
    ON CONFLICT (gateway_key) DO UPDATE SET wanted_at = EXCLUDED.wanted_at, date_modified = ${NOW}
    RETURNING *`;
}

/** Whether a PATCH only marks a paper gateway wanted, which may create its row. */
function wantsPaper(params: APIGatewayProxyEventQueryStringParameters | null, body: string | null): boolean {
  if (!params?.gatewayKey || !PAPER_KEY.test(params.gatewayKey) || !body) return false;
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length === 1 && parsed.wanted === true;
  } catch {
    return false;
  }
}

export class GatewayHandler extends ResourceHandler {
  async modifyOne(params: APIGatewayProxyEventQueryStringParameters | null, body: string | null) {
    if (!wantsPaper(params, body)) return super.modifyOne(params, body);
    return this.runWrite(async () => {
      const result = await this.client.query(generateWantPaperQuery(params!.gatewayKey as string));
      if (result.rowCount !== 1) {
        return this.createResponse(404, { message: `No exchange for paper gateway ${params!.gatewayKey}` });
      }
      return this.createResponse(200, result.rows[0]);
    });
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    return sql`
      SELECT g.*, e.exchange_code,
        (SELECT COUNT(*) FROM account_master.gateway_account ga JOIN account_master.venue_account a USING (account_id)
         WHERE ga.gateway_key = g.gateway_key AND a.status IN ('ACTIVE', 'DRAINING'))::int AS accounts
      FROM account_master.gateway g LEFT JOIN sm.exchange e USING (exchange_id)${where([
        params?.gatewayKey && sql`g.gateway_key = ${params.gatewayKey}`,
        params?.mode && sql`g.mode = ${params.mode}`,
        params?.exchangeId && sql`g.exchange_id = ${params.exchangeId}`,
      ])}
      ORDER BY g.mode, g.gateway_key`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const g = JSON.parse(body) as IUpdateGateway;
    if (g.wanted !== undefined && g.wanted !== true) throw new ValidationError('wanted can only be true');
    return sql`UPDATE account_master.gateway SET ${set({
      profile: profile(row, g.profile),
      orchestrator_version: orchestratorVersion(g.orchestratorVersion),
      wanted_at: g.wanted ? NOW : undefined,
      date_modified: NOW,
    })} WHERE gateway_key = ${row['gateway_key']} RETURNING *`;
  }
}

// Assigns an account no gateway holds yet. Moving an account that a gateway already holds is refused: the holding
// gateway would have to cancel or hand over its orders and stop trading the account before another may start, and
// gateways don't hand accounts over yet.
export async function assignAccount(client: PoolClient, accountId: number, gatewayKey: string, actor: string) {
  const current = (await client.query(
    'SELECT gateway_key FROM account_master.gateway_account WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0];
  if (current?.gateway_key === gatewayKey) return current;
  if (current) {
    throw new AssignmentError(409,
      `Account ${accountId} is held by ${current.gateway_key}; moving it to another gateway isn't supported yet`);
  }
  try {
    return (await client.query(
      `INSERT INTO account_master.gateway_account (account_id, gateway_key, actor) VALUES ($1, $2, $3) RETURNING *`,
      [accountId, gatewayKey, actor])).rows[0];
  } catch (error) {
    const e = error as { code?: string; message?: string };
    // 23503: no such account or gateway; P0001: the trigger refusing a gateway on another exchange or the paper one.
    if (e.code === '23503' || e.code === 'P0001') throw new AssignmentError(400, e.message ?? 'Invalid assignment');
    throw error;
  }
}

async function handleAssignment(event: APIGatewayProxyEvent) {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const body = JSON.parse(event.body ?? '{}') as { accountId?: number; gatewayKey?: string };
    if (!isPositiveInt(body.accountId)) return createResponse(400, { message: 'accountId must be a positive integer' });
    if (typeof body.gatewayKey !== 'string') return createResponse(400, { message: 'gatewayKey is required' });
    const actor = getActor(event);
    const row = await withTransaction(
      client, (c) => assignAccount(c, body.accountId as number, body.gatewayKey as string, actor));
    return createResponse(200, row);
  } catch (error) {
    if (error instanceof AssignmentError) return createResponse(error.statusCode, { message: error.message });
    if (error instanceof SyntaxError) return createResponse(400, { message: 'Body is not valid JSON' });
    const message = error instanceof Error ? error.message : String(error);
    console.error('Gateway assignment error:', message);
    return createResponse(500, { message });
  } finally {
    client.release();
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  if (event.resource === '/gateways/accounts' && event.httpMethod === 'POST') {
    return await handleAssignment(event);
  }
  return await new GatewayHandler().handleEvent(event);
};
