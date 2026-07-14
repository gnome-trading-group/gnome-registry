import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateListing, IDeleteListing } from '../types';

class ListingHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'listing_id'; }
  getCamelPrimaryKey(): string { return 'listingId'; }

  allowedSortColumns(): string[] {
    return ['listing_id', 'security_id', 'exchange_id', 'exchange_security_symbol', 'date_created', 'date_modified'];
  }

  generateDeleteQuery(body: string): string {
    const listing = JSON.parse(body) as IDeleteListing;
    return `
      DELETE FROM sm.listing
      WHERE listing_id = ${listing.listingId};
    `;
  }

  generateInsertQuery(body: string): string {
    const listing = JSON.parse(body) as ICreateListing;
    return `
      INSERT INTO sm.listing (exchange_id,security_id,exchange_security_id,exchange_security_symbol)
      VALUES (${listing.exchangeId},${listing.securityId},'${listing.exchangeSecurityId.replace(/'/g, "''")}','${listing.exchangeSecuritySymbol.replace(/'/g, "''")}')
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    const denormalize = params?.denormalize === 'true';

    let query = denormalize
      ? `SELECT l.*, e.exchange_name, s.symbol AS security_symbol, s.type AS security_type, s.active AS security_active
         FROM sm.listing l
         JOIN sm.exchange e ON l.exchange_id = e.exchange_id
         JOIN sm.security s ON l.security_id = s.security_id
         WHERE 1=1`
      : 'SELECT * FROM sm.listing WHERE 1=1';

    if (params?.listingId) {
      query += denormalize ? ` AND l.listing_id=${params.listingId}` : ` AND listing_id=${params.listingId}`;
    }
    if (params?.securityId) {
      query += denormalize ? ` AND l.security_id=${params.securityId}` : ` AND security_id=${params.securityId}`;
    }
    if (params?.exchangeId) {
      query += denormalize ? ` AND l.exchange_id=${params.exchangeId}` : ` AND exchange_id=${params.exchangeId}`;
    }
    if (params?.exchangeSecurityId) {
      query += denormalize
        ? ` AND l.exchange_security_id='${params.exchangeSecurityId}'`
        : ` AND exchange_security_id='${params.exchangeSecurityId}'`;
    }
    if (params?.exchangeSecuritySymbol) {
      query += denormalize
        ? ` AND l.exchange_security_symbol='${params.exchangeSecuritySymbol}'`
        : ` AND exchange_security_symbol='${params.exchangeSecuritySymbol}'`;
    }
    if (params?.search && denormalize) {
      const escaped = params.search.replace(/'/g, "''");
      query += ` AND (s.symbol ILIKE '%${escaped}%' OR e.exchange_name ILIKE '%${escaped}%' OR l.exchange_security_symbol ILIKE '%${escaped}%')`;
    }
    if (params?.active !== undefined) {
      query += denormalize ? ` AND l.active=${params.active === 'true'}` : ` AND active=${params.active === 'true'}`;
    }
    return query;
  }

  generateModifyQuery(row: any, body: string): string {
    const listing = JSON.parse(body) as ICreateListing;
    let query = "UPDATE sm.listing SET ";
    const updates: string[] = [];
    if (listing.exchangeId) {
      updates.push(`exchange_id=${listing.exchangeId}`);
    }
    if (listing.exchangeSecurityId) {
      updates.push(`exchange_security_id='${listing.exchangeSecurityId}'`)
    }
    if (listing.exchangeSecuritySymbol) {
      updates.push(`exchange_security_symbol='${listing.exchangeSecuritySymbol}'`);
    }
    if (listing.securityId) {
      updates.push(`security_id=${listing.securityId}`);
    }
    if (listing.active != null) {
      updates.push(`active=${listing.active}`);
    }
    updates.push(`date_modified=NOW()`);
    const updateString = updates.join(", ");
    query += `${updateString} WHERE listing_id=${row['listing_id']} RETURNING *`;
    return query;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ListingHandler().handleEvent(event);
}
