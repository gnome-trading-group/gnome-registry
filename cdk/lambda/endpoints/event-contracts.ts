import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, ValidationError } from './base';
import { raw, set, Sql, sql, where } from './sql';
import { ICreateEventContract, IDeleteEventContract, IModifyEventContract } from '../types';

// An outcome pays between nothing and the full $1 its contract is worth.
const MAX_SETTLEMENT_PRICE = 1_000_000_000n;

export class EventContractHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'event_contract_id'; }
  getCamelPrimaryKey(): string { return 'eventContractId'; }

  generateDeleteQuery(body: string): Sql {
    const ec = JSON.parse(body) as IDeleteEventContract;
    return sql`DELETE FROM sm.event_contract WHERE event_contract_id = ${ec.eventContractId} RETURNING *`;
  }

  generateInsertQuery(body: string): Sql {
    const ec = JSON.parse(body) as ICreateEventContract;
    return sql`
      INSERT INTO sm.event_contract (event_id, security_id, outcome_label)
      VALUES (${ec.eventId}, ${ec.securityId}, ${ec.outcomeLabel})
      RETURNING *`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    const denormalize = params?.denormalize === 'true';
    const column = (name: string) => raw(denormalize ? `ec.${name}` : name);
    const from = denormalize
      ? sql`SELECT ec.*, s.symbol AS security_symbol
         FROM sm.event_contract ec
         JOIN sm.security s ON ec.security_id = s.security_id`
      : sql`SELECT * FROM sm.event_contract`;
    return sql`${from}${where([
      params?.eventContractId && sql`${column('event_contract_id')} = ${params.eventContractId}`,
      params?.eventId && sql`${column('event_id')} = ${params.eventId}`,
      params?.securityId && sql`${column('security_id')} = ${params.securityId}`,
    ])} ORDER BY ${column('event_contract_id')}`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const ec = JSON.parse(body) as IModifyEventContract;
    const fields: Record<string, unknown> = { outcome_label: ec.outcomeLabel };
    if (ec.settlementPrice !== undefined) {
      if (!/^\d+$/.test(String(ec.settlementPrice)) || BigInt(String(ec.settlementPrice)) > MAX_SETTLEMENT_PRICE) {
        throw new ValidationError('settlementPrice must be an integer from 0 to 1000000000 (1e9 = $1)');
      }
      // The first value recorded wins, so a repeated write is a no-op rather than a failed bulk patch.
      fields.settlement_price = sql`COALESCE(settlement_price, ${String(ec.settlementPrice)}::bigint)`;
      fields.settled_at = raw('COALESCE(settled_at, NOW())');
    }
    if (ec.outcomeLabel === undefined && ec.settlementPrice === undefined) {
      throw new ValidationError('Nothing to modify: give outcomeLabel or settlementPrice');
    }
    return sql`UPDATE sm.event_contract SET ${set(fields)}
      WHERE event_contract_id = ${row['event_contract_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new EventContractHandler().handleEvent(event);
};
