import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, ValidationError } from './base';
import { isoTimestamp } from './fees';

interface IListingSpec {
  listingId: number;
  tickSize: number;
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
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let where = '1=1';
    if (params?.listingId) {
      where += ` AND listing_id=${params.listingId}`;
    }
    if (params?.exchangeId) {
      where += ` AND listing_id IN (SELECT listing_id FROM sm.listing WHERE exchange_id=${params.exchangeId})`;
    }
    if (params?.knownAsOf) {
      where += ` AND recorded_at <= '${isoTimestamp('knownAsOf', params.knownAsOf)}'`;
    }
    if (params?.history === 'true') {
      return `
        SELECT *
        FROM sm.listing_spec
        WHERE ${where}
        ORDER BY effective_from DESC, recorded_at DESC
      `;
    }
    // Every spec in force at some point in [from, to], oldest first: the one in force at from, then each change.
    if (params?.from || params?.to) {
      const from = params.from ? `'${isoTimestamp('from', params.from)}'` : `'-infinity'`;
      const to = params.to ? `'${isoTimestamp('to', params.to)}'` : `'infinity'`;
      return `
        WITH versions AS (
          SELECT DISTINCT ON (listing_id, effective_from) *
          FROM sm.listing_spec
          WHERE ${where} AND effective_from <= ${to}::timestamptz
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
    const at = params?.at ? `'${isoTimestamp('at', params.at)}'` : 'NOW()';
    return `
      SELECT DISTINCT ON (listing_id) *
      FROM sm.listing_spec
      WHERE ${where} AND effective_from <= ${at}::timestamptz
      ORDER BY listing_id, effective_from DESC, recorded_at DESC
    `;
  }

  // effectiveFrom dates a venue change; correction=true fixes the spec in force now. With neither, a listing's first
  // spec holds since the epoch and later ones from now (the insert trigger).
  generateInsertQuery(body: string): string {
    const spec = JSON.parse(body) as IListingSpec;
    const minNotional = spec.minNotional ?? 0;
    const contractMultiplier = spec.contractMultiplier ?? 1000000000;
    const minSize = spec.minSize ?? 0;
    if (spec.effectiveFrom != null && spec.correction) {
      throw new ValidationError('a spec takes effectiveFrom or correction, not both');
    }
    const effectiveFrom = spec.effectiveFrom != null
      ? `'${isoTimestamp('effectiveFrom', spec.effectiveFrom)}'::timestamptz`
      : spec.correction
        ? `(SELECT effective_from FROM sm.listing_spec WHERE listing_id=${spec.listingId} AND effective_from <= NOW()
            ORDER BY effective_from DESC, recorded_at DESC LIMIT 1)`
        : 'NULL';
    return `
      INSERT INTO sm.listing_spec (listing_id, tick_size, lot_size, min_notional, contract_multiplier, min_size,
        effective_from)
      VALUES (${spec.listingId}, ${spec.tickSize}, ${spec.lotSize}, ${minNotional}, ${contractMultiplier}, ${minSize},
        ${effectiveFrom})
      RETURNING *;
    `;
  }

  generateDeleteQuery(body: string): string {
    const spec = JSON.parse(body) as Pick<IListingSpec, 'listingId'>;
    return `
      DELETE FROM sm.listing_spec
      WHERE listing_id = ${spec.listingId}
      RETURNING *;
    `;
  }

  generateModifyQuery(_row: any, _body: string): string {
    throw new Error('listing_spec is append-only — use POST to record a new spec');
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ListingSpecHandler().handleEvent(event);
};
