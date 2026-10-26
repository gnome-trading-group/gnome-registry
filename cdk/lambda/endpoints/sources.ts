import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, ValidationError } from './base';
import { ICreateSource, IModifySource } from '../types';

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;
const sqlTextArray = (values: string[]) => `ARRAY[${values.map(sqlText).join(',')}]::VARCHAR[]`;

function requirePositive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive whole number`);
  }
  return value;
}

/** A limit, or null for none. */
function optionalPositive(value: unknown, name: string): string {
  return value === null ? 'NULL' : String(requirePositive(value, name));
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

  generateInsertQuery(body: string): string {
    const source = JSON.parse(body) as ICreateSource;
    if (!source.code || !source.homeRegion || !source.adapter) {
      throw new ValidationError('A vendor source needs code, homeRegion and adapter');
    }
    return `
      INSERT INTO md.source (code, kind, home_region, adapter, families)
      VALUES (${sqlText(source.code)}, 'VENDOR', ${sqlText(source.homeRegion)}, ${sqlText(source.adapter)},
              ${sqlTextArray(requireFamilies(source.families))})
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM md.source WHERE 1=1';
    if (params?.sourceId) {
      query += ` AND source_id=${Number(params.sourceId)}`;
    }
    if (params?.code) {
      query += ` AND code=${sqlText(params.code)}`;
    }
    if (params?.kind) {
      query += ` AND kind=${sqlText(params.kind)}`;
    }
    if (params?.exchangeId) {
      query += ` AND exchange_id=${Number(params.exchangeId)}`;
    }
    if (params?.active !== undefined) {
      query += ` AND active=${params.active === 'true'}`;
    }
    return query;
  }

  // code, kind and exchange_id are fixed for a source's life: shards, secrets and stored data are named by them.
  generateModifyQuery(row: any, body: string): string {
    const source = JSON.parse(body) as IModifySource;
    const updates: string[] = [];
    if (source.homeRegion) {
      if (row.kind !== 'VENDOR') {
        throw new ValidationError("A venue's region is its exchange's; edit the exchange instead");
      }
      updates.push(`home_region=${sqlText(source.homeRegion)}`);
    }
    if (source.adapter) {
      updates.push(`adapter=${sqlText(source.adapter)}`);
    }
    if (source.families !== undefined) {
      updates.push(`families=${sqlTextArray(requireFamilies(source.families))}`);
    }
    if (source.active != null) {
      updates.push(`active=${source.active === true}`);
    }
    if (source.maxPerConnection !== undefined) {
      updates.push(`max_per_connection=${requirePositive(source.maxPerConnection, 'maxPerConnection')}`);
    }
    if (source.connectionScope !== undefined) {
      if (!['IP', 'KEY', 'ACCOUNT'].includes(source.connectionScope)) {
        throw new ValidationError('connectionScope must be IP, KEY or ACCOUNT');
      }
      updates.push(`connection_scope=${sqlText(source.connectionScope)}`);
    }
    if (source.connectionsPerScope !== undefined) {
      updates.push(`connections_per_scope=${optionalPositive(source.connectionsPerScope, 'connectionsPerScope')}`);
    }
    if (source.clientMessagesPerMinute !== undefined) {
      updates.push(
        `client_messages_per_minute=${optionalPositive(source.clientMessagesPerMinute, 'clientMessagesPerMinute')}`,
      );
    }
    updates.push('date_modified=NOW()');
    return `UPDATE md.source SET ${updates.join(', ')} WHERE source_id=${row.source_id} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new SourceHandler().handleEvent(event);
};
