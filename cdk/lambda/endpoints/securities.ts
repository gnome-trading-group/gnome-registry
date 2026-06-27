import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateSecurity, IDeleteSecurity } from '../types';

function currencyColumns(alias: string): string {
  return `
    (SELECT symbol FROM sm.currency WHERE currency_id = ${alias}.base_currency_id) AS base_currency,
    (SELECT symbol FROM sm.currency WHERE currency_id = ${alias}.quote_currency_id) AS quote_currency,
    (SELECT symbol FROM sm.currency WHERE currency_id = ${alias}.settle_currency_id) AS settle_currency`;
}

class SecurityHandler extends ResourceHandler {
  allowedSortColumns(): string[] {
    return ['security_id', 'symbol', 'type', 'asset_class', 'active', 'date_created', 'date_modified'];
  }

  generateDeleteQuery(body: string): string {
    const security = JSON.parse(body) as IDeleteSecurity;
    return `
      DELETE FROM sm.security
      WHERE security_id = ${security.securityId}
      RETURNING *;
    `;
  }

  generateInsertQuery(body: string): string {
    const s = JSON.parse(body) as ICreateSecurity;
    return `
      WITH ins AS (
        INSERT INTO sm.security (
          symbol, description, type, contract_type, asset_class,
          base_currency_id, quote_currency_id, settle_currency_id,
          inverse, is_quanto, expiry, strike_price, active, underlying_security_id
        ) VALUES (
          '${s.symbol}',
          ${s.description ? `'${s.description}'` : 'null'},
          ${s.type},
          ${s.contractType ?? 0},
          ${s.assetClass ?? 0},
          ${s.baseCurrencyId ?? 'null'},
          ${s.quoteCurrencyId ?? 'null'},
          ${s.settleCurrencyId ?? 'null'},
          ${s.inverse ?? false},
          ${s.quanto ?? false},
          ${s.expiry != null ? `'${s.expiry}'` : 'null'},
          ${s.strikePrice ?? 'null'},
          ${s.active ?? true},
          ${s.underlyingSecurityId ?? 'null'}
        )
        RETURNING *
      )
      SELECT ins.*,${currencyColumns('ins')}
      FROM ins
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = `
      SELECT s.*,${currencyColumns('s')}
      FROM sm.security s
      WHERE 1=1`;

    if (params?.securityId) {
      query += ` AND s.security_id=${params.securityId}`;
    }
    if (params?.symbol) {
      query += ` AND s.symbol='${params.symbol}'`;
    }
    if (params?.type) {
      query += ` AND s.type=${params.type}`;
    }
    if (params?.active) {
      query += ` AND s.active=${params.active}`;
    }
    if (params?.contractType) {
      query += ` AND s.contract_type=${params.contractType}`;
    }
    if (params?.search) {
      const escaped = params.search.replace(/'/g, "''");
      query += ` AND (s.symbol ILIKE '%${escaped}%' OR s.description ILIKE '%${escaped}%')`;
    }
    return query;
  }

  generateModifyQuery(row: any, body: string): string {
    const s = JSON.parse(body) as ICreateSecurity;
    const updates: string[] = [];
    if (s.description !== undefined) updates.push(`description=${s.description ? `'${s.description}'` : 'null'}`);
    if (s.symbol) updates.push(`symbol='${s.symbol}'`);
    if (s.type != null) updates.push(`type=${s.type}`);
    if (s.contractType != null) updates.push(`contract_type=${s.contractType}`);
    if (s.assetClass != null) updates.push(`asset_class=${s.assetClass}`);
    if (s.baseCurrencyId !== undefined) updates.push(`base_currency_id=${s.baseCurrencyId ?? 'null'}`);
    if (s.quoteCurrencyId !== undefined) updates.push(`quote_currency_id=${s.quoteCurrencyId ?? 'null'}`);
    if (s.settleCurrencyId !== undefined) updates.push(`settle_currency_id=${s.settleCurrencyId ?? 'null'}`);
    if (s.inverse != null) updates.push(`inverse=${s.inverse}`);
    if (s.quanto != null) updates.push(`is_quanto=${s.quanto}`);
    if (s.expiry !== undefined) updates.push(`expiry=${s.expiry != null ? `'${s.expiry}'` : 'null'}`);
    if (s.strikePrice !== undefined) updates.push(`strike_price=${s.strikePrice ?? 'null'}`);
    if (s.active != null) updates.push(`active=${s.active}`);
    if (s.underlyingSecurityId !== undefined) updates.push(`underlying_security_id=${s.underlyingSecurityId ?? 'null'}`);
    updates.push(`date_modified=NOW()`);
    return `
      WITH upd AS (
        UPDATE sm.security SET ${updates.join(', ')}
        WHERE security_id=${row['security_id']}
        RETURNING *
      )
      SELECT upd.*,${currencyColumns('upd')}
      FROM upd
    `;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new SecurityHandler().handleEvent(event);
}
