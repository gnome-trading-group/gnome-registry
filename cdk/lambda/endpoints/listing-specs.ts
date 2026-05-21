import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';

interface IListingSpec {
  listingId: number;
  tickSize: number;
  lotSize: number;
  minNotional?: number;
  contractMultiplier?: number;
}

class ListingSpecHandler extends ResourceHandler {
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let where = '1=1';
    if (params?.listingId) {
      where += ` AND listing_id=${params.listingId}`;
    }
    if (params?.before) {
      where += ` AND recorded_at <= '${params.before}'`;
    }
    return `
      SELECT DISTINCT ON (listing_id) *
      FROM sm.listing_spec
      WHERE ${where}
      ORDER BY listing_id, recorded_at DESC
    `;
  }

  generateInsertQuery(body: string): string {
    const spec = JSON.parse(body) as IListingSpec;
    const minNotional = spec.minNotional ?? 0;
    const contractMultiplier = spec.contractMultiplier ?? 1000000000;
    return `
      INSERT INTO sm.listing_spec (listing_id, tick_size, lot_size, min_notional, contract_multiplier)
      VALUES (${spec.listingId}, ${spec.tickSize}, ${spec.lotSize}, ${minNotional}, ${contractMultiplier})
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
