import { PoolClient } from 'pg';
import { getActor } from './base';
import { mergeSubjects } from './proposition-subject-merges';
import {
  parseBody,
  PropositionError,
  propositionHandler,
  requirePositiveInt,
  requireString,
} from './propositions-common';
import { sql, where } from './sql';

// The review queue of subject merges the classifier held back (see migration 058). The classifier writes it; a person
// merges or dismisses each pair from the controller. Re-sending a pair refreshes it while it is pending and leaves a
// decided one alone, so the classifier can send everything it held each pass.

const HOLDS = ['PRICE', 'COLLISION'];
const STATUSES = ['PENDING', 'MERGED', 'DISMISSED'];
const DECISIONS = ['MERGED', 'DISMISSED'];
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

export interface ICandidate {
  aliasSubjectId: number;
  canonicalSubjectId: number;
  hold: string;
  reason: string;
  gain: number;
  details?: Record<string, unknown>;
}

const COLUMNS = sql`
  c.candidate_id, c.alias_subject_id, sa.key AS alias_key, c.canonical_subject_id, sc.key AS canonical_key, c.hold,
  c.reason, c.gain, c.details, c.status, c.decided_by, c.decided_at, c.date_created, c.date_modified`;

export async function listCandidates(client: PoolClient, params: Record<string, string | undefined>) {
  const status = params.status ?? 'PENDING';
  if (status !== 'ALL' && !STATUSES.includes(status)) {
    throw new PropositionError(400, `status must be one of ${[...STATUSES, 'ALL'].join(', ')}`);
  }
  const limit = Math.min(Number(params.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Number(params.offset ?? 0) || 0;
  return (await client.query(sql`
    SELECT ${COLUMNS}
    FROM sm.proposition_subject_merge_candidate c
    JOIN sm.proposition_subject sa ON sa.subject_id = c.alias_subject_id
    JOIN sm.proposition_subject sc ON sc.subject_id = c.canonical_subject_id
    ${where([status !== 'ALL' && sql`c.status = ${status}`])}
    ORDER BY c.gain DESC, c.candidate_id
    LIMIT ${limit} OFFSET ${offset}`)).rows;
}

function parseCandidate(item: unknown): ICandidate {
  const c = (item ?? {}) as Record<string, unknown>;
  const hold = requireString(c.hold, 'hold');
  if (!HOLDS.includes(hold)) throw new PropositionError(400, `hold must be one of ${HOLDS.join(', ')}`);
  const gain = c.gain;
  if (typeof gain !== 'number' || !Number.isInteger(gain) || gain < 0) {
    throw new PropositionError(400, 'gain must be a non-negative integer');
  }
  const details = c.details ?? {};
  if (typeof details !== 'object' || Array.isArray(details)) throw new PropositionError(400, 'details must be an object');
  const candidate = {
    aliasSubjectId: requirePositiveInt(c.aliasSubjectId, 'aliasSubjectId'),
    canonicalSubjectId: requirePositiveInt(c.canonicalSubjectId, 'canonicalSubjectId'),
    hold, reason: requireString(c.reason, 'reason'), gain, details: details as Record<string, unknown>,
  };
  if (candidate.aliasSubjectId === candidate.canonicalSubjectId) {
    throw new PropositionError(400, 'A subject cannot be merged into itself');
  }
  return candidate;
}

export async function upsertCandidates(client: PoolClient, items: ICandidate[]) {
  const out = [];
  for (const c of items) {
    const row = (await client.query(sql`
      INSERT INTO sm.proposition_subject_merge_candidate
        (alias_subject_id, canonical_subject_id, hold, reason, gain, details)
      VALUES (${c.aliasSubjectId}, ${c.canonicalSubjectId}, ${c.hold}, ${c.reason}, ${c.gain}, ${JSON.stringify(c.details ?? {})})
      ON CONFLICT (LEAST(alias_subject_id, canonical_subject_id), GREATEST(alias_subject_id, canonical_subject_id))
      DO UPDATE SET alias_subject_id = EXCLUDED.alias_subject_id, canonical_subject_id = EXCLUDED.canonical_subject_id,
        hold = EXCLUDED.hold, reason = EXCLUDED.reason, gain = EXCLUDED.gain, details = EXCLUDED.details,
        date_modified = now()
      WHERE sm.proposition_subject_merge_candidate.status = 'PENDING'
      RETURNING *`)).rows[0];
    if (row) {
      out.push(row);
    } else {
      out.push((await client.query(sql`
        SELECT * FROM sm.proposition_subject_merge_candidate
        WHERE LEAST(alias_subject_id, canonical_subject_id) = ${Math.min(c.aliasSubjectId, c.canonicalSubjectId)}
          AND GREATEST(alias_subject_id, canonical_subject_id) = ${Math.max(c.aliasSubjectId, c.canonicalSubjectId)}`)).rows[0]);
    }
  }
  return out;
}

/** A person's decision on a pending pair. Merging makes the merge as them first, so a merge the registry refuses
 * (already merged elsewhere, a cycle) leaves the pair pending. */
export async function decideCandidate(client: PoolClient, candidateId: number, decision: string, actor: string) {
  if (!DECISIONS.includes(decision)) throw new PropositionError(400, `status must be one of ${DECISIONS.join(', ')}`);
  const candidate = (await client.query(sql`
    SELECT * FROM sm.proposition_subject_merge_candidate WHERE candidate_id = ${candidateId}`)).rows[0];
  if (!candidate) throw new PropositionError(404, `Unknown merge candidate ${candidateId}`);
  if (candidate.status !== 'PENDING') {
    throw new PropositionError(409, `Merge candidate ${candidateId} was already ${candidate.status.toLowerCase()}`);
  }
  if (decision === 'MERGED') {
    await mergeSubjects(client, candidate.alias_subject_id, candidate.canonical_subject_id, actor);
  }
  return (await client.query(sql`
    UPDATE sm.proposition_subject_merge_candidate
    SET status = ${decision}, decided_by = ${actor}, decided_at = now(), date_modified = now()
    WHERE candidate_id = ${candidateId} RETURNING *`)).rows[0];
}

export const handler = propositionHandler('Proposition subject merge candidate', {
  GET: (client, event) => listCandidates(client, event.queryStringParameters ?? {}),
  POST: (client, event) => {
    const body = parseBody(event);
    if (!Array.isArray(body)) throw new PropositionError(400, 'Body must be an array of merge candidates');
    return upsertCandidates(client, body.map(parseCandidate));
  },
  PATCH: (client, event) => {
    const body = parseBody(event) as { candidateId?: unknown; status?: unknown };
    return decideCandidate(client, requirePositiveInt(body.candidateId, 'candidateId'),
      requireString(body.status, 'status'), getActor(event));
  },
});
