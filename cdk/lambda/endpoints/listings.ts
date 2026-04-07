import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateListing, IDeleteListing } from '../types';

class ListingHandler extends ResourceHandler {
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
      VALUES ('${listing.exchangeId}',${listing.securityId},'${listing.exchangeSecurityId}','${listing.exchangeSecuritySymbol}')
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = "SELECT * FROM sm.listing WHERE 1=1";

    if (params?.listingId) {
      query += ` AND listing_id=${params.listingId}`;
    }
    if (params?.securityId) {
      query += ` AND security_id=${params.securityId}`;
    }
    if (params?.exchangeId) {
      query += ` AND exchange_id=${params.exchangeId}`;
    }
    if (params?.exchangeSecurityId) {
      query += ` AND exchange_security_id='${params.exchangeSecurityId}'`;
    }
    if (params?.exchangeSecuritySymbol) {
      query += ` AND exchange_security_symbol='${params.exchangeSecuritySymbol}'`;
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
    updates.push(`date_modified=NOW()`);
    const updateString = updates.join(", ");
    query += `${updateString} WHERE listing_id=${row['listing_id']} RETURNING *`;
    return query;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ListingHandler().handleEvent(event);
}
