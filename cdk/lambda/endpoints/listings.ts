import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler, ValidationError } from './base';
import { ICreateListing, IDeleteListing } from '../types';
import { anyId, NOW, raw, set, Sql, sql, where } from './sql';

/** A 24h volume: null when absent; anything not a number is refused. */
function volume(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(Number(value))) {
    throw new ValidationError(`volume24h must be a number or null, got ${value}`);
  }
  return Number(value);
}

/** Comma-separated security type codes (sm.security.type), e.g. "1,0"; anything else is refused. */
function securityTypes(value: string): number[] {
  const codes = value.split(',').map((v) => v.trim()).filter(Boolean).map(Number);
  if (codes.length === 0 || !codes.every((code) => Number.isInteger(code) && code >= 0)) {
    throw new ValidationError(`securityTypes must be security type codes, got ${value}`);
  }
  return codes;
}

export class ListingHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'listing_id'; }
  getCamelPrimaryKey(): string { return 'listingId'; }

  allowedSortColumns(): string[] {
    return ['listing_id', 'security_id', 'exchange_id', 'exchange_security_symbol', 'volume_24h', 'date_created',
      'date_modified'];
  }

  sortTieBreaker(): string { return 'listing_id'; }

  generateDeleteQuery(body: string): Sql {
    const listing = JSON.parse(body) as IDeleteListing;
    return sql`DELETE FROM sm.listing WHERE listing_id = ${listing.listingId}`;
  }

  generateInsertQuery(body: string): Sql {
    const listing = JSON.parse(body) as ICreateListing;
    // The sync reads a new listing's volume in the same fetch that finds it, so it has one from the start.
    const volume24h = volume(listing.volume24h);
    return sql`
      INSERT INTO sm.listing (exchange_id, security_id, exchange_security_id, exchange_security_symbol, fee_group, fee_event,
                              venue_partition, active, volume_24h, volume_updated_at)
      VALUES (${listing.exchangeId}, ${listing.securityId}, ${listing.exchangeSecurityId}, ${listing.exchangeSecuritySymbol},
              ${listing.feeGroup ?? null}, ${listing.feeEvent ?? null}, ${listing.venuePartition ?? null},
              ${listing.active ?? true}, ${volume24h}, ${raw(volume24h === null ? 'NULL' : 'NOW()')})
      RETURNING *`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    const pattern = `%${params?.search}%`;
    let minVolume: number | undefined;
    if (params?.minVolume24h) {
      minVolume = Number(params.minVolume24h);
      if (!Number.isFinite(minVolume)) {
        throw new ValidationError(`minVolume24h must be a number, got ${params.minVolume24h}`);
      }
    }

    // Every listing has exactly one exchange and one security, so a count gets the same answer without the joins.
    const from = params?.denormalize === 'true' && params?.count !== 'true'
      ? sql`SELECT l.*, e.exchange_name, s.symbol AS security_symbol, s.type AS security_type, s.active AS security_active
         FROM sm.listing l
         JOIN sm.exchange e ON l.exchange_id = e.exchange_id
         JOIN sm.security s ON l.security_id = s.security_id`
      : sql`SELECT l.* FROM sm.listing l`;

    const query = sql`${from}${where([
      params?.listingId && sql`l.listing_id = ${params.listingId}`,
      // Batch lookup for UIs labelling many listings at once.
      params?.listingIds !== undefined && anyId('l.listing_id', parseIdList(params.listingIds)),
      params?.securityId && sql`l.security_id = ${params.securityId}`,
      params?.exchangeId && sql`l.exchange_id = ${params.exchangeId}`,
      params?.exchangeIds !== undefined && anyId('l.exchange_id', parseIdList(params.exchangeIds)),
      params?.securityTypes !== undefined && sql`l.security_id IN (
        SELECT security_id FROM sm.security WHERE type = ANY(${securityTypes(params.securityTypes)}::int[]))`,
      minVolume !== undefined && sql`l.volume_24h >= ${minVolume}`,
      params?.exchangeSecurityId && sql`l.exchange_security_id = ${params.exchangeSecurityId}`,
      params?.exchangeSecuritySymbol && sql`l.exchange_security_symbol = ${params.exchangeSecuritySymbol}`,
      params?.search && params?.denormalize === 'true' && sql`l.exchange_security_symbol ILIKE ${pattern}`,
      params?.active !== undefined && sql`l.active = ${params.active === 'true'}`,
    ])}`;
    // By volume, listings with none yet sort last either way, and ties keep a stable order for paging.
    if (params?.sortBy === 'volume_24h') {
      const order = params.sortOrder === 'desc' ? 'DESC' : 'ASC';
      return sql`${query} ORDER BY l.volume_24h ${raw(order)} NULLS LAST, l.listing_id`;
    }
    return query;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const listing = JSON.parse(body) as ICreateListing;
    const { listingId: _listingId, volume24h, ...edits } = listing as ICreateListing & { listingId?: number };
    // Volume is the sync's reading, not an edit of the listing, so a patch of volume alone leaves date_modified alone.
    const volumeRead = volume24h !== undefined;
    const edited = Object.values(edits).some((value) => value !== undefined);
    return sql`UPDATE sm.listing SET ${set({
      exchange_id: listing.exchangeId || undefined,
      exchange_security_id: listing.exchangeSecurityId || undefined,
      exchange_security_symbol: listing.exchangeSecuritySymbol || undefined,
      security_id: listing.securityId || undefined,
      active: listing.active ?? undefined,
      // Present-but-null clears a fee key: a venue that stops grouping a listing's fees.
      fee_group: 'feeGroup' in listing ? listing.feeGroup ?? null : undefined,
      fee_event: 'feeEvent' in listing ? listing.feeEvent ?? null : undefined,
      venue_partition: 'venuePartition' in listing ? listing.venuePartition ?? null : undefined,
      volume_24h: volumeRead ? volume(volume24h) : undefined,
      volume_updated_at: volumeRead ? NOW : undefined,
      date_modified: edited || !volumeRead ? NOW : undefined,
    })} WHERE listing_id = ${row['listing_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ListingHandler().handleEvent(event);
}
