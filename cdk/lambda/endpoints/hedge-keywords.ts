import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateHedgeKeyword, IDeleteHedgeKeyword } from '../types';

class HedgeKeywordHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'hedge_keyword_id'; }
  getCamelPrimaryKey(): string { return 'hedgeKeywordId'; }

  allowedSortColumns(): string[] {
    return ['hedge_keyword_id', 'security_id', 'keyword', 'date_created', 'date_modified'];
  }

  generateDeleteQuery(body: string): string {
    const hk = JSON.parse(body) as IDeleteHedgeKeyword;
    return `
      DELETE FROM sm.hedge_keyword
      WHERE hedge_keyword_id = ${hk.hedgeKeywordId}
      RETURNING *;
    `;
  }

  generateInsertQuery(body: string): string {
    const hk = JSON.parse(body) as ICreateHedgeKeyword;
    return `
      INSERT INTO sm.hedge_keyword (security_id, keyword)
      VALUES (${hk.securityId}, '${hk.keyword.replace(/'/g, "''")}')
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = `
      SELECT hk.*, s.symbol AS security_symbol
      FROM sm.hedge_keyword hk
      JOIN sm.security s ON s.security_id = hk.security_id
      WHERE 1=1
    `;
    if (params?.hedgeKeywordId) {
      query += ` AND hk.hedge_keyword_id = ${params.hedgeKeywordId}`;
    }
    if (params?.securityId) {
      query += ` AND hk.security_id = ${params.securityId}`;
    }
    if (params?.keyword) {
      query += ` AND hk.keyword = '${params.keyword.replace(/'/g, "''")}'`;
    }
    query += ' ORDER BY hk.date_created DESC';
    return query;
  }

  generateModifyQuery(row: any, body: string): string {
    const hk = JSON.parse(body) as Partial<ICreateHedgeKeyword>;
    const updates: string[] = [];
    if (hk.keyword !== undefined) updates.push(`keyword = '${hk.keyword.replace(/'/g, "''")}'`);
    updates.push('date_modified = NOW()');
    return `UPDATE sm.hedge_keyword SET ${updates.join(', ')} WHERE hedge_keyword_id = ${row['hedge_keyword_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new HedgeKeywordHandler().handleEvent(event);
};
