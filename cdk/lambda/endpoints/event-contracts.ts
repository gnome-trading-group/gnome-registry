import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateEventContract, IDeleteEventContract } from '../types';

class EventContractHandler extends ResourceHandler {
  generateDeleteQuery(body: string): string {
    const ec = JSON.parse(body) as IDeleteEventContract;
    return `
      DELETE FROM sm.event_contract
      WHERE event_contract_id = ${ec.eventContractId}
      RETURNING *;
    `;
  }

  generateInsertQuery(body: string): string {
    const ec = JSON.parse(body) as ICreateEventContract;
    return `
      INSERT INTO sm.event_contract (event_id, security_id, outcome_label)
      VALUES (${ec.eventId}, ${ec.securityId}, '${ec.outcomeLabel.replace(/'/g, "''")}')
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM sm.event_contract WHERE 1=1';
    if (params?.eventContractId) {
      query += ` AND event_contract_id = ${params.eventContractId}`;
    }
    if (params?.eventId) {
      query += ` AND event_id = ${params.eventId}`;
    }
    if (params?.securityId) {
      query += ` AND security_id = ${params.securityId}`;
    }
    query += ' ORDER BY event_contract_id';
    return query;
  }

  generateModifyQuery(row: any, body: string): string {
    const ec = JSON.parse(body) as Partial<ICreateEventContract>;
    const updates: string[] = [];
    if (ec.outcomeLabel !== undefined) updates.push(`outcome_label = '${ec.outcomeLabel.replace(/'/g, "''")}'`);
    return `UPDATE sm.event_contract SET ${updates.join(', ')} WHERE event_contract_id = ${row['event_contract_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new EventContractHandler().handleEvent(event);
};
