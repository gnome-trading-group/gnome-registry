import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { platformRegions, platformZoneIds } from '@gnome-trading-group/gnome-shared-cdk/dist/regions';
import { ResourceHandler, ValidationError } from './base';
import { NOW, set, Sql, sql, where } from './sql';
import { ICreateExchange, IDeleteExchange } from '../types';

/**
 * The home zone to store for an exchange in `region`: undefined leaves it, null clears it. Gateways, production shards
 * and sessions can only run where the platform network has a subnet, so any other zone is refused.
 */
export function homeZone(region: string, value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!platformRegions().includes(region)) {
    throw new ValidationError(`${region} has no platform network, so it can have no home zone`);
  }
  const zones = platformZoneIds(region);
  if (!zones.some(z => z.id === value)) {
    throw new ValidationError(
      `${value} is not a zone of ${region}'s platform network; expected one of ${zones.map(z => `${z.id} (${z.name})`).join(', ')}`);
  }
  return value;
}

export class ExchangeHandler extends ResourceHandler {
  generateDeleteQuery(body: string): Sql {
    const exchange = JSON.parse(body) as IDeleteExchange;
    return sql`DELETE FROM sm.exchange WHERE exchange_id = ${exchange.exchangeId}`;
  }

  generateInsertQuery(body: string): Sql {
    const exchange = JSON.parse(body) as ICreateExchange;
    const zone = homeZone(exchange.region, exchange.homeZoneId) ?? null;
    return sql`
      INSERT INTO sm.exchange (exchange_code, exchange_name, region, home_zone_id)
      VALUES (${exchange.exchangeCode}, ${exchange.exchangeName}, ${exchange.region}, ${zone})
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
    const region = exchange.region || row['region'];
    // A zone belongs to one region: moving the exchange drops its home zone unless a new one comes with the move.
    const moved = region !== row['region'];
    const zone = exchange.homeZoneId !== undefined ? homeZone(region, exchange.homeZoneId) : moved ? null : undefined;
    return sql`UPDATE sm.exchange SET ${set({
      exchange_code: exchange.exchangeCode || undefined,
      exchange_name: exchange.exchangeName || undefined,
      region: exchange.region || undefined,
      home_zone_id: zone,
      date_modified: NOW,
    })} WHERE exchange_id = ${row['exchange_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ExchangeHandler().handleEvent(event);
}
