import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateSecurity, IDeleteSecurity } from '../types';

class SecurityHandler extends ResourceHandler {
  generateDeleteQuery(body: string): string {
    const security = JSON.parse(body) as IDeleteSecurity;
    return `
      DELETE FROM sm.security
      WHERE security_id = ${security.securityId};
    `;
  }

  generateInsertQuery(body: string): string {
    const security = JSON.parse(body) as ICreateSecurity;
    return `
      INSERT INTO sm.security (symbol, description, type)
      VALUES ('${security.symbol}',${security.description ? `'${security.description}'` : 'null'},${security.type})
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = "SELECT * FROM sm.security WHERE 1=1";

    if (params?.securityId) {
      query += ` AND security_id=${params.securityId}`;
    }
    if (params?.symbol) {
      query += ` AND symbol='${params.symbol}'`;
    }
    return query;
  }

  generateModifyQuery(row: any, body: string): string {
    const security = JSON.parse(body) as ICreateSecurity;
    let query = "UPDATE sm.security SET ";
    const updates: string[] = [];
    if (security.description) {
      updates.push(`description='${security.description}'`);
    }
    if (security.symbol) {
      updates.push(`symbol='${security.symbol}'`)
    }
    if (security.type) {
      updates.push(`type='${security.type}'`);
    }
    updates.push(`date_modified=NOW()`);
    const updateString = updates.join(", ");
    query += `${updateString} WHERE security_id=${row['security_id']} RETURNING *`;
    return query;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new SecurityHandler().handleEvent(event);
}
