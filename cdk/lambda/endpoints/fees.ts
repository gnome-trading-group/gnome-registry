import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler, UNKNOWN_ACTOR, ValidationError } from './base';
import { validateDefinition } from '../fees/definition';
import { loadTimelines } from '../fees/timeline';
import { Sql, sql, where } from './sql';

// Fee schedules (sm.fee_schedule). Writes are append-only: a venue change is a row effective from when it happened,
// and a fix is a row with the effective_from of the row it corrects (the later recorded_at wins). Reads resolve a
// listing's fees over time from its most specific scope in force: listing, then fee event, then fee group, then
// exchange. Fee events and fee groups are the venue's own keys carried on sm.listing (a Kalshi event ticker, a series).

const SOURCES = new Set(['VENUE_API', 'MANUAL', 'BACKFILL']);
const MAX_ID = 2147483647;

export function isoTimestamp(name: string, value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${name} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function optionalId(name: string, value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_ID) {
    throw new ValidationError(`${name} must be a positive integer`);
  }
  return value;
}

interface ICreateFeeSchedule {
  exchangeId?: number;
  feeGroup?: string;
  feeEvent?: string;
  listingId?: number;
  effectiveFrom: string;
  definition: unknown;
  source: string;
  sourceRef?: string;
}

function optionalKey(name: string, value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`);
  return value.trim();
}

export class FeeScheduleHandler extends ResourceHandler {
  auditWrites(): boolean {
    return true;
  }

  // With listingIds, each listing's resolved timeline; otherwise the stored rows, newest first, for browsing history.
  async get(params: APIGatewayProxyEventQueryStringParameters | null) {
    const listingIds = parseIdList(params?.listingIds ?? params?.listingId);
    if (listingIds.length === 0) return super.get(params);
    const from = params?.from ? new Date(isoTimestamp('from', params.from)) : undefined;
    const to = params?.to ? new Date(isoTimestamp('to', params.to)) : undefined;
    const knownAsOf = params?.knownAsOf ? isoTimestamp('knownAsOf', params.knownAsOf) : null;
    const timelines = await loadTimelines(this.client, listingIds, from, to, knownAsOf);
    return this.createResponse(200, listingIds.map((listingId) => ({ listingId, timeline: timelines.get(listingId) })));
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    return sql`SELECT * FROM sm.fee_schedule${where([
      params?.exchangeId && sql`exchange_id = ${optionalId('exchangeId', Number(params.exchangeId))}`,
      params?.feeGroup && sql`fee_group = ${params.feeGroup}`,
      params?.feeEvent && sql`fee_event = ${params.feeEvent}`,
      params?.scopeListingId && sql`listing_id = ${optionalId('scopeListingId', Number(params.scopeListingId))}`,
    ])} ORDER BY effective_from DESC, recorded_at DESC`;
  }

  // A row names the exchange, optionally narrowed to one fee group or fee event, or names a listing (which implies
  // its exchange).
  generateInsertQuery(body: string): Sql {
    const s = JSON.parse(body) as ICreateFeeSchedule;
    const exchangeId = optionalId('exchangeId', s.exchangeId);
    const listingId = optionalId('listingId', s.listingId);
    const feeGroup = optionalKey('feeGroup', s.feeGroup);
    const feeEvent = optionalKey('feeEvent', s.feeEvent);
    if ((exchangeId === null) === (listingId === null)) {
      throw new ValidationError('a schedule names exactly one of exchangeId or listingId');
    }
    if ((feeGroup !== null || feeEvent !== null) && exchangeId === null) {
      throw new ValidationError('feeGroup and feeEvent need exchangeId');
    }
    if (feeGroup !== null && feeEvent !== null) throw new ValidationError('a schedule names feeGroup or feeEvent, not both');
    const effectiveFrom = isoTimestamp('effectiveFrom', s.effectiveFrom);
    const definition = s.definition === null ? null : validateDefinition(s.definition);
    if (!SOURCES.has(s.source)) throw new ValidationError(`source must be one of ${[...SOURCES].join(', ')}`);
    const exchange = exchangeId !== null ? exchangeId : sql`(SELECT exchange_id FROM sm.listing WHERE listing_id = ${listingId})`;
    const actor = this.audit && this.audit.actor !== UNKNOWN_ACTOR ? this.audit.actor : null;
    return sql`
      INSERT INTO sm.fee_schedule (exchange_id, fee_group, fee_event, listing_id, effective_from, definition, source,
        source_ref, actor)
      VALUES (${exchange}, ${feeGroup}, ${feeEvent}, ${listingId}, ${effectiveFrom},
        ${definition === null ? null : JSON.stringify(definition)}::jsonb, ${s.source},
        ${s.sourceRef == null ? null : String(s.sourceRef)}, ${actor})
      RETURNING *`;
  }

  generateDeleteQuery(_body: string): Sql {
    throw new ValidationError('fee schedules are append-only: record a correction with the same effectiveFrom');
  }

  generateModifyQuery(_row: any, _body: string): Sql {
    throw new ValidationError('fee schedules are append-only: record a correction with the same effectiveFrom');
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new FeeScheduleHandler().handleEvent(event);
};
