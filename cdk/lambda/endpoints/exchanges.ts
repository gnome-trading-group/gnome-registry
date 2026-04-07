import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateExchange, IDeleteExchange } from '../types';

class ExchangeHandler extends ResourceHandler {
  generateDeleteQuery(body: string): string {
    const exchange = JSON.parse(body) as IDeleteExchange;
    return `
      DELETE FROM sm.exchange
      WHERE exchange_id = ${exchange.exchangeId};
    `;
  }

  generateInsertQuery(body: string): string {
    const exchange = JSON.parse(body) as ICreateExchange;
    return (`
      INSERT INTO sm.exchange (exchange_name, region, schema_type)
      VALUES ('${exchange.exchangeName}', '${exchange.region}', '${exchange.schemaType}')
      RETURNING *;
    `);
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = "SELECT * FROM sm.exchange WHERE 1=1";
    if (params?.exchangeId) {
      query += ` AND exchange_id=${params.exchangeId}`;
    }
    if (params?.exchangeName) {
      query += ` AND exchange_name='${params.exchangeName}'`;
    }
    if (params?.region) {
      query += ` AND region='${params.region}'`;
    }
    if (params?.schemaType) {
      query += ` AND schema_type='${params.schemaType}'`;
    }
    return query;
  }

  generateModifyQuery(row: any, body: string): string {
    const exchange = JSON.parse(body) as ICreateExchange;
    let query = "UPDATE sm.exchange SET ";
    const updates: string[] = [];
    if (exchange.exchangeName) {
      updates.push(`exchange_name='${exchange.exchangeName}'`);
    }
    if (exchange.region) {
      updates.push(`region='${exchange.region}'`);
    }
    if (exchange.schemaType) {
      updates.push(`schema_type='${exchange.schemaType}'`);
    }
    updates.push(`date_modified=NOW()`);
    const updateString = updates.join(", ");
    query += `${updateString} WHERE exchange_id=${row['exchange_id']} RETURNING *`;
    return query;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ExchangeHandler().handleEvent(event);
}
