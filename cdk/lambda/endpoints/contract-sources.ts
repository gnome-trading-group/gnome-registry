import { PoolClient } from 'pg';
import { parseIdList, withTransaction } from './base';
import { parseBody, PropositionError, propositionHandler, requirePositiveInt, requireString } from './propositions-common';
import { sql, where } from './sql';

// The venue's own description of each security, written by the classifier when it creates or refreshes the security.
// Stored as given; rewriting an unchanged source (same hash) changes nothing.

const DEFAULT_LIMIT = 5000;

export interface IUpsertSource {
  securityId: number;
  exchangeId: number;
  source: Record<string, unknown>;
  sourceHash: string;
}

export async function listSources(client: PoolClient, params: Record<string, string | undefined>) {
  const ids = params.securityIds !== undefined ? parseIdList(params.securityIds) : null;
  const exchangeId = params.exchangeId !== undefined ? Number(params.exchangeId) : null;
  const limit = Math.min(Number(params.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, DEFAULT_LIMIT);
  const offset = Number(params.offset ?? 0) || 0;
  return (await client.query(sql`
    SELECT * FROM sm.contract_source s
    ${where([ids && sql`s.security_id = ANY(${ids}::int[])`, exchangeId !== null && sql`s.exchange_id = ${exchangeId}`])}
    ORDER BY s.security_id LIMIT ${limit} OFFSET ${offset}`)).rows;
}

export function parseSource(item: unknown): IUpsertSource {
  const s = item as IUpsertSource;
  requirePositiveInt(s?.securityId, 'securityId');
  requirePositiveInt(s.exchangeId, 'exchangeId');
  if (typeof s.source !== 'object' || s.source === null || Array.isArray(s.source)) {
    throw new PropositionError(400, 'source must be an object');
  }
  requireString(s.sourceHash, 'sourceHash');
  return s;
}

export async function upsertSources(client: PoolClient, items: IUpsertSource[]) {
  return withTransaction(client, async () => {
    const results = [];
    for (const item of items) {
      const row = (await client.query(sql`
        INSERT INTO sm.contract_source (security_id, exchange_id, source, source_hash)
        VALUES (${item.securityId}, ${item.exchangeId}, ${JSON.stringify(item.source)}::jsonb, ${item.sourceHash})
        ON CONFLICT (security_id) DO UPDATE SET
          exchange_id = EXCLUDED.exchange_id, source = EXCLUDED.source, source_hash = EXCLUDED.source_hash,
          date_modified = now()
        WHERE contract_source.source_hash IS DISTINCT FROM EXCLUDED.source_hash
        RETURNING security_id`)).rows[0];
      results.push({ security_id: item.securityId, changed: Boolean(row) });
    }
    return results;
  });
}

export const handler = propositionHandler('Contract source', {
  GET: (client, event) => listSources(client, event.queryStringParameters ?? {}),
  POST: (client, event) => {
    const body = parseBody(event);
    const items = (Array.isArray(body) ? body : [body]).map(parseSource);
    if (items.length === 0) throw new PropositionError(400, 'Expected at least one source');
    if (new Set(items.map((i) => i.securityId)).size !== items.length) {
      throw new PropositionError(400, 'Each security may appear once');
    }
    return upsertSources(client, items);
  },
});
