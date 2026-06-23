import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateExchangeEvent, IDeleteExchangeEvent } from '../types';

class ExchangeEventHandler extends ResourceHandler {
  generateDeleteQuery(body: string): string {
    const ee = JSON.parse(body) as IDeleteExchangeEvent;
    return `
      DELETE FROM sm.exchange_event
      WHERE exchange_event_id = ${ee.exchangeEventId}
      RETURNING *;
    `;
  }

  generateInsertQuery(body: string): string {
    const ee = JSON.parse(body) as ICreateExchangeEvent;
    return `
      INSERT INTO sm.exchange_event (exchange_id, event_id, native_event_id, raw_title)
      VALUES (${ee.exchangeId}, ${ee.eventId}, '${ee.nativeEventId.replace(/'/g, "''")}', '${ee.rawTitle.replace(/'/g, "''")}')
      ON CONFLICT (exchange_id, native_event_id) DO NOTHING
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM sm.exchange_event WHERE 1=1';
    if (params?.exchangeEventId) {
      query += ` AND exchange_event_id = ${params.exchangeEventId}`;
    }
    if (params?.exchangeId) {
      query += ` AND exchange_id = ${params.exchangeId}`;
    }
    if (params?.eventId) {
      query += ` AND event_id = ${params.eventId}`;
    }
    if (params?.nativeEventId) {
      query += ` AND native_event_id = '${params.nativeEventId.replace(/'/g, "''")}'`;
    }
    query += ' ORDER BY exchange_event_id';
    return query;
  }

  generateModifyQuery(row: any, body: string): string {
    const ee = JSON.parse(body) as Partial<ICreateExchangeEvent>;
    const updates: string[] = [];
    if (ee.eventId !== undefined) updates.push(`event_id = ${ee.eventId}`);
    if (ee.rawTitle !== undefined) updates.push(`raw_title = '${ee.rawTitle.replace(/'/g, "''")}'`);
    return `UPDATE sm.exchange_event SET ${updates.join(', ')} WHERE exchange_event_id = ${row['exchange_event_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ExchangeEventHandler().handleEvent(event);
};
