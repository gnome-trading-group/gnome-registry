import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler, UNKNOWN_ACTOR, ValidationError } from './base';

// Fee schedules (sm.fee_schedule). Writes are append-only: a venue change is a row effective from when it happened,
// and a fix is a row with the effective_from of the row it corrects (the later recorded_at wins). Reads resolve a
// listing's fees over time from its most specific scope in force: listing, then fee event, then fee group, then
// exchange. Fee events and fee groups are the venue's own keys carried on sm.listing (a Kalshi event ticker, a series).

const COMPONENT_KINDS = new Set(['PRICE_CURVE', 'NOTIONAL', 'PER_UNIT']);
const SIDES = new Set(['BUY', 'SELL']);
const ROUNDING_MODES = new Set(['NONE', 'CEIL', 'HALF_UP', 'HALF_EVEN']);
const ROUNDING_SCOPES = new Set(['FILL', 'ORDER_ACCUMULATOR']);
const SOURCES = new Set(['VENUE_API', 'MANUAL', 'BACKFILL']);
const CURRENCY_PATTERN = /^[A-Z0-9]{2,10}$/;
const MAX_ID = 2147483647;

// A fill's fee is the sum of its components, each charged at the taker or maker rate by the fill's liquidity:
//   PRICE_CURVE  rate × qty × (p(1−p))^exponent   (binary contracts priced in [0, 1])
//   NOTIONAL     rate × qty × price
//   PER_UNIT     rate × qty
// A negative rate is a rebate. A component with a side applies only to fills on that side. Rounding then applies per
// fill, or (ORDER_ACCUMULATOR, Kalshi) to the balance change with the overpayment carried across the order's fills.
export interface IFeeComponent {
  kind: 'PRICE_CURVE' | 'NOTIONAL' | 'PER_UNIT';
  taker: number;
  maker: number;
  exponent?: number;
  side?: 'BUY' | 'SELL';
}

export interface IFeeRounding {
  mode: 'NONE' | 'CEIL' | 'HALF_UP' | 'HALF_EVEN';
  increment?: number;
  scope?: 'FILL' | 'ORDER_ACCUMULATOR';
}

export interface IFeeDefinition {
  currency: string;
  components: IFeeComponent[];
  rounding: IFeeRounding;
}

function finite(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(`${name} must be a number`);
  return value;
}

function exactKeys(name: string, value: object, allowed: string[]): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ValidationError(`${name} has unknown fields: ${extra.join(', ')}`);
}

// Consumers in Java and Python compute fills' fees from this, so a definition they couldn't read must never be stored.
export function validateDefinition(value: unknown): IFeeDefinition {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('definition must be an object, or null to clear the scope');
  }
  const d = value as IFeeDefinition;
  exactKeys('definition', d, ['currency', 'components', 'rounding']);
  if (typeof d.currency !== 'string' || !CURRENCY_PATTERN.test(d.currency)) {
    throw new ValidationError('definition.currency must be a currency code like USD');
  }
  if (!Array.isArray(d.components) || d.components.length === 0) {
    throw new ValidationError('definition.components must be a non-empty array');
  }
  d.components.forEach((c, i) => {
    const name = `definition.components[${i}]`;
    if (c == null || typeof c !== 'object') throw new ValidationError(`${name} must be an object`);
    exactKeys(name, c, ['kind', 'taker', 'maker', 'exponent', 'side']);
    if (!COMPONENT_KINDS.has(c.kind)) throw new ValidationError(`${name}.kind must be one of ${[...COMPONENT_KINDS].join(', ')}`);
    finite(`${name}.taker`, c.taker);
    finite(`${name}.maker`, c.maker);
    if (c.exponent !== undefined) {
      if (c.kind !== 'PRICE_CURVE') throw new ValidationError(`${name}.exponent applies only to PRICE_CURVE`);
      if (finite(`${name}.exponent`, c.exponent) <= 0) throw new ValidationError(`${name}.exponent must be positive`);
    }
    if (c.side !== undefined && !SIDES.has(c.side)) throw new ValidationError(`${name}.side must be BUY or SELL`);
  });
  const r = d.rounding;
  if (r == null || typeof r !== 'object') throw new ValidationError('definition.rounding must be an object');
  exactKeys('definition.rounding', r, ['mode', 'increment', 'scope']);
  if (!ROUNDING_MODES.has(r.mode)) throw new ValidationError(`definition.rounding.mode must be one of ${[...ROUNDING_MODES].join(', ')}`);
  if (r.mode === 'NONE') {
    if (r.increment !== undefined || r.scope !== undefined) {
      throw new ValidationError('definition.rounding takes no increment or scope when mode is NONE');
    }
  } else {
    if (finite('definition.rounding.increment', r.increment) <= 0) {
      throw new ValidationError('definition.rounding.increment must be positive');
    }
    if (r.scope === undefined || !ROUNDING_SCOPES.has(r.scope)) {
      throw new ValidationError(`definition.rounding.scope must be one of ${[...ROUNDING_SCOPES].join(', ')}`);
    }
    // The accumulator always rounds the balance change against the trader and rebates the excess later.
    if (r.scope === 'ORDER_ACCUMULATOR' && r.mode !== 'CEIL') {
      throw new ValidationError('definition.rounding.mode must be CEIL for ORDER_ACCUMULATOR');
    }
  }
  return d;
}

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

export type FeeScope = 'LISTING' | 'FEE_EVENT' | 'FEE_GROUP' | 'EXCHANGE';
// Most specific first: the first scope with a schedule in force decides a listing's fees.
const SCOPE_ORDER: FeeScope[] = ['LISTING', 'FEE_EVENT', 'FEE_GROUP', 'EXCHANGE'];

export interface IScheduleRow {
  fee_schedule_id: string;
  scope: FeeScope;
  effective_from: Date;
  recorded_at: Date;
  definition: IFeeDefinition | null;
}

export interface ITimelineEntry {
  effectiveFrom: string;
  effectiveTo: string | null;
  scope: FeeScope;
  feeScheduleId: string;
  definition: IFeeDefinition;
}

// One listing's fees over time from the schedules of its four scopes. Each entry holds from its effectiveFrom until
// the next entry's (effectiveTo, exclusive; null for the last). A time no entry covers has no known fees.
// from/to trim the result to the entries in force at some point in [from, to].
export function resolveTimeline(rows: IScheduleRow[], from?: Date, to?: Date): ITimelineEntry[] {
  // Within one scope, the latest recorded_at for each effective_from wins (a correction replaces the original).
  const perScope = new Map<FeeScope, IScheduleRow[]>();
  for (const scope of SCOPE_ORDER) {
    const byEffective = new Map<number, IScheduleRow>();
    for (const row of rows.filter((r) => r.scope === scope)) {
      const key = row.effective_from.getTime();
      const current = byEffective.get(key);
      if (!current || row.recorded_at.getTime() > current.recorded_at.getTime()
        || (row.recorded_at.getTime() === current.recorded_at.getTime()
          && BigInt(row.fee_schedule_id) > BigInt(current.fee_schedule_id))) {
        byEffective.set(key, row);
      }
    }
    perScope.set(scope, [...byEffective.values()].sort((a, b) => a.effective_from.getTime() - b.effective_from.getTime()));
  }

  const changes = [...new Set(rows.map((r) => r.effective_from.getTime()))].sort((a, b) => a - b);
  const segments: { start: number; row: IScheduleRow | null }[] = [];
  for (const at of changes) {
    let winner: IScheduleRow | null = null;
    for (const scope of SCOPE_ORDER) {
      const inForce = perScope.get(scope)!.filter((r) => r.effective_from.getTime() <= at).pop();
      if (inForce && inForce.definition !== null) {
        winner = inForce;
        break;
      }
    }
    const last = segments[segments.length - 1];
    if (last && last.row?.fee_schedule_id === winner?.fee_schedule_id) continue;
    segments.push({ start: at, row: winner });
  }

  const entries: ITimelineEntry[] = [];
  segments.forEach((segment, i) => {
    const end = i + 1 < segments.length ? segments[i + 1].start : null;
    if (!segment.row) return;
    if (from && end !== null && end <= from.getTime()) return;
    if (to && segment.start > to.getTime()) return;
    entries.push({
      effectiveFrom: new Date(segment.start).toISOString(),
      effectiveTo: end === null ? null : new Date(end).toISOString(),
      scope: segment.row.scope,
      feeScheduleId: String(segment.row.fee_schedule_id),
      definition: segment.row.definition!,
    });
  });
  return entries;
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

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

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
    const result = await this.client.query(
      `SELECT l.listing_id, f.fee_schedule_id, f.effective_from, f.recorded_at, f.definition,
              CASE WHEN f.listing_id IS NOT NULL THEN 'LISTING' WHEN f.fee_event IS NOT NULL THEN 'FEE_EVENT'
                   WHEN f.fee_group IS NOT NULL THEN 'FEE_GROUP' ELSE 'EXCHANGE' END AS scope
       FROM sm.listing l JOIN sm.fee_schedule f ON f.exchange_id = l.exchange_id AND (
         f.listing_id = l.listing_id OR f.fee_event = l.fee_event OR f.fee_group = l.fee_group
         OR (f.listing_id IS NULL AND f.fee_event IS NULL AND f.fee_group IS NULL))
       WHERE l.listing_id = ANY($1::int[])
         AND ($2::timestamptz IS NULL OR f.recorded_at <= $2::timestamptz)`,
      [listingIds, knownAsOf]);
    const byListing = new Map<number, IScheduleRow[]>(listingIds.map((id) => [id, []]));
    for (const row of result.rows) byListing.get(row.listing_id)!.push(row);
    return this.createResponse(200, listingIds.map((listingId) => ({
      listingId,
      timeline: resolveTimeline(byListing.get(listingId)!, from, to),
    })));
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let where = '1=1';
    if (params?.exchangeId) where += ` AND exchange_id=${optionalId('exchangeId', Number(params.exchangeId))}`;
    if (params?.feeGroup) where += ` AND fee_group=${quote(params.feeGroup)}`;
    if (params?.feeEvent) where += ` AND fee_event=${quote(params.feeEvent)}`;
    if (params?.scopeListingId) where += ` AND listing_id=${optionalId('scopeListingId', Number(params.scopeListingId))}`;
    return `SELECT * FROM sm.fee_schedule WHERE ${where} ORDER BY effective_from DESC, recorded_at DESC`;
  }

  // A row names the exchange, optionally narrowed to one fee group or fee event, or names a listing (which implies
  // its exchange).
  generateInsertQuery(body: string): string {
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
    const exchange = exchangeId !== null ? String(exchangeId) : `(SELECT exchange_id FROM sm.listing WHERE listing_id=${listingId})`;
    const text = (value: string | null) => (value === null ? 'NULL' : quote(value));
    const actor = this.audit && this.audit.actor !== UNKNOWN_ACTOR ? quote(this.audit.actor) : 'NULL';
    return `
      INSERT INTO sm.fee_schedule (exchange_id, fee_group, fee_event, listing_id, effective_from, definition, source,
        source_ref, actor)
      VALUES (${exchange}, ${text(feeGroup)}, ${text(feeEvent)}, ${listingId ?? 'NULL'}, '${effectiveFrom}',
        ${definition === null ? 'NULL' : `${quote(JSON.stringify(definition))}::jsonb`}, '${s.source}',
        ${s.sourceRef == null ? 'NULL' : quote(String(s.sourceRef))}, ${actor})
      RETURNING *;
    `;
  }

  generateDeleteQuery(_body: string): string {
    throw new ValidationError('fee schedules are append-only: record a correction with the same effectiveFrom');
  }

  generateModifyQuery(_row: any, _body: string): string {
    throw new ValidationError('fee schedules are append-only: record a correction with the same effectiveFrom');
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new FeeScheduleHandler().handleEvent(event);
};
