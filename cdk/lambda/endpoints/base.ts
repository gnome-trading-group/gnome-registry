import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from "aws-lambda/trigger/api-gateway-proxy";
import { connectDatabase } from "../connections";
import { Pool } from 'pg';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
}

export class ResourceHandler {
  pool: Pool;
  client: any; // This will be a PoolClient from pg

  private createResponse(statusCode: number, body: any) {
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
          return await this.createOne(event.body);
        case 'DELETE':
          return await this.deleteOne(event.body);
        case 'PATCH':
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

  async get(params: APIGatewayProxyEventQueryStringParameters | null) {
    const query = this.generateSelectQuery(params);
    const result = await this.client.query(query);
    return this.createResponse(200, result.rows);
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    throw new Error("Must override");
  }
}
