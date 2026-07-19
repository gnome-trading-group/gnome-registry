import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from "aws-lambda/trigger/api-gateway-proxy";
import { connectDatabase } from "../connections";
import { Pool } from 'pg';

const DEFAULT_PAGE_SIZE = 5000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
}

export class ResourceHandler {
  pool: Pool;
  client: any; // This will be a PoolClient from pg

  protected createResponse(statusCode: number, body: any) {
    return {
      statusCode,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: CORS_HEADERS
    };
  }

  async handleEvent(event: APIGatewayProxyEvent) {
    this.pool = await connectDatabase();
    let client;
    try {
      client = await this.pool.connect();
      this.client = client;

      switch (event.httpMethod) {
        case 'GET':
          return await this.get(event.queryStringParameters);
        case 'POST':
          if (event.body && event.body.trimStart().startsWith('[')) {
            return await this.createMany(event.body);
          }
          return await this.createOne(event.body);
        case 'DELETE':
          return await this.deleteOne(event.body);
        case 'PATCH':
          if (event.body && event.body.trimStart().startsWith('[')) {
            return await this.modifyMany(event.body);
          }
          return await this.modifyOne(event.queryStringParameters, event.body);
        default:
          return this.createResponse(400, { message: 'Invalid HTTP method' });
      }
    } catch (error) {
      console.log(error);
      return this.createResponse(500, { message: error });
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  generateModifyQuery(row: any, body: string): string {
    throw new Error("Must override");
  }

  getPrimaryKey(): string {
    throw new Error("Must override for bulk operations");
  }

  getCamelPrimaryKey(): string {
    throw new Error("Must override for bulk operations");
  }

  async modifyMany(body: string | null) {
    if (!body) {
      return this.createResponse(400, { message: 'Missing body' });
    }
    const items = JSON.parse(body);
    if (!Array.isArray(items) || items.length === 0) {
      return this.createResponse(400, { message: 'Expected non-empty array' });
    }
    const results: any[] = [];
    try {
      await this.client.query('BEGIN');
      for (const item of items) {
        const row = { [this.getPrimaryKey()]: item[this.getCamelPrimaryKey()] };
        const query = this.generateModifyQuery(row, JSON.stringify(item));
        const result = await this.client.query(query);
        if (result.rowCount !== 1) {
          throw new Error(`Modify failed for item: ${JSON.stringify(item)}`);
        }
        results.push(result.rows[0]);
      }
      await this.client.query('COMMIT');
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
    return this.createResponse(200, results);
  }

  async modifyOne(params: APIGatewayProxyEventQueryStringParameters | null, body: string | null) {
    if (!body) {
      return this.createResponse(400, { message: 'Missing body' });
    }

    var query = this.generateSelectQuery(params);

    var result = await this.client.query(query);
    if (result.rowCount != 1) {
      return this.createResponse(404, { message: 'Query params did not return one row only' });
    }

    var item = result.rows[0];
    query = this.generateModifyQuery(item, body);

    result = await this.client.query(query);

    if (result.rowCount != 1) {
      return this.createResponse(404, { message: `Unable to modify resource from body: ${body}` });
    }

    item = result.rows[0];
    return this.createResponse(200, item);
  }

  generateInsertQuery(body: string): string {
    throw new Error("Must override");
  }

  async createOne(body: string | null) {
    if (!body) {
      return this.createResponse(400, { message: 'Missing body' });
    }

    const query = this.generateInsertQuery(body);
    const result = await this.client.query(query);

    if (result.rowCount != 1) {
      return this.createResponse(404, { message: `Unable to new resource from body: ${body}` });
    }

    const item = result.rows[0];
    return this.createResponse(200, item);
  }

  async createMany(body: string | null) {
    if (!body) {
      return this.createResponse(400, { message: 'Missing body' });
    }
    const items = JSON.parse(body);
    if (!Array.isArray(items) || items.length === 0) {
      return this.createResponse(400, { message: 'Expected non-empty array' });
    }
    const results: any[] = [];
    try {
      await this.client.query('BEGIN');
      for (const item of items) {
        const query = this.generateInsertQuery(JSON.stringify(item));
        const result = await this.client.query(query);
        if (result.rowCount !== 1) {
          throw new Error(`Insert failed for item: ${JSON.stringify(item)}`);
        }
        results.push(result.rows[0]);
      }
      await this.client.query('COMMIT');
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
    return this.createResponse(200, results);
  }

  generateDeleteQuery(body: string): string {
    throw new Error("Must override");
  }

  async deleteOne(body: string | null) {
    if (!body) {
      return this.createResponse(400, { message: 'Missing body' });
    }

    const query = this.generateDeleteQuery(body);
    const result = await this.client.query(query);

    if (result.rowCount != 1) {
      return this.createResponse(404, { message: `Unable to delete resource from body: ${body}` });
    }

    const item = result.rows[0];
    return this.createResponse(200, item);
  }

  allowedSortColumns(): string[] {
    return [];
  }

  async get(params: APIGatewayProxyEventQueryStringParameters | null) {
    if (params?.count === 'true') {
      const selectQuery = this.generateSelectQuery(params);
      const countQuery = `SELECT COUNT(*) FROM (${selectQuery}) t`;
      const result = await this.client.query(countQuery);
      return this.createResponse(200, { count: parseInt(result.rows[0].count, 10) });
    }

    const limit = params?.limit ? parseInt(params.limit, 10) : DEFAULT_PAGE_SIZE;
    const offset = params?.offset ? parseInt(params.offset, 10) : 0;

    let query = this.generateSelectQuery(params);

    if (!query.toUpperCase().includes('ORDER BY')) {
      const allowed = this.allowedSortColumns();
      const sortBy = params?.sortBy && allowed.includes(params.sortBy) ? params.sortBy : null;
      const sortOrder = params?.sortOrder === 'desc' ? 'DESC' : 'ASC';
      query += sortBy ? ` ORDER BY ${sortBy} ${sortOrder}` : ' ORDER BY 1';
    }
    query += ` LIMIT ${limit} OFFSET ${offset}`;

    const result = await this.client.query(query);
    return this.createResponse(200, result.rows);
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    throw new Error("Must override");
  }
}
