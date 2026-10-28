import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler, ValidationError } from './base';
import { ICreateEvent, IDeleteEvent } from '../types';

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Comma-separated text values, e.g. "Sports,Politics", as a SQL list; empty items are dropped. */
const sqlTextList = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean).map(sqlText).join(',');

/** An ISO-8601 time from a query param, as a SQL timestamp literal; anything unparseable is refused. */
function sqlTimestamp(name: string, value: string): string {
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw new ValidationError(`${name} must be an ISO-8601 time, got ${value}`);
  }
  return `'${new Date(millis).toISOString()}'`;
}

export class EventHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'event_id'; }
  getCamelPrimaryKey(): string { return 'eventId'; }

  allowedSortColumns(): string[] {
    return ['event_id', 'title', 'category', 'resolved', 'expiry', 'date_created', 'date_modified'];
  }

  generateDeleteQuery(body: string): string {
    const event = JSON.parse(body) as IDeleteEvent;
    return `
      DELETE FROM sm.event
      WHERE event_id = ${event.eventId}
      RETURNING *;
    `;
  }

  generateInsertQuery(body: string): string {
    const event = JSON.parse(body) as ICreateEvent;
    const description = event.description ? `'${event.description.replace(/'/g, "''")}'` : 'NULL';
    const category = event.category ? `'${event.category.replace(/'/g, "''")}'` : 'NULL';
    const expiry = event.expiry ? `'${event.expiry}'` : 'NULL';
    const tags = event.tags && event.tags.length > 0
      ? `ARRAY[${event.tags.map(t => `'${t.replace(/'/g, "''")}'`).join(',')}]::text[]`
      : 'NULL';
    const nativeUrl = event.nativeUrl ? `'${event.nativeUrl.replace(/'/g, "''")}'` : 'NULL';
    return `
      INSERT INTO sm.event (title, description, category, expiry, tags, exchange_id, native_event_id, native_url)
      VALUES ('${event.title.replace(/'/g, "''")}', ${description}, ${category}, ${expiry}, ${tags},
              ${event.exchangeId}, '${event.nativeEventId.replace(/'/g, "''")}', ${nativeUrl})
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = `SELECT * FROM sm.event WHERE 1=1`;
    if (params?.eventId) {
      query += ` AND event_id = ${params.eventId}`;
    }
    if (params?.category) {
      query += ` AND category = '${params.category}'`;
    }
    if (params?.exchangeId) {
      query += ` AND exchange_id = ${params.exchangeId}`;
    }
    if (params?.nativeEventId) {
      query += ` AND native_event_id = '${params.nativeEventId.replace(/'/g, "''")}'`;
    }
    if (params?.resolved !== undefined) {
      query += ` AND resolved = ${params.resolved === 'true'}`;
    }
    if (params?.tag) {
      query += ` AND '${params.tag.replace(/'/g, "''")}' = ANY(tags)`;
    }
    if (params?.exchangeIds !== undefined) {
      const ids = parseIdList(params.exchangeIds);
      query += ids.length > 0 ? ` AND exchange_id IN (${ids.join(',')})` : ' AND FALSE';
    }
    if (params?.categories) {
      query += ` AND category IN (${sqlTextList(params.categories)})`;
    }
    if (params?.tags) {
      query += ` AND tags && ARRAY[${sqlTextList(params.tags)}]::text[]`;
    }
    if (params?.expiryFrom) {
      query += ` AND expiry >= ${sqlTimestamp('expiryFrom', params.expiryFrom)}`;
    }
    if (params?.expiryTo) {
      query += ` AND expiry < ${sqlTimestamp('expiryTo', params.expiryTo)}`;
    }
    if (params?.minVolume24h) {
      const minVolume = Number(params.minVolume24h);
      if (!Number.isFinite(minVolume)) {
        throw new ValidationError(`minVolume24h must be a number, got ${params.minVolume24h}`);
      }
      query += ` AND volume_24h >= ${minVolume}`;
    }
    if (params?.search) {
      const escaped = params.search.replace(/'/g, "''");
      query += ` AND (title ILIKE '%${escaped}%' OR description ILIKE '%${escaped}%')`;
    }
    // By volume, events with none yet sort last either way, and ties keep a stable order for paging.
    if (params?.sortBy === 'volume_24h') {
      query += ` ORDER BY volume_24h ${params.sortOrder === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, event_id`;
    }
    return query;
  }

  generateModifyQuery(row: any, body: string): string {
    const event = JSON.parse(body) as Partial<ICreateEvent>;
    const updates: string[] = [];
    if (event.title !== undefined) updates.push(`title = '${event.title.replace(/'/g, "''")}'`);
    if (event.description !== undefined) updates.push(`description = ${event.description ? `'${event.description.replace(/'/g, "''")}'` : 'NULL'}`);
    if (event.category !== undefined) updates.push(`category = ${event.category ? `'${event.category}'` : 'NULL'}`);
    if (event.expiry !== undefined) updates.push(`expiry = ${event.expiry ? `'${event.expiry}'` : 'NULL'}`);
    if (event.tags !== undefined) updates.push(`tags = ${event.tags && event.tags.length > 0 ? `ARRAY[${event.tags.map(t => `'${t.replace(/'/g, "''")}'`).join(',')}]::text[]` : 'NULL'}`);
    if (event.nativeUrl !== undefined) updates.push(`native_url = ${event.nativeUrl ? `'${event.nativeUrl.replace(/'/g, "''")}'` : 'NULL'}`);
    if ((event as any).resolved !== undefined) updates.push(`resolved = ${(event as any).resolved}`);
    if ((event as any).resolvedAt !== undefined) updates.push(`resolved_at = ${(event as any).resolvedAt ? `'${(event as any).resolvedAt}'` : 'NULL'}`);
    // A volume refresh is the classifier's reading, not an edit of the event, so it leaves date_modified alone.
    if (updates.length > 0) updates.push('date_modified = NOW()');
    if (event.volume24h !== undefined) {
      if (event.volume24h !== null && !Number.isFinite(Number(event.volume24h))) {
        throw new ValidationError(`volume24h must be a number or null, got ${event.volume24h}`);
      }
      updates.push(`volume_24h = ${event.volume24h === null ? 'NULL' : Number(event.volume24h)}`, 'volume_updated_at = NOW()');
    }
    if (updates.length === 0) updates.push('date_modified = NOW()');
    return `UPDATE sm.event SET ${updates.join(', ')} WHERE event_id = ${row['event_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new EventHandler().handleEvent(event);
};
