import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { NOW, set, Sql, sql, where } from './sql';
import { ICreateHedgeKeyword, IDeleteHedgeKeyword } from '../types';

class HedgeKeywordHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'hedge_keyword_id'; }
  getCamelPrimaryKey(): string { return 'hedgeKeywordId'; }

  allowedSortColumns(): string[] {
    return ['hedge_keyword_id', 'security_id', 'keyword', 'date_created', 'date_modified'];
  }

  generateDeleteQuery(body: string): Sql {
    const hk = JSON.parse(body) as IDeleteHedgeKeyword;
    return sql`DELETE FROM sm.hedge_keyword WHERE hedge_keyword_id = ${hk.hedgeKeywordId} RETURNING *`;
  }

  generateInsertQuery(body: string): Sql {
    const hk = JSON.parse(body) as ICreateHedgeKeyword;
    return sql`INSERT INTO sm.hedge_keyword (security_id, keyword) VALUES (${hk.securityId}, ${hk.keyword}) RETURNING *`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    return sql`
      SELECT hk.*, s.symbol AS security_symbol
      FROM sm.hedge_keyword hk
      JOIN sm.security s ON s.security_id = hk.security_id${where([
        params?.hedgeKeywordId && sql`hk.hedge_keyword_id = ${params.hedgeKeywordId}`,
        params?.securityId && sql`hk.security_id = ${params.securityId}`,
        params?.keyword && sql`hk.keyword = ${params.keyword}`,
      ])}
      ORDER BY hk.date_created DESC`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const hk = JSON.parse(body) as Partial<ICreateHedgeKeyword>;
    return sql`UPDATE sm.hedge_keyword SET ${set({ keyword: hk.keyword, date_modified: NOW })}
      WHERE hedge_keyword_id = ${row['hedge_keyword_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new HedgeKeywordHandler().handleEvent(event);
};
