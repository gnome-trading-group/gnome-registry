import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectLedgerDatabase, createResponse, isSessionId, parseMode, parsePositiveInt } from './ledger-common';

// What a strategy holds per listing and account, as its next session inherits it. Given the starting session, only
// what is held on the accounts that session was bound to: it trades through those, and the strategy's holdings on
// other accounts (a draining wallet) stay with them.
export function buildPositionsQuery(params: Record<string, string | undefined>): { text: string; values: unknown[] } {
  const strategyId = parsePositiveInt(params.strategyId);
  const mode = parseMode(params.mode);
  if (strategyId === undefined || Number.isNaN(strategyId)) throw new Error('strategyId is required');
  if (!mode) throw new Error('mode is required');
  const values: unknown[] = [strategyId, mode];
  let text = `SELECT p.strategy_id, p.listing_id, p.mode, p.account_id, p.net_quantity, p.total_cost, p.version,
      p.session_id, p.needs_review, p.updated_at
    FROM ledger.position p WHERE p.strategy_id = $1 AND p.mode = $2`;
  if (params.listingIds) {
    const ids = params.listingIds.split(',').map(Number);
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) throw new Error('listingIds must be positive integers');
    values.push(ids);
    text += ` AND p.listing_id = ANY($${values.length}::int[])`;
  }
  if (params.sessionId) {
    if (!isSessionId(params.sessionId)) throw new Error('sessionId must be a session id');
    values.push(params.sessionId);
    text += ` AND p.account_id IS NOT DISTINCT FROM (
      SELECT sva.account_id FROM sm.listing l
      JOIN account_master.session_venue_account sva ON sva.exchange_id = l.exchange_id
      WHERE l.listing_id = p.listing_id AND sva.session_id = $${values.length})`;
  }
  return { text: `${text} ORDER BY p.listing_id, p.account_id`, values };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  let query;
  try {
    query = buildPositionsQuery(event.queryStringParameters ?? {});
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    return createResponse(200, (await client.query(query)).rows);
  } catch (error) {
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
