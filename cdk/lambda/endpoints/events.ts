import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler, ValidationError } from './base';
import { ICreateEvent, IDeleteEvent } from '../types';
import { anyId, NOW, raw, set, Sql, sql, where } from './sql';

/** Comma-separated text values, e.g. "Sports,Politics"; empty items are dropped. */
const textList = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);

/** An ISO-8601 time from a query param; anything unparseable is refused. */
function timestamp(name: string, value: string): string {
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw new ValidationError(`${name} must be an ISO-8601 time, got ${value}`);
  }
  return new Date(millis).toISOString();
}

/** A 24h volume: null when absent; anything not a number is refused. */
function volume(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(Number(value))) {
    throw new ValidationError(`volume24h must be a number or null, got ${value}`);
  }
  return Number(value);
}

const tagArray = (tags: string[] | null | undefined) => (tags && tags.length > 0 ? tags : null);

export class EventHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'event_id'; }
  getCamelPrimaryKey(): string { return 'eventId'; }

  allowedSortColumns(): string[] {
    return ['event_id', 'title', 'category', 'resolved', 'expiry', 'date_created', 'date_modified'];
  }

  generateDeleteQuery(body: string): Sql {
    const event = JSON.parse(body) as IDeleteEvent;
    return sql`DELETE FROM sm.event WHERE event_id = ${event.eventId} RETURNING *`;
  }

  generateInsertQuery(body: string): Sql {
    const event = JSON.parse(body) as ICreateEvent;
    // The classifier reads an event's volume in the same fetch that finds it, so a new event has it from the start.
    const volume24h = volume(event.volume24h);
    return sql`
      INSERT INTO sm.event (title, description, category, expiry, tags, exchange_id, native_event_id, native_url,
                            volume_24h, volume_updated_at)
      VALUES (${event.title}, ${event.description || null}, ${event.category || null}, ${event.expiry || null},
              ${tagArray(event.tags)}::text[], ${event.exchangeId}, ${event.nativeEventId}, ${event.nativeUrl || null},
              ${volume24h}, ${raw(volume24h === null ? 'NULL' : 'NOW()')})
      RETURNING *`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    let minVolume: number | undefined;
    if (params?.minVolume24h) {
      minVolume = Number(params.minVolume24h);
      if (!Number.isFinite(minVolume)) {
        throw new ValidationError(`minVolume24h must be a number, got ${params.minVolume24h}`);
      }
    }
    const pattern = `%${params?.search}%`;
    const query = sql`SELECT * FROM sm.event${where([
      params?.eventId && sql`event_id = ${params.eventId}`,
      params?.category && sql`category = ${params.category}`,
      params?.exchangeId && sql`exchange_id = ${params.exchangeId}`,
      params?.nativeEventId && sql`native_event_id = ${params.nativeEventId}`,
      params?.resolved !== undefined && sql`resolved = ${params.resolved === 'true'}`,
      params?.tag && sql`${params.tag} = ANY(tags)`,
      params?.eventIds !== undefined && anyId('event_id', parseIdList(params.eventIds)),
      params?.exchangeIds !== undefined && anyId('exchange_id', parseIdList(params.exchangeIds)),
      params?.categories && sql`category = ANY(${textList(params.categories)}::text[])`,
      params?.tags && sql`tags && ${textList(params.tags)}::text[]`,
      params?.expiryFrom && sql`expiry >= ${timestamp('expiryFrom', params.expiryFrom)}`,
      params?.expiryTo && sql`expiry < ${timestamp('expiryTo', params.expiryTo)}`,
      minVolume !== undefined && sql`volume_24h >= ${minVolume}`,
      params?.search && sql`(title ILIKE ${pattern} OR description ILIKE ${pattern})`,
    ])}`;
    // By volume, events with none yet sort last either way, and ties keep a stable order for paging.
    if (params?.sortBy === 'volume_24h') {
      return sql`${query} ORDER BY volume_24h ${raw(params.sortOrder === 'desc' ? 'DESC' : 'ASC')} NULLS LAST, event_id`;
    }
    return query;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const event = JSON.parse(body) as Partial<ICreateEvent> & { resolved?: boolean; resolvedAt?: string | null };
    const orNull = <T>(value: T | undefined) => (value === undefined ? undefined : value || null);
    const edits: Record<string, unknown> = {
      title: event.title,
      description: orNull(event.description),
      category: orNull(event.category),
      expiry: orNull(event.expiry),
      tags: event.tags === undefined ? undefined : sql`${tagArray(event.tags)}::text[]`,
      native_url: orNull(event.nativeUrl),
      resolved: event.resolved,
      resolved_at: orNull(event.resolvedAt),
    };
    const edited = Object.values(edits).some((value) => value !== undefined);
    // A volume refresh is the classifier's reading, not an edit of the event, so it leaves date_modified alone.
    const refreshed = event.volume24h !== undefined;
    return sql`UPDATE sm.event SET ${set({
      ...edits,
      date_modified: edited || !refreshed ? NOW : undefined,
      volume_24h: refreshed ? volume(event.volume24h) : undefined,
      volume_updated_at: refreshed ? NOW : undefined,
    })} WHERE event_id = ${row['event_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new EventHandler().handleEvent(event);
};
