import { APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { APIGatewayProxyEvent } from 'aws-lambda/trigger/api-gateway-proxy';
import { parseIdList, ResourceHandler, UNKNOWN_ACTOR, ValidationError, withTransaction } from './base';
import { isoTimestamp } from './fees';
import { validateIncentiveDefinition } from '../incentives/definition';
import { PRICE_SCALE, scaleDecimal } from '../sync/venues/types';

// Venue incentive programs (sm.incentive_program, migration 074). Writers post what the venue publishes now; the
// registry keeps a row only when a program is new or changed, and sets when it took effect, since only it knows what
// it held before. Reads give each listing's programs as versions over time, resolved like fee schedules: at time t
// a program has its version with the latest effective_from <= t, and applies when t is in its period.

const PROGRAMS = new Set(['LIQUIDITY']);
const REWARD_PER = new Set(['PERIOD', 'DAY']);
const SOURCES = new Set(['VENUE_API', 'MANUAL', 'BACKFILL']);
const MAX_ROWS_PER_POST = 1000;
const DEFAULT_PAGE = 2000;
const MAX_PAGE = 5000;

interface PostedProgram {
  exchangeCode: string;
  venueProgramId: string;
  program: string;
  venueMarket: string;
  periodStart: string;
  periodEnd?: string | null;
  reward: string | number;
  rewardPer: string;
  definition: unknown;
  paidOut?: boolean | null;
  source: string;
  sourceRef?: string | null;
  raw?: unknown;
}

interface ProgramRow {
  exchange_code: string;
  venue_program_id: string;
  program: string;
  venue_market: string;
  period_start: string;
  period_end: string | null;
  reward: string;
  reward_per: string;
  definition: Record<string, unknown>;
  paid_out: boolean | null;
  source: string;
  source_ref: string | null;
  raw: unknown;
}

function text(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`);
  return value.trim();
}

export function parseProgram(p: PostedProgram, i: number): ProgramRow {
  if (p == null || typeof p !== 'object') throw new ValidationError(`row ${i} must be an object`);
  const exchangeCode = text(`row ${i} exchangeCode`, p.exchangeCode);
  if (!PROGRAMS.has(p.program)) throw new ValidationError(`row ${i} program must be one of ${[...PROGRAMS].join(', ')}`);
  if (!REWARD_PER.has(p.rewardPer)) throw new ValidationError(`row ${i} rewardPer must be PERIOD or DAY`);
  if (!SOURCES.has(p.source)) throw new ValidationError(`row ${i} source must be one of ${[...SOURCES].join(', ')}`);
  if (p.paidOut != null && typeof p.paidOut !== 'boolean') throw new ValidationError(`row ${i} paidOut must be a boolean`);
  let reward: bigint;
  try {
    reward = scaleDecimal(p.reward, PRICE_SCALE);
  } catch {
    throw new ValidationError(`row ${i} reward must be a decimal number of dollars`);
  }
  if (reward < 0n) throw new ValidationError(`row ${i} reward must not be negative`);
  return {
    exchange_code: exchangeCode,
    venue_program_id: text(`row ${i} venueProgramId`, p.venueProgramId),
    program: p.program,
    venue_market: text(`row ${i} venueMarket`, p.venueMarket),
    period_start: isoTimestamp(`row ${i} periodStart`, p.periodStart),
    period_end: p.periodEnd == null ? null : isoTimestamp(`row ${i} periodEnd`, p.periodEnd),
    reward: reward.toString(),
    reward_per: p.rewardPer,
    definition: validateIncentiveDefinition(exchangeCode, p.definition),
    paid_out: p.paidOut ?? null,
    source: p.source,
    source_ref: p.sourceRef == null ? null : String(p.sourceRef),
    raw: p.raw ?? null,
  };
}

// The posted rows are compared with each program's latest version. A new program holds from the earlier of its start
// and now; changed terms hold from now; a change only to paid_out keeps the latest version's effective_from; an
// unchanged row is dropped.
const INSERT_CHANGED = `
  WITH posted AS (
    SELECT r.*, e.exchange_id FROM jsonb_to_recordset($1::jsonb) AS r(
      exchange_code text, venue_program_id text, program text, venue_market text, period_start timestamptz,
      period_end timestamptz, reward bigint, reward_per text, definition jsonb, paid_out boolean, source text,
      source_ref text, raw jsonb)
    JOIN sm.exchange e ON e.exchange_code = r.exchange_code
  ), compared AS (
    SELECT p.*, latest.effective_from AS latest_from,
      latest.effective_from IS NOT NULL
        AND (latest.venue_market, latest.period_start, latest.period_end, latest.reward, latest.reward_per,
             latest.definition)
          IS NOT DISTINCT FROM (p.venue_market, p.period_start, p.period_end, p.reward, p.reward_per, p.definition)
        AS same_terms,
      latest.paid_out IS NOT DISTINCT FROM p.paid_out AS same_paid
    FROM posted p
    LEFT JOIN LATERAL (
      SELECT * FROM sm.incentive_program ip
      WHERE ip.exchange_id = p.exchange_id AND ip.venue_program_id = p.venue_program_id
      ORDER BY ip.effective_from DESC, ip.recorded_at DESC LIMIT 1
    ) latest ON TRUE
  )
  INSERT INTO sm.incentive_program (exchange_id, venue_program_id, program, venue_market, period_start, period_end,
    reward, reward_per, definition, paid_out, effective_from, source, source_ref, raw, actor)
  SELECT exchange_id, venue_program_id, program, venue_market, period_start, period_end, reward, reward_per,
    definition, paid_out,
    CASE WHEN latest_from IS NULL THEN LEAST(period_start, NOW()) WHEN same_terms THEN latest_from ELSE NOW() END,
    source, source_ref, raw, $2
  FROM compared
  WHERE NOT (same_terms AND same_paid)
  RETURNING incentive_program_id`;

// Every program with a row whose period overlaps [from, to), with all of its versions: a program's version in force
// may not overlap (a cancellation moves its end before its start), but some version of any program in force does.
const LISTING_PROGRAMS = `
  WITH listings AS (
    SELECT listing_id, exchange_id, split_part(exchange_security_id, ':', 1) AS venue_market
    FROM sm.listing WHERE listing_id = ANY($1::int[])
  ), programs AS (
    SELECT DISTINCT l.listing_id, ip.exchange_id, ip.venue_program_id
    FROM listings l
    JOIN sm.incentive_program ip ON ip.exchange_id = l.exchange_id AND ip.venue_market = l.venue_market
    WHERE ($2::timestamptz IS NULL OR COALESCE(ip.period_end, 'infinity'::timestamptz) > $2)
      AND ($3::timestamptz IS NULL OR ip.period_start < $3)
      AND ($4::timestamptz IS NULL OR ip.recorded_at <= $4)
  )
  SELECT DISTINCT ON (p.listing_id, ip.venue_program_id, ip.effective_from)
    p.listing_id, ip.venue_program_id, ip.program, ip.venue_market, ip.period_start, ip.period_end, ip.reward::text,
    ip.reward_per, ip.definition, ip.paid_out, ip.effective_from
  FROM programs p
  JOIN sm.incentive_program ip ON ip.exchange_id = p.exchange_id AND ip.venue_program_id = p.venue_program_id
  WHERE ($4::timestamptz IS NULL OR ip.recorded_at <= $4)
    AND ($3::timestamptz IS NULL OR ip.effective_from < $3)
  ORDER BY p.listing_id, ip.venue_program_id, ip.effective_from, ip.recorded_at DESC`;

// Each program's latest version, where that version hasn't ended by $2; candidates come from the open-period index.
const OPEN_PROGRAMS = `
  WITH candidates AS (
    SELECT DISTINCT venue_program_id FROM sm.incentive_program
    WHERE exchange_id = $1 AND COALESCE(period_end, 'infinity'::timestamptz) > $2
      AND ($3::timestamptz IS NULL OR recorded_at <= $3) AND ($4::text IS NULL OR venue_program_id > $4)
  )
  SELECT * FROM (
    SELECT latest.* FROM candidates c
    CROSS JOIN LATERAL (
      SELECT ip.venue_program_id, ip.program, ip.venue_market, ip.period_start, ip.period_end, ip.reward::text,
        ip.reward_per, ip.definition, ip.paid_out, ip.effective_from
      FROM sm.incentive_program ip
      WHERE ip.exchange_id = $1 AND ip.venue_program_id = c.venue_program_id
        AND ($3::timestamptz IS NULL OR ip.recorded_at <= $3)
      ORDER BY ip.effective_from DESC, ip.recorded_at DESC LIMIT 1
    ) latest
  ) v
  WHERE COALESCE(v.period_end, 'infinity'::timestamptz) > $2
  ORDER BY v.venue_program_id
  LIMIT $5`;

export interface ProgramVersion {
  venueProgramId: string;
  program: string;
  venueMarket: string;
  periodStart: string;
  periodEnd: string | null;
  reward: string;
  rewardPer: string;
  definition: Record<string, unknown>;
  paidOut: boolean | null;
  effectiveFrom: string;
}

// Rewards travel as decimal dollars both ways, so a version read back can be posted again unchanged.
export function dollars(amount: bigint): string {
  const fraction = (amount % PRICE_SCALE).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${amount / PRICE_SCALE}.${fraction}` : `${amount / PRICE_SCALE}`;
}

function toVersion(r: Record<string, any>): ProgramVersion {
  return {
    venueProgramId: r.venue_program_id,
    program: r.program,
    venueMarket: r.venue_market,
    periodStart: new Date(r.period_start).toISOString(),
    periodEnd: r.period_end == null ? null : new Date(r.period_end).toISOString(),
    reward: dollars(BigInt(r.reward)),
    rewardPer: r.reward_per,
    definition: r.definition,
    paidOut: r.paid_out,
    effectiveFrom: new Date(r.effective_from).toISOString(),
  };
}

// A program's versions in time order, starting from the one in force at `from`: the earlier ones can't apply.
export function trimToWindow(versions: ProgramVersion[], from: Date | null): ProgramVersion[] {
  if (from === null) return versions;
  let first = 0;
  versions.forEach((v, i) => {
    if (Date.parse(v.effectiveFrom) <= from.getTime()) first = i;
  });
  return versions.slice(first);
}

export class IncentiveProgramHandler extends ResourceHandler {
  auditWrites(): boolean {
    return true;
  }

  async get(params: APIGatewayProxyEventQueryStringParameters | null) {
    const knownAsOf = params?.knownAsOf ? isoTimestamp('knownAsOf', params.knownAsOf) : null;
    const listingIds = parseIdList(params?.listingIds);
    if (listingIds.length > 0) {
      const from = params?.from ? isoTimestamp('from', params.from) : null;
      const to = params?.to ? isoTimestamp('to', params.to) : null;
      return this.createResponse(200, await this.listingPrograms(listingIds, from, to, knownAsOf));
    }
    if (params?.exchangeCode) {
      const endingAfter = params.endingAfter ? isoTimestamp('endingAfter', params.endingAfter) : new Date().toISOString();
      const limit = Math.min(Number(params.limit ?? DEFAULT_PAGE), MAX_PAGE);
      if (!Number.isInteger(limit) || limit <= 0) throw new ValidationError('limit must be a positive integer');
      const exchange = (await this.client.query(
        'SELECT exchange_id FROM sm.exchange WHERE exchange_code = $1', [params.exchangeCode])).rows[0];
      if (!exchange) throw new ValidationError(`unknown exchange ${params.exchangeCode}`);
      const rows = (await this.client.query(OPEN_PROGRAMS,
        [exchange.exchange_id, endingAfter, knownAsOf, params.after ?? null, limit])).rows;
      const programs = rows.map(toVersion);
      return this.createResponse(200, {
        programs,
        next: programs.length === limit ? programs[programs.length - 1].venueProgramId : null,
      });
    }
    throw new ValidationError('give listingIds, or exchangeCode');
  }

  private async listingPrograms(listingIds: number[], from: string | null, to: string | null, knownAsOf: string | null) {
    const rows = (await this.client.query(LISTING_PROGRAMS, [listingIds, from, to, knownAsOf])).rows;
    const byListing = new Map<number, Map<string, ProgramVersion[]>>(listingIds.map((id) => [id, new Map()]));
    for (const r of rows) {
      const programs = byListing.get(r.listing_id)!;
      const versions = programs.get(r.venue_program_id) ?? [];
      versions.push(toVersion(r));
      programs.set(r.venue_program_id, versions);
    }
    const fromDate = from === null ? null : new Date(from);
    return listingIds.map((listingId) => ({
      listingId,
      programs: [...byListing.get(listingId)!.values()].map((versions) => ({
        venueProgramId: versions[0].venueProgramId,
        versions: trimToWindow(versions, fromDate),
      })),
    }));
  }

  async createMany(body: string | null) {
    const items = JSON.parse(body ?? 'null');
    if (!Array.isArray(items) || items.length === 0) throw new ValidationError('expected a non-empty array');
    if (items.length > MAX_ROWS_PER_POST) throw new ValidationError(`at most ${MAX_ROWS_PER_POST} rows per post`);
    // A program read twice in one post (its status changed between the venue's pages) keeps its last reading.
    const rows = new Map<string, ProgramRow>();
    items.forEach((item, i) => {
      const row = parseProgram(item, i);
      rows.set(`${row.exchange_code}\u0000${row.venue_program_id}`, row);
    });
    const exchangeCodes = [...new Set([...rows.values()].map((r) => r.exchange_code))].sort();
    const known = (await this.client.query(
      'SELECT exchange_code FROM sm.exchange WHERE exchange_code = ANY($1::text[])', [exchangeCodes])).rows
      .map((r: { exchange_code: string }) => r.exchange_code);
    const unknown = exchangeCodes.filter((c) => !known.includes(c));
    if (unknown.length) throw new ValidationError(`unknown exchange ${unknown.join(', ')}`);
    const actor = this.audit && this.audit.actor !== UNKNOWN_ACTOR ? this.audit.actor : null;
    const inserted = await withTransaction(this.client, async () => {
      // Two writers comparing against the same latest version would both insert the change.
      for (const code of exchangeCodes) {
        await this.client.query("SELECT pg_advisory_xact_lock(hashtext('sm.incentive_program:' || $1))", [code]);
      }
      return (await this.client.query(INSERT_CHANGED, [JSON.stringify([...rows.values()]), actor])).rowCount ?? 0;
    }, this.audit ?? undefined);
    return this.createResponse(200, { inserted, unchanged: rows.size - inserted });
  }

  async createOne(body: string | null) {
    return this.createMany(`[${body ?? ''}]`);
  }

  generateDeleteQuery(_body: string): never {
    throw new ValidationError('incentive programs are append-only');
  }

  generateModifyQuery(_row: any, _body: string): never {
    throw new ValidationError('incentive programs are append-only');
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new IncentiveProgramHandler().handleEvent(event);
};
