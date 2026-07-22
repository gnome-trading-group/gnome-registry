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
    const limit = params?.limit ? parseInt(params.limit, 10) : 5000;
    const offset = params?.offset ? parseInt(params.offset, 10) : 0;

    let query = 'SELECT security_id, symbol FROM sm.security';
    if (params?.active !== undefined) {
      query += ` WHERE active = ${params.active === 'true'}`;
    }
    query += ' LIMIT $1 OFFSET $2';

    const result = await client.query(query, [limit, offset]);
    return createResponse(200, result.rows);
  } catch (error) {
    console.log(error);
    return createResponse(500, { message: error });
  } finally {
    client.release();
  }
};
