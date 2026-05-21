import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';

interface ICurrency {
  currencyId: number;
  symbol: string;
  name?: string;
  decimals: number;
}

class CurrencyHandler extends ResourceHandler {
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM sm.currency WHERE 1=1';
    if (params?.currencyId) {
      query += ` AND currency_id=${params.currencyId}`;
    }
    if (params?.symbol) {
      query += ` AND symbol='${params.symbol}'`;
    }
    return query;
  }

  generateInsertQuery(body: string): string {
    const currency = JSON.parse(body) as Partial<ICurrency>;
    const name = currency.name ? `'${currency.name}'` : 'null';
    const decimals = currency.decimals ?? 8;
    return `
      INSERT INTO sm.currency (symbol, name, decimals)
      VALUES ('${currency.symbol}', ${name}, ${decimals})
      RETURNING *;
    `;
  }

  generateDeleteQuery(body: string): string {
    const currency = JSON.parse(body) as Pick<ICurrency, 'currencyId'>;
    return `
      DELETE FROM sm.currency
      WHERE currency_id = ${currency.currencyId}
      RETURNING *;
    `;
  }

  generateModifyQuery(row: any, body: string): string {
    const currency = JSON.parse(body) as Partial<ICurrency>;
    const updates: string[] = [];
    if (currency.symbol) updates.push(`symbol='${currency.symbol}'`);
    if (currency.name !== undefined) updates.push(`name=${currency.name ? `'${currency.name}'` : 'null'}`);
    if (currency.decimals != null) updates.push(`decimals=${currency.decimals}`);
    updates.push(`date_modified=NOW()`);
    return `
      UPDATE sm.currency SET ${updates.join(', ')}
      WHERE currency_id=${row['currency_id']}
      RETURNING *;
    `;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new CurrencyHandler().handleEvent(event);
};
