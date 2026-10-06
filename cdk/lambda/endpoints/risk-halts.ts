import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectDatabase } from '../connections';
import { withTransaction } from './base';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

const MAX_STRATEGY_ID = 2147483647;
const DEFAULT_ACTOR = 'oms';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Exactly one target: a strategy halts every session of it (an OMS escalating a breach), a session halts just that
// running instance (an operator stopping it), and a strategy on one listing halts only that (a starting session that
// found an order on the venue it can't account for).
interface IRequestHalt {
  strategyId?: number;
  sessionId?: string;
  listingId?: number;
  reason: string;
  // Lets the session launcher (which has no DB access and calls this endpoint over HTTP) attribute the halt
  // to the operator who stopped the session instead of the OMS.
  actor?: string;
}

function createResponse(statusCode: number, body: any) {
  return {
    statusCode,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: CORS_HEADERS,
  };
}

export function isValidStrategyId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_STRATEGY_ID;
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export type HaltTarget = { strategyId: number; listingId?: number } | { sessionId: string };

// This only ever enables: a halt must not be reversible through the API-key path. The DO UPDATE is skipped
// when the switch is already on so repeated halts (OMS retries) don't churn the history table, and the
// fallback SELECT still returns the policy_id in that case. The fallback matches the target exactly, so a session's
// kill and its strategy's kill are never both returned. A session that doesn't exist inserts nothing and returns no
// rows.
export function generateHaltUpsertQuery(target: HaltTarget): string {
  const listing = 'sessionId' in target || target.listingId == null ? null : target.listingId;
  const source = 'sessionId' in target
    ? `SELECT 'KILL_SWITCH', session_id, strategy_id, NULL::integer, '{}'::jsonb, true
       FROM strategy.session WHERE session_id='${target.sessionId}'`
    : `SELECT 'KILL_SWITCH', NULL, ${target.strategyId}, ${listing ?? 'NULL::integer'}, '{}'::jsonb, true`;
  const match = 'sessionId' in target
    ? `session_id='${target.sessionId}' AND listing_id IS NULL`
    : `session_id IS NULL AND strategy_id=${target.strategyId} AND ${listing == null ? 'listing_id IS NULL' : `listing_id=${listing}`}`;
  return `
    WITH upserted AS (
      INSERT INTO risk.policy (policy_type, session_id, strategy_id, listing_id, parameters, enabled)
      ${source}
      ON CONFLICT (policy_type, COALESCE(session_id, ''), COALESCE(strategy_id, 0), COALESCE(listing_id, 0))
      DO UPDATE SET enabled=true, date_modified=NOW()
      WHERE risk.policy.enabled = false
      RETURNING policy_id
    )
    SELECT policy_id FROM upserted
    UNION ALL
    SELECT policy_id FROM risk.policy
    WHERE policy_type='KILL_SWITCH' AND ${match}
      AND NOT EXISTS (SELECT 1 FROM upserted);
  `;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  if (event.httpMethod !== 'POST') {
    return createResponse(400, { message: 'Invalid HTTP method' });
  }
  if (!event.body) {
    return createResponse(400, { message: 'Missing body' });
  }

  let request: IRequestHalt;
  try {
    request = JSON.parse(event.body) as IRequestHalt;
  } catch {
    return createResponse(400, { message: 'Body is not valid JSON' });
  }
  let target: HaltTarget;
  if (request?.listingId != null && (request.strategyId == null || request.sessionId != null)) {
    return createResponse(400, { message: 'listingId narrows a strategy halt and needs strategyId' });
  }
  if (request?.listingId != null && !isValidStrategyId(request.listingId)) {
    return createResponse(400, { message: 'listingId must be a positive integer' });
  }
  if (request?.sessionId != null && request?.strategyId == null) {
    if (!isValidSessionId(request.sessionId)) {
      return createResponse(400, { message: 'sessionId must be a session id' });
    }
    target = { sessionId: request.sessionId };
  } else if (request?.strategyId != null && request?.sessionId == null) {
    if (!isValidStrategyId(request.strategyId)) {
      return createResponse(400, { message: 'strategyId must be a positive integer' });
    }
    target = request.listingId != null
      ? { strategyId: request.strategyId, listingId: request.listingId }
      : { strategyId: request.strategyId };
  } else {
    return createResponse(400, { message: 'Exactly one of strategyId or sessionId is required' });
  }
  if (typeof request.reason !== 'string') {
    return createResponse(400, { message: 'reason must be a string' });
  }
  const actor = typeof request.actor === 'string' && request.actor.length > 0 ? request.actor : DEFAULT_ACTOR;

  const pool = await connectDatabase();
  const client = await pool.connect();
  try {
    const result = await withTransaction(
      client,
      (c) => c.query(generateHaltUpsertQuery(target)),
      { actor, reason: request.reason },
    );
    if (result.rowCount === 0 && 'sessionId' in target) {
      return createResponse(400, { message: `Unknown session ${target.sessionId}` });
    }
    if (result.rowCount !== 1) {
      return createResponse(500, { message: `Halt upsert returned ${result.rowCount} rows` });
    }
    return createResponse(200, { policyId: result.rows[0].policy_id, enabled: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('Halt error:', message, stack);
    return createResponse(500, { message, stack });
  } finally {
    client.release();
  }
};
