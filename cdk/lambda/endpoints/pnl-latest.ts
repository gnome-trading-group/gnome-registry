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
    let where = '1=1';
    if (params?.strategyId) where += ` AND strategy_id=${params.strategyId}`;
    if (params?.listingId) where += ` AND listing_id=${params.listingId}`;

    const query = `
      SELECT DISTINCT ON (strategy_id, listing_id) *
      FROM pnl.snapshot
      WHERE ${where}
      ORDER BY strategy_id, listing_id, snapshot_time DESC;
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
