import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';

interface IListingSpec {
  listingId: number;
  tickSize: number;
  lotSize: number;
  minNotional?: number;
}

class ListingSpecHandler extends ResourceHandler {
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM sm.listing_spec WHERE 1=1';
    if (params?.listingId) {
      query += ` AND listing_id=${params.listingId}`;
    }
    return query;
  }

  generateInsertQuery(body: string): string {
    const spec = JSON.parse(body) as IListingSpec;
    const minNotional = spec.minNotional != null ? spec.minNotional : 'null';
    return `
      INSERT INTO sm.listing_spec (listing_id, tick_size, lot_size, min_notional)
      VALUES (${spec.listingId}, ${spec.tickSize}, ${spec.lotSize}, ${minNotional})
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

  generateModifyQuery(row: any, body: string): string {
    const spec = JSON.parse(body) as Partial<IListingSpec>;
    const updates: string[] = [];
    if (spec.tickSize != null) updates.push(`tick_size=${spec.tickSize}`);
    if (spec.lotSize != null) updates.push(`lot_size=${spec.lotSize}`);
    if (spec.minNotional != null) updates.push(`min_notional=${spec.minNotional}`);
    updates.push(`date_modified=NOW()`);
    return `
      UPDATE sm.listing_spec SET ${updates.join(', ')}
      WHERE listing_id=${row['listing_id']}
      RETURNING *;
    `;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ListingSpecHandler().handleEvent(event);
};
