import { APIGatewayProxyEvent } from 'aws-lambda';
import { AccrualPostError, insertAccruals, latestAccruals } from '../rewards/accruals';
import { connectLedgerDatabase, createResponse, isSessionId, parseMode, parsePositiveInt } from './ledger-common';

// A paper session's estimated venue liquidity rewards (ledger.reward_accrual). The session's rewards agent posts its
// scorer's snapshots here, apart from /ledger/batch, so a reward problem can never fence the session's trading:
//   POST {sessionId, accruals: [...]}   stores them; a row that doesn't parse or isn't the session's is skipped and
//                                       counted, and only a body that isn't an object of that shape is a 400
//   GET ?sessionId=                     the session's latest snapshot per listing and program
//   GET ?strategyId=&mode=              the same for each of the strategy's sessions in a mode
export const handler = async (event: APIGatewayProxyEvent) => {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return createResponse(400, { message: 'Invalid HTTP method' });
  }
  let body: { sessionId?: unknown; accruals?: unknown } | null = null;
  const params = event.queryStringParameters ?? {};
  if (event.httpMethod === 'POST') {
    try {
      body = JSON.parse(event.body ?? '');
    } catch {
      return createResponse(400, { message: 'The body must be JSON' });
    }
    if (body == null || typeof body !== 'object') return createResponse(400, { message: 'The body must be an object' });
  } else if (!isSessionId(params.sessionId) && parsePositiveInt(params.strategyId) === undefined) {
    return createResponse(400, { message: 'give sessionId, or strategyId' });
  }

  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    if (body !== null) {
      const result = await insertAccruals(client, body.sessionId, body.accruals);
      if (result.skipped > 0) console.warn(`Reward accruals for ${String(body.sessionId)}: ${result.skipped} skipped`);
      return createResponse(200, result);
    }
    const accruals = await latestAccruals(client, {
      sessionId: isSessionId(params.sessionId) ? params.sessionId : undefined,
      strategyId: parsePositiveInt(params.strategyId),
      mode: parseMode(params.mode),
    });
    return createResponse(200, { accruals });
  } catch (error) {
    if (error instanceof AccrualPostError) return createResponse(400, { message: error.message });
    const message = error instanceof Error ? error.message : String(error);
    console.error('Reward accruals error:', message);
    return createResponse(500, { message });
  } finally {
    client.release();
  }
};
