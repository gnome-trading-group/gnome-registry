import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectLedgerDatabase, createResponse, parseMode, parsePositiveInt } from './ledger-common';

// What a strategy holds per listing, as its next session inherits it.
export function buildPositionsQuery(params: Record<string, string | undefined>): { text: string; values: unknown[] } {
  const strategyId = parsePositiveInt(params.strategyId);
  const mode = parseMode(params.mode);
  if (strategyId === undefined || Number.isNaN(strategyId)) throw new Error('strategyId is required');
  if (!mode) throw new Error('mode is required');
  const values: unknown[] = [strategyId, mode];
  let text = `SELECT strategy_id, listing_id, mode, net_quantity, total_cost, version, session_id, needs_review, updated_at
    FROM ledger.position WHERE strategy_id = $1 AND mode = $2`;
  if (params.listingIds) {
    const ids = params.listingIds.split(',').map(Number);
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) throw new Error('listingIds must be positive integers');
    values.push(ids);
    text += ` AND listing_id = ANY($3::int[])`;
  }
  return { text: `${text} ORDER BY listing_id`, values };
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
