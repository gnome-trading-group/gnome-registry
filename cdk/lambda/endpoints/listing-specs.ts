import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler, ValidationError } from './base';
import { isoTimestamp } from './fees';
import { checkGridEnd, validatePriceBands } from './price-bands';
import { anyId, NOW, Sql, sql, where } from './sql';
import { AssetClass } from '../sync/venues/exchange-types';

interface IListingSpec {
  listingId: number;
  priceBands: unknown;
  lotSize: number;
  minNotional?: number;
  contractMultiplier?: number;
  minSize?: number;
  effectiveFrom?: string;
  correction?: boolean;
}

// Specs are append-only with an effective_from (when the spec held at the venue) and a recorded_at (when it was written).
// A spec at time t is the row with the latest effective_from <= t, and among those the latest recorded_at, so a
// correction (same effective_from as the row it fixes) replaces that row for all time.
export class ListingSpecHandler extends ResourceHandler {
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    // Applied before picking each listing's spec in force, it would answer "the latest row recorded since", not "the
    // spec in force of listings that changed since"; rows are what a refreshing session wants.
    if (params?.recordedAfter && params.history !== 'true') {
      throw new ValidationError('recordedAfter needs history=true');
    }
    const filters = [
      params?.listingId && sql`listing_id = ${params.listingId}`,
      params?.listingIds !== undefined && anyId('listing_id', parseIdList(params.listingIds)),
      params?.exchangeId && sql`listing_id IN (SELECT listing_id FROM sm.listing WHERE exchange_id = ${params.exchangeId})`,
      // Specs of the listings that trade now: what the spec sync checks against the venue every pass.
      params?.activeListings === 'true' && sql`listing_id IN (SELECT listing_id FROM sm.listing WHERE active)`,
      // Pages by listing: an offset deep into an exchange's specs sorts every row before it.
      params?.afterListingId && sql`listing_id > ${params.afterListingId}`,
      // What changed since a reader last looked: its sessions refresh the specs they cached.
      params?.recordedAfter && sql`recorded_at > ${isoTimestamp('recordedAfter', params.recordedAfter)}::timestamptz`,
    ];
    if (params?.history === 'true') {
      return sql`
        SELECT *
        FROM sm.listing_spec${where(filters)}
        ORDER BY effective_from DESC, recorded_at DESC
      `;
    }
    // Every spec in force at some point in [from, to], oldest first: the one in force at from, then each change.
    if (params?.from || params?.to) {
      const from = params.from ? isoTimestamp('from', params.from) : '-infinity';
      const to = params.to ? isoTimestamp('to', params.to) : 'infinity';
      return sql`
        WITH versions AS (
          SELECT DISTINCT ON (listing_id, effective_from) *
          FROM sm.listing_spec${where([...filters, sql`effective_from <= ${to}::timestamptz`])}
          ORDER BY listing_id, effective_from, recorded_at DESC
        ), starts AS (
          SELECT listing_id, MAX(effective_from) AS start FROM versions
          WHERE effective_from <= ${from}::timestamptz GROUP BY listing_id
        )
        SELECT versions.*
        FROM versions LEFT JOIN starts USING (listing_id)
        WHERE versions.effective_from >= COALESCE(starts.start, '-infinity'::timestamptz)
        ORDER BY listing_id, effective_from
      `;
    }
    const at = params?.at ? sql`${isoTimestamp('at', params.at)}::timestamptz` : NOW;
    return sql`
      SELECT DISTINCT ON (listing_id) *
      FROM sm.listing_spec${where([...filters, sql`effective_from <= ${at}`])}
      ORDER BY listing_id, effective_from DESC, recorded_at DESC
    `;
  }

  // effectiveFrom dates a venue change; correction=true fixes the spec in force now. A listing's first spec may give
  // neither and holds since the epoch; a later one must give one (the insert trigger refuses it otherwise).
  generateInsertQuery(body: string): Sql {
    const spec = JSON.parse(body) as IListingSpec;
    if (spec.effectiveFrom != null && spec.correction) {
      throw new ValidationError('a spec takes effectiveFrom or correction, not both');
    }
    const priceBands = validatePriceBands(spec.priceBands);
    const effectiveFrom = spec.effectiveFrom != null
      ? sql`${isoTimestamp('effectiveFrom', spec.effectiveFrom)}::timestamptz`
      : spec.correction
        ? sql`(SELECT effective_from FROM sm.listing_spec WHERE listing_id = ${spec.listingId} AND effective_from <= NOW()
            ORDER BY effective_from DESC, recorded_at DESC LIMIT 1)`
        : null;
    return sql`
      INSERT INTO sm.listing_spec (listing_id, price_bands, lot_size, min_notional, contract_multiplier, min_size,
        effective_from)
      VALUES (${spec.listingId}, ${JSON.stringify(priceBands)}::jsonb, ${spec.lotSize}, ${spec.minNotional ?? 0},
        ${spec.contractMultiplier ?? 1000000000}, ${spec.minSize ?? 0}, ${effectiveFrom})
      RETURNING *`;
  }

  async createOne(body: string | null) {
    if (body) await this.checkGridEnds([JSON.parse(body) as IListingSpec]);
    return super.createOne(body);
  }

  async createMany(body: string | null) {
    const items = body ? JSON.parse(body) : null;
    if (Array.isArray(items) && items.length > 0) await this.checkGridEnds(items as IListingSpec[]);
    return super.createMany(body);
  }

  // Whether a listing is a binary contract lives on its security, which the insert can't see: one lookup per request.
  // A listing that doesn't exist is left to the insert's foreign key.
  private async checkGridEnds(specs: IListingSpec[]) {
    const bands = specs.map(spec => validatePriceBands(spec.priceBands));
    const ids = [...new Set(specs.map(spec => Number(spec.listingId)))].filter(Number.isSafeInteger);
    const { rows } = await this.client.query(sql`
      SELECT listing.listing_id, security.asset_class = ${AssetClass.PREDICTION} AS binary
      FROM sm.listing listing JOIN sm.security security USING (security_id)
      WHERE ${anyId('listing.listing_id', ids)}`);
    const binary = new Map<number, boolean>(rows.map((row: { listing_id: number; binary: boolean }) =>
      [Number(row.listing_id), row.binary]));
    specs.forEach((spec, i) => {
      const known = binary.get(Number(spec.listingId));
      if (known !== undefined) checkGridEnd(spec.listingId, bands[i], known);
    });
  }

  generateDeleteQuery(body: string): Sql {
    const spec = JSON.parse(body) as Pick<IListingSpec, 'listingId'>;
    return sql`DELETE FROM sm.listing_spec WHERE listing_id = ${spec.listingId} RETURNING *`;
  }

  generateModifyQuery(_row: any, _body: string): Sql {
    throw new Error('listing_spec is append-only — use POST to record a new spec');
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ListingSpecHandler().handleEvent(event);
};
