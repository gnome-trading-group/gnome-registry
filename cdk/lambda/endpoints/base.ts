import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from "aws-lambda/trigger/api-gateway-proxy";
import { connectDatabase } from "../connections";
import { Pool, PoolClient } from 'pg';

const DEFAULT_PAGE_SIZE = 5000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
}

export const UNKNOWN_ACTOR = 'unknown';

export function getActor(event: APIGatewayProxyEvent): string {
  return event.requestContext?.authorizer?.claims?.email ?? UNKNOWN_ACTOR;
}

export interface IAudit {
  actor: string;
  reason?: string | null;
}

// Runs fn inside BEGIN/COMMIT on one client. When audit is given, the gnome.actor/gnome.reason settings are
// scoped to this transaction (is_local=true) so the risk.policy history trigger attributes every change made
// inside it, and a pooled connection never leaks them into the next request.
export async function withTransaction<T>(client: PoolClient, fn: (client: PoolClient) => Promise<T>, audit?: IAudit): Promise<T> {
  await client.query('BEGIN');
  try {
    if (audit) {
      await client.query(
        "SELECT set_config('gnome.actor', $1, true), set_config('gnome.reason', $2, true)",
        [audit.actor, audit.reason ?? ''],
      );
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// Bulk (array) bodies carry no single reason, so only an object body's reason is recorded.
function parseReason(body: string | null): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    return !Array.isArray(parsed) && typeof parsed?.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}

export class ResourceHandler {
  pool: Pool;
  client: any; // This will be a PoolClient from pg
  audit: IAudit | null = null;

  // Resources whose table has a history trigger opt in so their writes carry who made them and why.
  auditWrites(): boolean {
    return false;
  }

  private async runWrite<T>(fn: () => Promise<T>): Promise<T> {
    return this.audit ? withTransaction(this.client, fn, this.audit) : fn();
  }

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
      if (event.httpMethod !== 'GET' && this.auditWrites()) {
        this.audit = { actor: getActor(event), reason: parseReason(event.body) };
      }

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
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      console.error('Handler error:', message, stack);
      return this.createResponse(500, { message, stack });
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
    await withTransaction(this.client, async () => {
      for (const item of items) {
        const row = { [this.getPrimaryKey()]: item[this.getCamelPrimaryKey()] };
        const query = this.generateModifyQuery(row, JSON.stringify(item));
        const result = await this.client.query(query);
        if (result.rowCount !== 1) {
          throw new Error(`Modify failed for item: ${JSON.stringify(item)}`);
        }
        results.push(result.rows[0]);
      }
    }, this.audit ?? undefined);
    return this.createResponse(200, results);
  }

  async modifyOne(params: APIGatewayProxyEventQueryStringParameters | null, body: string | null) {
    if (!body) {
      return this.createResponse(400, { message: 'Missing body' });
    }

    return this.runWrite(async () => {
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
    });
  }

  generateInsertQuery(body: string): string {
    throw new Error("Must override");
  }

  async createOne(body: string | null) {
    if (!body) {
      return this.createResponse(400, { message: 'Missing body' });
    }

    return this.runWrite(async () => {
      const query = this.generateInsertQuery(body);
      const result = await this.client.query(query);

      if (result.rowCount != 1) {
        return this.createResponse(500, { message: `Insert returned ${result.rowCount} rows`, body, query });
      }

      const item = result.rows[0];
      return this.createResponse(200, item);
    });
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
    await withTransaction(this.client, async () => {
      for (const item of items) {
        const query = this.generateInsertQuery(JSON.stringify(item));
        const result = await this.client.query(query);
        if (result.rowCount !== 1) {
          throw new Error(`Insert returned ${result.rowCount} rows for item: ${JSON.stringify(item)}. Query: ${query}`);
        }
        results.push(result.rows[0]);
      }
    }, this.audit ?? undefined);
    return this.createResponse(200, results);
  }

  generateDeleteQuery(body: string): string {
    throw new Error("Must override");
  }

  async deleteOne(body: string | null) {
    if (!body) {
      return this.createResponse(400, { message: 'Missing body' });
    }

    return this.runWrite(async () => {
      const query = this.generateDeleteQuery(body);
      const result = await this.client.query(query);

      if (result.rowCount != 1) {
        return this.createResponse(404, { message: `Unable to delete resource from body: ${body}` });
      }

      const item = result.rows[0];
      return this.createResponse(200, item);
    });
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
