import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectLedgerDatabase, createResponse, isSessionId, parseMode, parsePositiveInt } from './ledger-common';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

// A session's fills, or a strategy's across its sessions, newest first.
export function buildFillsQuery(params: Record<string, string | undefined>): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const where: string[] = [];
  if (params.sessionId) {
    if (!isSessionId(params.sessionId)) throw new Error('sessionId must be a session id');
    values.push(params.sessionId);
    where.push(`session_id = $${values.length}`);
  } else {
    const strategyId = parsePositiveInt(params.strategyId);
    const mode = parseMode(params.mode);
    if (strategyId === undefined || Number.isNaN(strategyId) || !mode) {
      throw new Error('Either sessionId, or strategyId and mode, are required');
    }
    values.push(strategyId, mode);
    where.push('strategy_id = $1', 'mode = $2');
  }
  const listingId = parsePositiveInt(params.listingId);
  if (Number.isNaN(listingId)) throw new Error('listingId must be a positive integer');
  if (listingId !== undefined) {
    values.push(listingId);
    where.push(`listing_id = $${values.length}`);
  }
  const limit = Math.min(parsePositiveInt(params.limit) || DEFAULT_LIMIT, MAX_LIMIT);
  values.push(limit);
  return {
    text: `SELECT * FROM ledger.fill WHERE ${where.join(' AND ')} ORDER BY fill_id DESC LIMIT $${values.length}`,
    values,
  };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  let query;
  try {
    query = buildFillsQuery(event.queryStringParameters ?? {});
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
