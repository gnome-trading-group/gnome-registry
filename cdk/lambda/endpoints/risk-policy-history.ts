import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectDatabase } from '../connections';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

const HISTORY_LIMIT = 100;

function createResponse(statusCode: number, body: any) {
  return {
    statusCode,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: CORS_HEADERS,
  };
}

// history_id is bigserial, which pg hands back as a string; the cast keeps historyId a JSON number like the
// other ids.
export function generateHistoryQuery(policyId: number): string {
  return `
    SELECT history_id::integer AS "historyId", policy_id AS "policyId", action,
           old_enabled AS "oldEnabled", new_enabled AS "newEnabled",
           old_parameters AS "oldParameters", new_parameters AS "newParameters",
           actor, reason, changed_at AS "changedAt"
    FROM risk.policy_history
    WHERE policy_id=${policyId}
    ORDER BY changed_at DESC, history_id DESC
    LIMIT ${HISTORY_LIMIT};
  `;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const policyId = Number(event.queryStringParameters?.policyId);
  if (!Number.isInteger(policyId) || policyId <= 0) {
    return createResponse(400, { message: 'policyId must be a positive integer' });
  }

  const pool = await connectDatabase();
  const client = await pool.connect();
  try {
    const result = await client.query(generateHistoryQuery(policyId));
    return createResponse(200, result.rows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('History error:', message, stack);
    return createResponse(500, { message, stack });
  } finally {
    client.release();
  }
};
