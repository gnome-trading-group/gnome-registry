import { PoolClient } from 'pg';
import { getActor, withTransaction } from './base';
import {
  canonicalSubject,
  parseBody,
  PropositionError,
  propositionHandler,
  requirePositiveInt,
  requireSubject,
  subjectTree,
  touchSubjects,
} from './propositions-common';
import { sql, where } from './sql';

// Merging duplicate subjects, a person's call from the controller. A merge records an alias and moves every
// proposition that resolves through the merged subject; an unmerge deletes the alias and moves them back (each
// proposition remembers the subject extraction chose). Both mark the subjects involved for a fresh derivation, which
// the classifier picks up on its own.

// Merges and unmerges change chains other merges read, so they run one at a time.
const MERGE_LOCK = 1797_0001;

export async function listMerges(client: PoolClient, params: Record<string, string | undefined>) {
  const subjectId = params.subjectId !== undefined ? Number(params.subjectId) : null;
  return (await client.query(sql`
    SELECT a.alias_subject_id, sa.key AS alias_key, a.canonical_subject_id, sc.key AS canonical_key, a.actor, a.date_created
    FROM sm.proposition_subject_alias a
    JOIN sm.proposition_subject sa ON sa.subject_id = a.alias_subject_id
    JOIN sm.proposition_subject sc ON sc.subject_id = a.canonical_subject_id
    ${where([subjectId !== null && sql`(a.alias_subject_id = ${subjectId} OR a.canonical_subject_id = ${subjectId})`])}
    ORDER BY a.date_created DESC`)).rows;
}

export async function mergeSubjects(client: PoolClient, fromSubjectId: number, intoSubjectId: number, actor: string) {
  if (fromSubjectId === intoSubjectId) throw new PropositionError(400, 'A subject cannot be merged into itself');
  return withTransaction(client, async () => {
    await client.query(sql`SELECT pg_advisory_xact_lock(${MERGE_LOCK})`);
    const from = await requireSubject(client, fromSubjectId);
    await requireSubject(client, intoSubjectId);
    const existing = (await client.query(sql`
      SELECT canonical_subject_id FROM sm.proposition_subject_alias WHERE alias_subject_id = ${fromSubjectId}`)).rows[0];
    if (existing) {
      throw new PropositionError(409, `${from.key} is already merged into subject ${existing.canonical_subject_id}; unmerge it first`);
    }
    const target = await canonicalSubject(client, intoSubjectId);
    const tree = await subjectTree(client, fromSubjectId);
    if (tree.includes(target)) {
      throw new PropositionError(409, `Subject ${intoSubjectId} is already merged into ${from.key}`);
    }
    const alias = (await client.query(sql`
      INSERT INTO sm.proposition_subject_alias (alias_subject_id, canonical_subject_id, actor)
      VALUES (${fromSubjectId}, ${target}, ${actor}) RETURNING *`)).rows[0];
    const moved = (await client.query(sql`
      UPDATE sm.contract_proposition SET subject_id = ${target}, date_modified = now()
      WHERE extracted_subject_id = ANY(${tree}::int[])`)).rowCount;
    await touchSubjects(client, [fromSubjectId, target]);
    return { ...alias, propositions_moved: moved };
  }, { actor, reason: 'proposition subject merged' });
}

export async function unmergeSubject(client: PoolClient, subjectId: number, actor: string) {
  return withTransaction(client, async () => {
    await client.query(sql`SELECT pg_advisory_xact_lock(${MERGE_LOCK})`);
    const subject = await requireSubject(client, subjectId);
    const alias = (await client.query(sql`
      DELETE FROM sm.proposition_subject_alias WHERE alias_subject_id = ${subjectId} RETURNING *`)).rows[0];
    if (!alias) throw new PropositionError(404, `${subject.key} is not merged into another subject`);
    const formerTarget = await canonicalSubject(client, alias.canonical_subject_id);
    const tree = await subjectTree(client, subjectId);
    const moved = (await client.query(sql`
      UPDATE sm.contract_proposition SET subject_id = ${subjectId}, date_modified = now()
      WHERE extracted_subject_id = ANY(${tree}::int[])`)).rowCount;
    await touchSubjects(client, [subjectId, formerTarget]);
    return { ...alias, unmerged_by: actor, propositions_moved: moved };
  }, { actor, reason: 'proposition subject unmerged' });
}

export const handler = propositionHandler('Proposition subject merge', {
  GET: (client, event) => listMerges(client, event.queryStringParameters ?? {}),
  POST: (client, event) => {
    const body = parseBody(event) as { fromSubjectId?: unknown; intoSubjectId?: unknown };
    return mergeSubjects(client, requirePositiveInt(body.fromSubjectId, 'fromSubjectId'),
      requirePositiveInt(body.intoSubjectId, 'intoSubjectId'), getActor(event));
  },
  DELETE: (client, event) => {
    const body = parseBody(event) as { subjectId?: unknown };
    return unmergeSubject(client, requirePositiveInt(body.subjectId, 'subjectId'), getActor(event));
  },
});
