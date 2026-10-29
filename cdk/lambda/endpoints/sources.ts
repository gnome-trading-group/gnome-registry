import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, ValidationError } from './base';
import { ICreateSource, IModifySource } from '../types';
import { NOW, set, Sql, sql, where } from './sql';

function requirePositive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive whole number`);
  }
  return value;
}

/** A limit, or null for none. */
function optionalPositive(value: unknown, name: string): number | null {
  return value === null ? null : requirePositive(value, name);
}

function requireFamilies(families: unknown): string[] {
  if (!Array.isArray(families) || families.length === 0 || !families.every((f) => typeof f === 'string' && f)) {
    throw new ValidationError('families must be a non-empty list of family names');
  }
  return families;
}

export class SourceHandler extends ResourceHandler {
  allowedSortColumns(): string[] {
    return ['source_id', 'code', 'kind', 'date_created'];
  }

  generateInsertQuery(body: string): Sql {
    const source = JSON.parse(body) as ICreateSource;
    if (!source.code || !source.homeRegion || !source.adapter) {
      throw new ValidationError('A vendor source needs code, homeRegion and adapter');
    }
    return sql`
      INSERT INTO md.source (code, kind, home_region, adapter, families)
      VALUES (${source.code}, 'VENDOR', ${source.homeRegion}, ${source.adapter}, ${requireFamilies(source.families)})
      RETURNING *`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    return sql`SELECT * FROM md.source${where([
      params?.sourceId && sql`source_id = ${Number(params.sourceId)}`,
      params?.code && sql`code = ${params.code}`,
      params?.kind && sql`kind = ${params.kind}`,
      params?.exchangeId && sql`exchange_id = ${Number(params.exchangeId)}`,
      params?.active !== undefined && sql`active = ${params.active === 'true'}`,
    ])}`;
  }

  // code, kind and exchange_id are fixed for a source's life: shards, secrets and stored data are named by them.
  generateModifyQuery(row: any, body: string): Sql {
    const source = JSON.parse(body) as IModifySource;
    if (source.homeRegion && row.kind !== 'VENDOR') {
      throw new ValidationError("A venue's region is its exchange's; edit the exchange instead");
    }
    if (source.connectionScope !== undefined && !['IP', 'KEY', 'ACCOUNT'].includes(source.connectionScope)) {
      throw new ValidationError('connectionScope must be IP, KEY or ACCOUNT');
    }
    const defined = <T>(value: T | undefined, check: (value: T) => unknown) => (value === undefined ? undefined : check(value));
    return sql`UPDATE md.source SET ${set({
      home_region: source.homeRegion || undefined,
      adapter: source.adapter || undefined,
      families: defined(source.families, requireFamilies),
      active: source.active != null ? source.active === true : undefined,
      max_per_connection: defined(source.maxPerConnection, (v) => requirePositive(v, 'maxPerConnection')),
      connection_scope: source.connectionScope,
      connections_per_scope: defined(source.connectionsPerScope, (v) => optionalPositive(v, 'connectionsPerScope')),
      client_messages_per_minute: defined(source.clientMessagesPerMinute,
        (v) => optionalPositive(v, 'clientMessagesPerMinute')),
      date_modified: NOW,
    })} WHERE source_id = ${row.source_id} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new SourceHandler().handleEvent(event);
};
