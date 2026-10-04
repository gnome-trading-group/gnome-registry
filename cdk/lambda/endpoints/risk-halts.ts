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
const STRATEGY_SCOPE = 1;

interface IRequestHalt {
  strategyId: number;
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
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_STRATEGY_ID;
}

// This only ever enables: a halt must not be reversible through the API-key path. The DO UPDATE is skipped
// when the switch is already on so repeated halts (OMS retries) don't churn the history table, and the
// fallback SELECT still returns the policy_id in that case.
export function generateHaltUpsertQuery(strategyId: number): string {
  return `
    WITH upserted AS (
      INSERT INTO risk.policy (policy_type, scope, strategy_id, listing_id, parameters, enabled)
      VALUES ('KILL_SWITCH', ${STRATEGY_SCOPE}, ${strategyId}, null, '{}', true)
      ON CONFLICT (policy_type, scope, COALESCE(strategy_id, 0), COALESCE(listing_id, 0))
      DO UPDATE SET enabled=true, date_modified=NOW()
      WHERE risk.policy.enabled = false
      RETURNING policy_id
    )
    SELECT policy_id FROM upserted
    UNION ALL
    SELECT policy_id FROM risk.policy
    WHERE policy_type='KILL_SWITCH' AND scope=${STRATEGY_SCOPE} AND strategy_id=${strategyId} AND COALESCE(listing_id, 0)=0
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
  if (!isValidStrategyId(request?.strategyId)) {
    return createResponse(400, { message: 'strategyId must be a non-negative integer' });
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
      (c) => c.query(generateHaltUpsertQuery(request.strategyId)),
      { actor, reason: request.reason },
    );
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
