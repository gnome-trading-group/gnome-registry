import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler } from './base';
import { ICreateListing, IDeleteListing } from '../types';
import { anyId, NOW, raw, set, Sql, sql, where } from './sql';

export class ListingHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'listing_id'; }
  getCamelPrimaryKey(): string { return 'listingId'; }

  allowedSortColumns(): string[] {
    return ['listing_id', 'security_id', 'exchange_id', 'exchange_security_symbol', 'date_created', 'date_modified'];
  }

  generateDeleteQuery(body: string): Sql {
    const listing = JSON.parse(body) as IDeleteListing;
    return sql`DELETE FROM sm.listing WHERE listing_id = ${listing.listingId}`;
  }

  generateInsertQuery(body: string): Sql {
    const listing = JSON.parse(body) as ICreateListing;
    return sql`
      INSERT INTO sm.listing (exchange_id, security_id, exchange_security_id, exchange_security_symbol, fee_group, fee_event)
      VALUES (${listing.exchangeId}, ${listing.securityId}, ${listing.exchangeSecurityId}, ${listing.exchangeSecuritySymbol},
              ${listing.feeGroup ?? null}, ${listing.feeEvent ?? null})
      RETURNING *`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    const denormalize = params?.denormalize === 'true';
    const column = (name: string) => (denormalize ? `l.${name}` : name);
    const pattern = `%${params?.search}%`;

    const from = denormalize
      ? sql`SELECT l.*, e.exchange_name, s.symbol AS security_symbol, s.type AS security_type, s.active AS security_active
         FROM sm.listing l
         JOIN sm.exchange e ON l.exchange_id = e.exchange_id
         JOIN sm.security s ON l.security_id = s.security_id`
      : sql`SELECT * FROM sm.listing`;

    return sql`${from}${where([
      params?.listingId && sql`${raw(column('listing_id'))} = ${params.listingId}`,
      // Batch lookup for UIs labelling many listings at once.
      params?.listingIds !== undefined && anyId(column('listing_id'), parseIdList(params.listingIds)),
      params?.securityId && sql`${raw(column('security_id'))} = ${params.securityId}`,
      params?.exchangeId && sql`${raw(column('exchange_id'))} = ${params.exchangeId}`,
      params?.exchangeSecurityId && sql`${raw(column('exchange_security_id'))} = ${params.exchangeSecurityId}`,
      params?.exchangeSecuritySymbol && sql`${raw(column('exchange_security_symbol'))} = ${params.exchangeSecuritySymbol}`,
      params?.search && denormalize
        && sql`(s.symbol ILIKE ${pattern} OR e.exchange_name ILIKE ${pattern} OR l.exchange_security_symbol ILIKE ${pattern} OR l.listing_id::text = ${params.search})`,
      params?.active !== undefined && sql`${raw(column('active'))} = ${params.active === 'true'}`,
    ])}`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const listing = JSON.parse(body) as ICreateListing;
    return sql`UPDATE sm.listing SET ${set({
      exchange_id: listing.exchangeId || undefined,
      exchange_security_id: listing.exchangeSecurityId || undefined,
      exchange_security_symbol: listing.exchangeSecuritySymbol || undefined,
      security_id: listing.securityId || undefined,
      active: listing.active ?? undefined,
      // Present-but-null clears a fee key: a venue that stops grouping a listing's fees.
      fee_group: 'feeGroup' in listing ? listing.feeGroup ?? null : undefined,
      fee_event: 'feeEvent' in listing ? listing.feeEvent ?? null : undefined,
      date_modified: NOW,
    })} WHERE listing_id = ${row['listing_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ListingHandler().handleEvent(event);
}
