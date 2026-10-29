import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { NOW, set, Sql, sql, where } from './sql';

interface ICurrency {
  currencyId: number;
  symbol: string;
  name?: string;
  decimals: number;
}

class CurrencyHandler extends ResourceHandler {
  allowedSortColumns(): string[] {
    return ['currency_id', 'symbol', 'name', 'decimals', 'date_created', 'date_modified'];
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    const pattern = `%${params?.search}%`;
    return sql`SELECT * FROM sm.currency${where([
      params?.currencyId && sql`currency_id = ${params.currencyId}`,
      params?.symbol && sql`symbol = ${params.symbol}`,
      params?.search && sql`(symbol ILIKE ${pattern} OR name ILIKE ${pattern})`,
    ])}`;
  }

  generateInsertQuery(body: string): Sql {
    const currency = JSON.parse(body) as Partial<ICurrency>;
    return sql`
      INSERT INTO sm.currency (symbol, name, decimals)
      VALUES (${currency.symbol}, ${currency.name || null}, ${currency.decimals ?? 8})
      RETURNING *`;
  }

  generateDeleteQuery(body: string): Sql {
    const currency = JSON.parse(body) as Pick<ICurrency, 'currencyId'>;
    return sql`DELETE FROM sm.currency WHERE currency_id = ${currency.currencyId} RETURNING *`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const currency = JSON.parse(body) as Partial<ICurrency>;
    return sql`UPDATE sm.currency SET ${set({
      symbol: currency.symbol || undefined,
      name: currency.name === undefined ? undefined : currency.name || null,
      decimals: currency.decimals ?? undefined,
      date_modified: NOW,
    })} WHERE currency_id = ${row['currency_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new CurrencyHandler().handleEvent(event);
};
