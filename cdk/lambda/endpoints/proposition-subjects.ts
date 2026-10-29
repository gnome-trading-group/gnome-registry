import { PoolClient } from 'pg';
import { parseIdList } from './base';
import { parseBody, PropositionError, propositionHandler, requirePositiveInt, requireString } from './propositions-common';
import { raw, sql, where } from './sql';

// Proposition subjects. The classifier creates them (an upsert by key); everyone reads them, and the controller's
// subjects page asks for likely duplicates of one subject by embedding distance.

const KEY_PATTERN = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const DEFAULT_SIMILAR = 10;

export interface ICreateSubject {
  key: string;
  description?: string;
}

const COLUMNS = sql`
  s.subject_id, s.key, s.description, s.derived_at, s.date_created, s.date_modified,
  (s.embedding IS NOT NULL) AS has_embedding,
  a.canonical_subject_id,
  (SELECT count(*)::int FROM sm.contract_proposition p WHERE p.subject_id = s.subject_id) AS proposition_count`;

export async function listSubjects(client: PoolClient, params: Record<string, string | undefined>) {
  const limit = Math.min(Number(params.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Number(params.offset ?? 0) || 0;

  if (params.similarTo !== undefined) {
    const subjectId = Number(params.similarTo);
    requirePositiveInt(subjectId, 'similarTo');
    const count = Math.min(Number(params.limit ?? DEFAULT_SIMILAR) || DEFAULT_SIMILAR, 100);
    return (await client.query(sql`
      SELECT ${COLUMNS}, 1 - (s.embedding <=> t.embedding) AS similarity
      FROM sm.proposition_subject t
      JOIN sm.proposition_subject s ON s.subject_id <> t.subject_id AND s.embedding IS NOT NULL
      LEFT JOIN sm.proposition_subject_alias a ON a.alias_subject_id = s.subject_id
      WHERE t.subject_id = ${subjectId} AND t.embedding IS NOT NULL AND a.alias_subject_id IS NULL
      ORDER BY s.embedding <=> t.embedding
      LIMIT ${count}`)).rows;
  }

  const ids = params.subjectIds !== undefined ? parseIdList(params.subjectIds) : null;
  const filters = where([
    ids && sql`s.subject_id = ANY(${ids}::int[])`,
    params.key !== undefined && sql`s.key = ${params.key}`,
    params.search && sql`(s.key ILIKE ${`%${params.search}%`} OR s.description ILIKE ${`%${params.search}%`})`,
    params.canonical === 'true' && raw('a.alias_subject_id IS NULL'),
    params.dirty === 'true' && raw('(s.derived_at IS NULL OR s.date_modified > s.derived_at)'),
  ]);
  return (await client.query(sql`
    SELECT ${COLUMNS}
    FROM sm.proposition_subject s
    LEFT JOIN sm.proposition_subject_alias a ON a.alias_subject_id = s.subject_id
    ${filters}
    ORDER BY s.key
    LIMIT ${limit} OFFSET ${offset}`)).rows;
}

function parseSubject(item: unknown): ICreateSubject {
  const s = item as ICreateSubject;
  const key = requireString(s?.key, 'key');
  if (!KEY_PATTERN.test(key)) {
    throw new PropositionError(400, `key ${JSON.stringify(key)} must be lowercase letters, digits and : . _ / -`);
  }
  if (s.description !== undefined && typeof s.description !== 'string') {
    throw new PropositionError(400, 'description must be a string');
  }
  return { key, description: s.description };
}

/** Creates subjects by key, or returns the existing ones; a non-empty description replaces the stored one. */
export async function upsertSubjects(client: PoolClient, items: ICreateSubject[]) {
  const rows = [];
  for (const item of items) {
    rows.push((await client.query(sql`
      INSERT INTO sm.proposition_subject (key, description) VALUES (${item.key}, ${item.description ?? ''})
      ON CONFLICT (key) DO UPDATE SET description = CASE
        WHEN EXCLUDED.description = '' THEN sm.proposition_subject.description ELSE EXCLUDED.description END
      RETURNING subject_id, key, description, derived_at, date_created, date_modified`)).rows[0]);
  }
  return rows;
}

export const handler = propositionHandler('Proposition subject', {
  GET: (client, event) => listSubjects(client, event.queryStringParameters ?? {}),
  POST: async (client, event) => {
    const body = parseBody(event);
    const items = (Array.isArray(body) ? body : [body]).map(parseSubject);
    if (items.length === 0) throw new PropositionError(400, 'Expected at least one subject');
    const rows = await upsertSubjects(client, items);
    return Array.isArray(body) ? rows : rows[0];
  },
});
