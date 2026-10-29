import { PoolClient } from 'pg';
import { parseIdList, withTransaction } from './base';
import {
  canonicalSubject,
  parseBody,
  PropositionError,
  propositionHandler,
  requirePositiveInt,
  requireString,
  requireSubject,
  touchSubjects,
} from './propositions-common';
import { sql, where } from './sql';

// What each security asks, written by the classifier. The registry stores `fields` as given; it resolves the subject
// through merges and marks every subject a proposition joins or leaves for a fresh derivation. Rewriting a proposition
// unchanged (a redelivered message) touches nothing.

const METHODS = ['VENUE', 'LLM'];
const DEFAULT_LIMIT = 5000;

export interface IUpsertProposition {
  securityId: number;
  extractedSubjectId: number;
  fields: Record<string, unknown>;
  method: string;
  extractorVersion: string;
  sourceHash: string;
}

export async function listPropositions(client: PoolClient, params: Record<string, string | undefined>) {
  const ids = params.securityIds !== undefined ? parseIdList(params.securityIds) : null;
  const subjectId = params.subjectId !== undefined ? Number(params.subjectId) : null;
  const filters = where([
    ids && sql`p.security_id = ANY(${ids}::int[])`,
    subjectId !== null && sql`p.subject_id = ${subjectId}`,
  ]);
  const limit = Math.min(Number(params.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, DEFAULT_LIMIT);
  const offset = Number(params.offset ?? 0) || 0;
  if (params.denormalize === 'true') {
    return (await client.query(sql`
      SELECT p.*, s.symbol, ec.event_id, ec.outcome_label, e.title AS event_title, e.resolved AS event_resolved,
             x.exchange_code, l.exchange_security_id
      FROM sm.contract_proposition p
      JOIN sm.security s ON s.security_id = p.security_id
      LEFT JOIN sm.event_contract ec ON ec.security_id = p.security_id
      LEFT JOIN sm.event e ON e.event_id = ec.event_id
      LEFT JOIN LATERAL (SELECT exchange_id, exchange_security_id FROM sm.listing
                         WHERE security_id = p.security_id ORDER BY listing_id LIMIT 1) l ON true
      LEFT JOIN sm.exchange x ON x.exchange_id = l.exchange_id
      ${filters}
      ORDER BY p.security_id
      LIMIT ${limit} OFFSET ${offset}`)).rows;
  }
  return (await client.query(sql`
    SELECT p.* FROM sm.contract_proposition p ${filters} ORDER BY p.security_id LIMIT ${limit} OFFSET ${offset}`)).rows;
}

export function parseProposition(item: unknown): IUpsertProposition {
  const p = item as IUpsertProposition;
  requirePositiveInt(p?.securityId, 'securityId');
  requirePositiveInt(p.extractedSubjectId, 'extractedSubjectId');
  if (typeof p.fields !== 'object' || p.fields === null || Array.isArray(p.fields)) {
    throw new PropositionError(400, 'fields must be an object');
  }
  if (!METHODS.includes(p.method)) throw new PropositionError(400, `method must be one of ${METHODS.join(', ')}`);
  requireString(p.extractorVersion, 'extractorVersion');
  requireString(p.sourceHash, 'sourceHash');
  return p;
}

export async function upsertPropositions(client: PoolClient, items: IUpsertProposition[]) {
  return withTransaction(client, async () => {
    const results = [];
    const touched = new Set<number>();
    for (const item of items) {
      await requireSubject(client, item.extractedSubjectId);
      const subjectId = await canonicalSubject(client, item.extractedSubjectId);
      const before = (await client.query(sql`
        SELECT subject_id FROM sm.contract_proposition WHERE security_id = ${item.securityId} FOR UPDATE`)).rows[0];
      const fields = JSON.stringify(item.fields);
      const row = (await client.query(sql`
        INSERT INTO sm.contract_proposition
          (security_id, subject_id, extracted_subject_id, fields, method, extractor_version, source_hash)
        VALUES (${item.securityId}, ${subjectId}, ${item.extractedSubjectId}, ${fields}::jsonb, ${item.method},
                ${item.extractorVersion}, ${item.sourceHash})
        ON CONFLICT (security_id) DO UPDATE SET
          subject_id = EXCLUDED.subject_id, extracted_subject_id = EXCLUDED.extracted_subject_id,
          fields = EXCLUDED.fields, method = EXCLUDED.method, extractor_version = EXCLUDED.extractor_version,
          source_hash = EXCLUDED.source_hash, date_modified = now()
        WHERE (contract_proposition.subject_id, contract_proposition.extracted_subject_id, contract_proposition.fields,
               contract_proposition.method, contract_proposition.extractor_version, contract_proposition.source_hash)
          IS DISTINCT FROM (EXCLUDED.subject_id, EXCLUDED.extracted_subject_id, EXCLUDED.fields, EXCLUDED.method,
                            EXCLUDED.extractor_version, EXCLUDED.source_hash)
        RETURNING *`)).rows[0];
      if (row) {
        touched.add(subjectId);
        if (before && before.subject_id !== subjectId) touched.add(before.subject_id);
      }
      results.push({ security_id: item.securityId, subject_id: subjectId, changed: Boolean(row) });
    }
    await touchSubjects(client, [...touched]);
    return results;
  });
}

export const handler = propositionHandler('Contract proposition', {
  GET: (client, event) => listPropositions(client, event.queryStringParameters ?? {}),
  POST: (client, event) => {
    const body = parseBody(event);
    const items = (Array.isArray(body) ? body : [body]).map(parseProposition);
    if (items.length === 0) throw new PropositionError(400, 'Expected at least one proposition');
    if (new Set(items.map((i) => i.securityId)).size !== items.length) {
      throw new PropositionError(400, 'Each security may appear once');
    }
    return upsertPropositions(client, items);
  },
});
