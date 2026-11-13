import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId, WRITABLE_SESSION_STATUSES } from './ledger-common';
import { parseSamples, storeSamples } from './samples';

// A running session says it is alive, with the health of its parts (see the orchestrator's SessionHeartbeatAgent).
// Only the latest is kept. A session that has ended gets 409 and stops sending, so a stray heartbeat can never make
// a stopped session look alive. A heartbeat also proves the session is running: the orchestrator reports RUNNING
// itself, but gives up after a few tries, and a session left STARTING would never be checked for going silent.
//
// A heartbeat may also carry `samples`, the readings the session collected since its last accepted post (see
// samples.ts). They are stored apart from the health, which every session list returns, and a failure to store
// them never fails the heartbeat: the session then counts them as sent, and losing some readings beats a session that
// looks silent. A minute's latency summaries can take tens of KB, hence the limit.
const MAX_BODY_BYTES = 64 * 1024;

/** @return the HTTP status: 200 stored, 404 unknown session, 409 the session has ended */
export async function recordHeartbeat(client: PoolClient, sessionId: string, body: string): Promise<number> {
  const updated = await client.query(`
    UPDATE strategy.session SET last_heartbeat_at = NOW(), health = $2::jsonb - 'sessionId' - 'samples'
    WHERE session_id = $1 AND status = ANY($3::text[])`,
  [sessionId, body, WRITABLE_SESSION_STATUSES]);
  if (updated.rowCount === 1) {
    await client.query(`
      UPDATE strategy.session SET status = 'RUNNING', date_modified = NOW()
      WHERE session_id = $1 AND status IN ('SUBMITTED', 'STARTING')`, [sessionId]);
    return 200;
  }
  const exists = await client.query('SELECT 1 FROM strategy.session WHERE session_id = $1', [sessionId]);
  return exists.rowCount === 0 ? 404 : 409;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  if (event.httpMethod !== 'POST') return createResponse(400, { message: 'Invalid HTTP method' });
  const body = event.body ?? '';
  if (body.length > MAX_BODY_BYTES) return createResponse(400, { message: 'Heartbeat too large' });
  let parsed: { sessionId?: unknown; samples?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return createResponse(400, { message: 'Body must be JSON' });
  }
  const sessionId = parsed?.sessionId;
  if (!isSessionId(sessionId)) return createResponse(400, { message: 'sessionId must be a session id' });

  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const status = await recordHeartbeat(client, sessionId, body);
    if (status !== 200) return createResponse(status, { message: `Session ${sessionId} is not running` });
    return createResponse(200, { ok: true, samplesStored: await samplesOf(client, sessionId, parsed.samples) });
  } catch (error) {
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};

/** Stores the heartbeat's samples; @return how many were new, never throwing */
export async function samplesOf(client: PoolClient, sessionId: string, raw: unknown): Promise<number> {
  const { samples, dropped } = parseSamples(raw, Date.now());
  if (dropped > 0) console.warn(`Session ${sessionId}: dropped ${dropped} malformed or out-of-range samples`);
  try {
    return await storeSamples(client, 'session', sessionId, samples);
  } catch (error) {
    console.error(`Session ${sessionId}: storing ${samples.length} samples failed:`,
      error instanceof Error ? error.message : String(error));
    return 0;
  }
}
