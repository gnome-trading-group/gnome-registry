import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectDatabase } from '../connections';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters;
      let query = 'SELECT * FROM pnl.snapshot WHERE 1=1';
      if (params?.strategyId) query += ` AND strategy_id=${params.strategyId}`;
      if (params?.listingId) query += ` AND listing_id=${params.listingId}`;
      query += ' ORDER BY snapshot_time DESC';
      if (params?.limit) query += ` LIMIT ${params.limit}`;
      const result = await client.query(query);
      return createResponse(200, result.rows);
    }

    if (event.httpMethod === 'POST') {
      if (!event.body) return createResponse(400, { message: 'Missing body' });

      const parsed = JSON.parse(event.body);
      const snapshots = Array.isArray(parsed) ? parsed : [parsed];

      if (snapshots.length === 0) return createResponse(400, { message: 'Empty array' });

      const values = snapshots.map(s =>
        `(${s.strategyId}, ${s.listingId}, ${s.netQuantity}, ${s.avgEntryPrice}, ${s.realizedPnl}, ${s.totalFees}, ${s.leavesBuyQty ?? 0}, ${s.leavesSellQty ?? 0})`
      ).join(', ');

      const query = `
        INSERT INTO pnl.snapshot
          (strategy_id, listing_id, net_quantity, avg_entry_price, realized_pnl, total_fees, leaves_buy_qty, leaves_sell_qty)
        VALUES ${values}
        RETURNING *;
      `;
      const result = await client.query(query);
      return createResponse(200, result.rows);
    }

    return createResponse(400, { message: 'Invalid HTTP method' });
  } catch (error) {
    console.log(error);
    return createResponse(500, { message: error });
  } finally {
    client.release();
  }
};
