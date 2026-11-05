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

/** A start time: null when absent; anything unparseable is refused. */
function instant(name: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return timestamp(name, value);
}

/** Appends the start time of the events a statement wrote to their schedule history, when it changed. */
const LOG_SCHEDULE_CHANGE = raw('INSERT INTO sm.event_schedule_change (event_id, start_time, source)');

const tagArray = (tags: string[] | null | undefined) => (tags && tags.length > 0 ? tags : null);

/**
 * Events with a contract whose proposition is about any of these subject keys. Propositions hold the end of their
 * subject's merge chain, so a key merged elsewhere is followed to where its propositions now are. Driven from the
 * subjects rather than probed per event: an event list ordered by volume would otherwise be walked event by event
 * until enough matched, which for a rare subject is every open event.
 */
function aboutSubjects(keys: string[]): Sql {
  return sql`event_id IN (
    WITH RECURSIVE chain(subject_id) AS (
      SELECT subject_id FROM sm.proposition_subject WHERE key = ANY(${keys}::text[])
      UNION
      SELECT a.canonical_subject_id FROM chain JOIN sm.proposition_subject_alias a ON a.alias_subject_id = chain.subject_id
    )
    SELECT ec.event_id FROM chain
    JOIN sm.contract_proposition p ON p.subject_id = chain.subject_id
    JOIN sm.event_contract ec ON ec.security_id = p.security_id)`;
}

export class EventHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'event_id'; }
  getCamelPrimaryKey(): string { return 'eventId'; }

  allowedSortColumns(): string[] {
    return ['event_id', 'title', 'category', 'resolved', 'expiry', 'start_time', 'date_created', 'date_modified'];
  }

  generateDeleteQuery(body: string): Sql {
    const event = JSON.parse(body) as IDeleteEvent;
    return sql`DELETE FROM sm.event WHERE event_id = ${event.eventId} RETURNING *`;
  }

  generateInsertQuery(body: string): Sql {
    const event = JSON.parse(body) as ICreateEvent;
    // The classifier reads an event's volume in the same fetch that finds it, so a new event has it from the start.
    const volume24h = volume(event.volume24h);
    const startTime = instant('startTime', event.startTime);
    return sql`
      WITH inserted AS (
        INSERT INTO sm.event (title, description, category, expiry, tags, exchange_id, native_event_id, native_url,
                              volume_24h, volume_updated_at, start_time, start_time_updated_at)
        VALUES (${event.title}, ${event.description || null}, ${event.category || null}, ${event.expiry || null},
                ${tagArray(event.tags)}::text[], ${event.exchangeId}, ${event.nativeEventId}, ${event.nativeUrl || null},
                ${volume24h}, ${raw(volume24h === null ? 'NULL' : 'NOW()')},
                ${startTime}::timestamp, ${raw(startTime === null ? 'NULL' : 'NOW()')})
        RETURNING *
      ), logged AS (
        ${LOG_SCHEDULE_CHANGE} SELECT event_id, start_time, ${event.startTimeSource || null} FROM inserted
        WHERE start_time IS NOT NULL
      )
      SELECT * FROM inserted`;
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
      params?.subjects && aboutSubjects(textList(params.subjects)),
      params?.expiryFrom && sql`expiry >= ${timestamp('expiryFrom', params.expiryFrom)}`,
      params?.expiryTo && sql`expiry < ${timestamp('expiryTo', params.expiryTo)}`,
      params?.startFrom && sql`start_time >= ${timestamp('startFrom', params.startFrom)}`,
      params?.startTo && sql`start_time < ${timestamp('startTo', params.startTo)}`,
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
    // Volume and start time are the classifier's readings, not edits of the event, so they leave date_modified alone.
    const volumeRead = event.volume24h !== undefined;
    const startRead = event.startTime !== undefined;
    const startTime = startRead ? instant('startTime', event.startTime) : undefined;
    const update = sql`UPDATE sm.event SET ${set({
      ...edits,
      date_modified: edited || !(volumeRead || startRead) ? NOW : undefined,
      volume_24h: volumeRead ? volume(event.volume24h) : undefined,
      volume_updated_at: volumeRead ? NOW : undefined,
      start_time: startRead ? sql`${startTime}::timestamp` : undefined,
      start_time_updated_at: startRead
        ? sql`CASE WHEN start_time IS DISTINCT FROM ${startTime}::timestamp THEN NOW() ELSE start_time_updated_at END`
        : undefined,
    })} WHERE event_id = ${row['event_id']} RETURNING *`;
    if (!startRead) {
      return update;
    }
    // Every statement in the WITH sees the event as it was, so `previous` is the start time before this update.
    return sql`
      WITH previous AS (SELECT start_time FROM sm.event WHERE event_id = ${row['event_id']}),
      updated AS (${update}),
      logged AS (
        ${LOG_SCHEDULE_CHANGE} SELECT updated.event_id, updated.start_time, ${event.startTimeSource || null}
        FROM updated, previous WHERE updated.start_time IS DISTINCT FROM previous.start_time
      )
      SELECT * FROM updated`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new EventHandler().handleEvent(event);
};
