import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { NOW, set, Sql, sql, where } from './sql';
import { ICreateExchange, IDeleteExchange } from '../types';

export class ExchangeHandler extends ResourceHandler {
  generateDeleteQuery(body: string): Sql {
    const exchange = JSON.parse(body) as IDeleteExchange;
    return sql`DELETE FROM sm.exchange WHERE exchange_id = ${exchange.exchangeId}`;
  }

  generateInsertQuery(body: string): Sql {
    const exchange = JSON.parse(body) as ICreateExchange;
    return sql`
      INSERT INTO sm.exchange (exchange_code, exchange_name, region)
      VALUES (${exchange.exchangeCode}, ${exchange.exchangeName}, ${exchange.region})
      RETURNING *`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    return sql`SELECT * FROM sm.exchange${where([
      params?.exchangeId && sql`exchange_id = ${params.exchangeId}`,
      params?.exchangeCode && sql`exchange_code = ${params.exchangeCode}`,
      params?.exchangeName && sql`exchange_name = ${params.exchangeName}`,
      params?.region && sql`region = ${params.region}`,
    ])}`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const exchange = JSON.parse(body) as ICreateExchange;
    return sql`UPDATE sm.exchange SET ${set({
      exchange_code: exchange.exchangeCode || undefined,
      exchange_name: exchange.exchangeName || undefined,
      region: exchange.region || undefined,
      date_modified: NOW,
    })} WHERE exchange_id = ${row['exchange_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ExchangeHandler().handleEvent(event);
}
