import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler } from './base';
import { anyId, NOW, raw, set, Sql, sql, where } from './sql';
import { ICreateSecurity, IDeleteSecurity } from '../types';

function currencyColumns(alias: string): string {
  return `
    (SELECT symbol FROM sm.currency WHERE currency_id = ${alias}.base_currency_id) AS base_currency,
    (SELECT symbol FROM sm.currency WHERE currency_id = ${alias}.quote_currency_id) AS quote_currency,
    (SELECT symbol FROM sm.currency WHERE currency_id = ${alias}.settle_currency_id) AS settle_currency`;
}

export class SecurityHandler extends ResourceHandler {
  getPrimaryKey(): string { return 'security_id'; }
  getCamelPrimaryKey(): string { return 'securityId'; }

  allowedSortColumns(): string[] {
    return ['security_id', 'symbol', 'type', 'asset_class', 'active', 'date_created', 'date_modified'];
  }

  generateDeleteQuery(body: string): Sql {
    const security = JSON.parse(body) as IDeleteSecurity;
    return sql`DELETE FROM sm.security WHERE security_id = ${security.securityId} RETURNING *`;
  }

  generateInsertQuery(body: string): Sql {
    const s = JSON.parse(body) as ICreateSecurity;
    return sql`
      WITH ins AS (
        INSERT INTO sm.security (
          symbol, description, type, contract_type, asset_class,
          base_currency_id, quote_currency_id, settle_currency_id,
          inverse, is_quanto, expiry, strike_price, active, underlying_security_id
        ) VALUES (
          ${s.symbol},
          ${s.description || null},
          ${s.type},
          ${s.contractType ?? 0},
          ${s.assetClass ?? 0},
          ${s.baseCurrencyId ?? null},
          ${s.quoteCurrencyId ?? null},
          ${s.settleCurrencyId ?? null},
          ${s.inverse ?? false},
          ${s.quanto ?? false},
          ${s.expiry ?? null},
          ${s.strikePrice ?? null},
          ${s.active ?? true},
          ${s.underlyingSecurityId ?? null}
        )
        RETURNING *
      )
      SELECT ins.*,${raw(currencyColumns('ins'))}
      FROM ins`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    const pattern = `%${params?.search}%`;
    return sql`
      SELECT s.*,${raw(currencyColumns('s'))}
      FROM sm.security s${where([
        params?.securityId && sql`s.security_id = ${params.securityId}`,
        params?.securityIds !== undefined && anyId('s.security_id', parseIdList(params.securityIds)),
        params?.symbol && sql`s.symbol = ${params.symbol}`,
        params?.type && sql`s.type = ${params.type}`,
        params?.active && sql`s.active = ${params.active}`,
        params?.contractType && sql`s.contract_type = ${params.contractType}`,
        params?.assetClass && sql`s.asset_class = ${params.assetClass}`,
        params?.search && sql`(s.symbol ILIKE ${pattern} OR s.description ILIKE ${pattern})`,
      ])}`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const s = JSON.parse(body) as ICreateSecurity;
    return sql`
      WITH upd AS (
        UPDATE sm.security SET ${set({
          description: s.description === undefined ? undefined : s.description || null,
          symbol: s.symbol || undefined,
          type: s.type ?? undefined,
          contract_type: s.contractType ?? undefined,
          asset_class: s.assetClass ?? undefined,
          base_currency_id: s.baseCurrencyId,
          quote_currency_id: s.quoteCurrencyId,
          settle_currency_id: s.settleCurrencyId,
          inverse: s.inverse ?? undefined,
          is_quanto: s.quanto ?? undefined,
          expiry: s.expiry,
          strike_price: s.strikePrice,
          active: s.active ?? undefined,
          underlying_security_id: s.underlyingSecurityId,
          date_modified: NOW,
        })}
        WHERE security_id = ${row['security_id']}
        RETURNING *
      )
      SELECT upd.*,${raw(currencyColumns('upd'))}
      FROM upd`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new SecurityHandler().handleEvent(event);
}
