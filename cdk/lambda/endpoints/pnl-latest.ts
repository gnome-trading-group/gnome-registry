import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectDatabase } from '../connections';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

function createResponse(statusCode: number, body: any) {
  return {
    statusCode,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: CORS_HEADERS,
  };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectDatabase();
  const client = await pool.connect();
  try {
    const params = event.queryStringParameters;
    let where = 'ss.mode = \'LIVE\'';
    if (params?.strategyId) where += ` AND ps.strategy_id=${params.strategyId}`;
    if (params?.listingId) where += ` AND ps.listing_id=${params.listingId}`;

    const query = `
      SELECT DISTINCT ON (ps.strategy_id, ps.listing_id) ps.*
      FROM pnl.snapshot ps
      JOIN strategy.session ss ON ss.session_id = ps.session_id
      WHERE ${where}
      ORDER BY ps.strategy_id, ps.listing_id, ps.snapshot_time DESC;
    `;
    const result = await client.query(query);
    return createResponse(200, result.rows);
  } catch (error) {
    console.log(error);
    return createResponse(500, { message: error });
  } finally {
    client.release();
  }
};
