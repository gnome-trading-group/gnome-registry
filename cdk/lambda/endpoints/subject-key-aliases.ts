import { PoolClient } from 'pg';
import {
  canonicalSubject, MAX_ALIAS_DEPTH, PropositionError, requirePositiveInt, requireSubject, subjectTree, touchSubjects,
} from './propositions-common';
import { sql, where } from './sql';

// One entity or measure spelled two ways on a subject (`phi` and `philadelphia`): the classifier's derivation reads
// `key` as `canonical_key`. Aliases are stored on the subject's canonical subject and read across its merge tree. The
// classifier writes the ones its merge pass and key reconcile judged; a person can add or remove one. Every change marks
// the subject for a fresh derivation and its propositions as changed: derivation re-derives only what changed since its
// last pass, and an alias changes how every reading on the subject compares. A merge's aliases go with it on unmerge.

const KINDS = ['ENTITY', 'MEASURE'];
const ORIGINS = ['MERGE', 'RECONCILE', 'MANUAL'];
// Flags the classifier knows how to carry onto relationships; anything else would be stored and never read.
const FLAGS = ['PARTY_NOMINEE'];
const KEY_PATTERN = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const MAX_CHANGES = 500;

export interface ISetKeyAlias {
  kind: string;
  key: string;
  canonicalKey: string;
  flags: string[];
  origin: string;
  mergeLogId: number | null;
  reason: string | null;
}

export interface IRemoveKeyAlias {
  kind: string;
  key: string;
}

export async function listKeyAliases(client: PoolClient, subjectIds: number[]) {
  const rows = [];
  for (const subjectId of subjectIds) {
    const target = await canonicalSubject(client, subjectId);
    const tree = await subjectTree(client, target);
    rows.push(...(await client.query(sql`
      SELECT ${subjectId}::int AS requested_subject_id, ${target}::int AS canonical_subject_id, k.subject_id, k.kind,
             k.key, k.canonical_key, k.flags, k.origin, k.merge_log_id, k.reason, k.actor, k.date_created,
             k.date_modified
      FROM sm.subject_key_alias k
      WHERE k.subject_id = ANY(${tree}::int[])
      ORDER BY k.kind, k.key`)).rows);
  }
  return rows;
}

/** The most recently changed aliases across every subject, newest first, each with the subject it is read on (the
 * root of its merge tree): what the merge pass and key reconcile have been storing. `origin` keeps one origin; `since`
 * (ISO) keeps those changed at or after it. */
export async function listRecentKeyAliases(
  client: PoolClient, params: { origin?: string; since?: string; limit: number; offset: number },
) {
  const origin = params.origin === undefined ? undefined : requireOneOf(params.origin, ORIGINS, 'origin');
  if (params.since !== undefined && Number.isNaN(Date.parse(params.since))) {
    throw new PropositionError(400, 'since must be an ISO timestamp');
  }
  const filters = where([
    origin !== undefined && sql`k.origin = ${origin}`,
    params.since !== undefined && sql`k.date_modified >= ${params.since}::timestamptz::timestamp`,
  ]);
  return (await client.query(sql`
    WITH recent AS (
      SELECT * FROM sm.subject_key_alias k ${filters}
      ORDER BY k.date_modified DESC, k.subject_id, k.kind, k.key
      LIMIT ${params.limit} OFFSET ${params.offset}
    )
    SELECT r.subject_id AS requested_subject_id, root.subject_id AS canonical_subject_id, s.key AS canonical_subject_key,
           r.subject_id, r.kind, r.key, r.canonical_key, r.flags, r.origin, r.merge_log_id, r.reason, r.actor,
           r.date_created, r.date_modified
    FROM recent r
    CROSS JOIN LATERAL (
      WITH RECURSIVE chain(subject_id, depth) AS (
        SELECT r.subject_id, 0
        UNION ALL
        SELECT a.canonical_subject_id, c.depth + 1
        FROM sm.proposition_subject_alias a JOIN chain c ON a.alias_subject_id = c.subject_id
        WHERE c.depth < ${MAX_ALIAS_DEPTH}
      )
      SELECT subject_id FROM chain ORDER BY depth DESC LIMIT 1
    ) root
    JOIN sm.proposition_subject s ON s.subject_id = root.subject_id
    ORDER BY r.date_modified DESC, r.subject_id, r.kind, r.key`)).rows;
}

function requireKey(value: unknown, name: string): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new PropositionError(400, `${name} must be a key of lowercase letters, digits and : . _ / -`);
  }
  return value;
}

function requireOneOf(value: unknown, allowed: string[], name: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new PropositionError(400, `${name} must be one of ${allowed.join(', ')}`);
  }
  return value;
}

export function parseSet(item: unknown): ISetKeyAlias {
  const a = (item ?? {}) as Record<string, unknown>;
  const key = requireKey(a.key, 'key');
  const canonicalKey = requireKey(a.canonicalKey, 'canonicalKey');
  if (key === canonicalKey) throw new PropositionError(400, `${key} cannot be an alias of itself`);
  const flags = a.flags ?? [];
  if (!Array.isArray(flags)) throw new PropositionError(400, 'flags must be a list');
  const origin = requireOneOf(a.origin, ORIGINS, 'origin');
  const mergeLogId = a.mergeLogId === undefined || a.mergeLogId === null ? null : requirePositiveInt(a.mergeLogId, 'mergeLogId');
  if (origin === 'MERGE' && mergeLogId === null) throw new PropositionError(400, 'A MERGE alias names its mergeLogId');
  if (a.reason !== undefined && a.reason !== null && typeof a.reason !== 'string') {
    throw new PropositionError(400, 'reason must be a string');
  }
  return {
    kind: requireOneOf(a.kind, KINDS, 'kind'),
    key,
    canonicalKey,
    flags: [...new Set(flags.map(f => requireOneOf(f, FLAGS, 'flag')))].sort(),
    origin,
    mergeLogId,
    reason: (a.reason as string | undefined) ?? null,
  };
}

export function parseRemove(item: unknown): IRemoveKeyAlias {
  const a = (item ?? {}) as Record<string, unknown>;
  return { kind: requireOneOf(a.kind, KINDS, 'kind'), key: requireKey(a.key, 'key') };
}

/** Sets and removes a subject's key aliases in one transaction step, on its canonical subject; returns the subject's
 * aliases after the change. A chain (an alias's canonical key itself an alias) is refused: derivation reads one hop. */
export async function changeKeyAliases(
  client: PoolClient, subjectId: number, set: ISetKeyAlias[], remove: IRemoveKeyAlias[], actor: string,
) {
  if (set.length + remove.length === 0) throw new PropositionError(400, 'Expected at least one alias to set or remove');
  if (set.length + remove.length > MAX_CHANGES) throw new PropositionError(400, `At most ${MAX_CHANGES} changes at once`);
  await requireSubject(client, subjectId);
  const target = await canonicalSubject(client, subjectId);
  const tree = await subjectTree(client, target);
  for (const r of remove) {
    await client.query(sql`
      DELETE FROM sm.subject_key_alias
      WHERE subject_id = ANY(${tree}::int[]) AND kind = ${r.kind} AND key = ${r.key}`);
  }
  for (const a of set) {
    if (a.mergeLogId !== null) {
      const merge = (await client.query(sql`
        SELECT 1 FROM sm.proposition_subject_merge_log
        WHERE merge_log_id = ${a.mergeLogId} AND action = 'MERGE' AND canonical_subject_id = ANY(${tree}::int[])`)).rows[0];
      if (!merge) throw new PropositionError(400, `Merge ${a.mergeLogId} is not a merge into this subject`);
    }
    await client.query(sql`
      DELETE FROM sm.subject_key_alias
      WHERE subject_id = ANY(${tree}::int[]) AND subject_id <> ${target} AND kind = ${a.kind} AND key = ${a.key}`);
    await client.query(sql`
      INSERT INTO sm.subject_key_alias (subject_id, kind, key, canonical_key, flags, origin, merge_log_id, reason, actor)
      VALUES (${target}, ${a.kind}, ${a.key}, ${a.canonicalKey}, ${a.flags}::text[], ${a.origin}, ${a.mergeLogId},
              ${a.reason}, ${actor})
      ON CONFLICT (subject_id, kind, key) DO UPDATE SET
        canonical_key = EXCLUDED.canonical_key, flags = EXCLUDED.flags, origin = EXCLUDED.origin,
        merge_log_id = EXCLUDED.merge_log_id, reason = EXCLUDED.reason, actor = EXCLUDED.actor, date_modified = now()`);
  }
  const chained = (await client.query(sql`
    SELECT a.kind, a.key, a.canonical_key
    FROM sm.subject_key_alias a
    JOIN sm.subject_key_alias b ON b.kind = a.kind AND b.key = a.canonical_key AND b.subject_id = ANY(${tree}::int[])
    WHERE a.subject_id = ANY(${tree}::int[])
    LIMIT 1`)).rows[0];
  if (chained) {
    throw new PropositionError(409,
      `${chained.key} -> ${chained.canonical_key}, which is itself an alias; point it at the key that stands for the entity`);
  }
  await touchReadings(client, tree);
  await touchSubjects(client, [target]);
  return listKeyAliases(client, [target]);
}

async function touchReadings(client: PoolClient, subjectIds: number[]) {
  await client.query(sql`UPDATE sm.contract_proposition SET date_modified = now() WHERE subject_id = ANY(${subjectIds}::int[])`);
}

/** Removes the aliases recorded with a merge, when the merge is undone, and marks the readings they applied to as
 * changed. */
export async function removeMergeAliases(client: PoolClient, aliasSubjectId: number, canonicalSubjectId: number) {
  const removed = (await client.query(sql`
    DELETE FROM sm.subject_key_alias
    WHERE merge_log_id IN (
      SELECT merge_log_id FROM sm.proposition_subject_merge_log
      WHERE action = 'MERGE' AND alias_subject_id = ${aliasSubjectId} AND canonical_subject_id = ${canonicalSubjectId})`
  )).rowCount ?? 0;
  if (removed > 0) await touchReadings(client, await subjectTree(client, await canonicalSubject(client, canonicalSubjectId)));
  return removed;
}
