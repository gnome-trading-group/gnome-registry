import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId, WRITABLE_SESSION_STATUSES } from './ledger-common';

// A running session says it is alive, with the health of its parts (see the orchestrator's SessionHeartbeatAgent).
// Only the latest is kept. A session that has ended gets 409 and stops sending, so a stray heartbeat can never make
// a stopped session look alive.
const MAX_BODY_BYTES = 16 * 1024;

/** @return the HTTP status: 200 stored, 404 unknown session, 409 the session has ended */
export async function recordHeartbeat(client: PoolClient, sessionId: string, body: string): Promise<number> {
  const updated = await client.query(`
    UPDATE strategy.session SET last_heartbeat_at = NOW(), health = $2::jsonb - 'sessionId'
    WHERE session_id = $1 AND status = ANY($3::text[])`,
  [sessionId, body, WRITABLE_SESSION_STATUSES]);
  if (updated.rowCount === 1) return 200;
  const exists = await client.query('SELECT 1 FROM strategy.session WHERE session_id = $1', [sessionId]);
  return exists.rowCount === 0 ? 404 : 409;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  if (event.httpMethod !== 'POST') return createResponse(400, { message: 'Invalid HTTP method' });
  const body = event.body ?? '';
  if (body.length > MAX_BODY_BYTES) return createResponse(400, { message: 'Heartbeat too large' });
  let sessionId: unknown;
  try {
    sessionId = JSON.parse(body)?.sessionId;
  } catch {
    return createResponse(400, { message: 'Body must be JSON' });
  }
  if (!isSessionId(sessionId)) return createResponse(400, { message: 'sessionId must be a session id' });

  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const status = await recordHeartbeat(client, sessionId, body);
    return createResponse(status, status === 200 ? { ok: true } : { message: `Session ${sessionId} is not running` });
  } catch (error) {
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
