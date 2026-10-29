import { PoolClient } from 'pg';
import { withTransaction } from './base';
import {
  parseBody,
  PropositionError,
  propositionHandler,
  requirePositiveInt,
  requireString,
  requireStringArray,
} from './propositions-common';
import { sql } from './sql';

// Replaces the derived relationships of one subject's securities with the set the classifier just derived, in one
// transaction: rows it no longer derives are deleted, changed rows updated, new rows inserted. Manual rows are never
// touched, and a derived row on a pair a person already related is skipped. Setting the subject's derived_at ends its
// "due a derivation" state, unless it changed after the classifier read it (derivedAt is when it read it).

const TYPES = ['EQUIVALENT', 'IMPLIES'];

export interface IReconcileRelationship {
  securityIdA: number;
  securityIdB: number;
  relationshipType: string;
  flags?: string[];
  evidence?: unknown;
}

export interface IReconcile {
  subjectId?: number;
  securityIds: number[];
  relationships: IReconcileRelationship[];
  method: string;
  derivationVersion: string;
  derivedAt?: string;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export function parseReconcile(body: unknown): IReconcile {
  const r = body as IReconcile;
  if (r?.subjectId !== undefined) requirePositiveInt(r.subjectId, 'subjectId');
  if (!Array.isArray(r.securityIds)) throw new PropositionError(400, 'securityIds must be an array');
  r.securityIds.forEach((id) => requirePositiveInt(id, 'securityIds[]'));
  if (!Array.isArray(r.relationships)) throw new PropositionError(400, 'relationships must be an array');
  if (requireString(r.method, 'method') === 'manual') throw new PropositionError(400, 'method manual is for people');
  requireString(r.derivationVersion, 'derivationVersion');
  if (r.derivedAt !== undefined && Number.isNaN(Date.parse(r.derivedAt))) {
    throw new PropositionError(400, 'derivedAt must be an ISO timestamp');
  }

  const securities = new Set(r.securityIds);
  const pairs = new Set<string>();
  r.relationships = r.relationships.map((rel) => {
    let a = requirePositiveInt(rel?.securityIdA, 'securityIdA');
    let b = requirePositiveInt(rel.securityIdB, 'securityIdB');
    if (!TYPES.includes(rel.relationshipType)) {
      throw new PropositionError(400, `relationshipType must be one of ${TYPES.join(', ')}`);
    }
    if (a === b) throw new PropositionError(400, `A security cannot relate to itself (${a})`);
    if (!securities.has(a) || !securities.has(b)) {
      throw new PropositionError(400, `Relationship ${a} -> ${b} names a security outside securityIds`);
    }
    if (rel.relationshipType === 'EQUIVALENT' && a > b) [a, b] = [b, a];
    if (pairs.has(pairKey(a, b))) throw new PropositionError(400, `Securities ${a} and ${b} are related more than once`);
    pairs.add(pairKey(a, b));
    return { ...rel, securityIdA: a, securityIdB: b, flags: rel.flags === undefined ? [] : requireStringArray(rel.flags, 'flags') };
  });
  return r;
}

export async function reconcileRelationships(client: PoolClient, r: IReconcile) {
  return withTransaction(client, async () => {
    if (r.subjectId !== undefined) {
      const subject = (await client.query(sql`
        SELECT subject_id FROM sm.proposition_subject WHERE subject_id = ${r.subjectId} FOR UPDATE`)).rows[0];
      if (!subject) throw new PropositionError(404, `Unknown subject ${r.subjectId}`);
    }
    const existing = r.securityIds.length === 0 ? [] : (await client.query(sql`
      SELECT relationship_id, security_id_a, security_id_b, method FROM sm.contract_relationship
      WHERE security_id_a = ANY(${r.securityIds}::int[]) OR security_id_b = ANY(${r.securityIds}::int[])
      FOR UPDATE`)).rows;

    const manualPairs = new Set(existing.filter((e) => e.method === 'manual').map((e) => pairKey(e.security_id_a, e.security_id_b)));
    const desired = r.relationships.filter((rel) => !manualPairs.has(pairKey(rel.securityIdA, rel.securityIdB)));
    const desiredKeys = new Set(desired.map((rel) => `${rel.securityIdA}>${rel.securityIdB}`));

    const stale = existing
      .filter((e) => e.method !== 'manual' && !desiredKeys.has(`${e.security_id_a}>${e.security_id_b}`))
      .map((e) => e.relationship_id);
    if (stale.length > 0) {
      await client.query(sql`DELETE FROM sm.contract_relationship WHERE relationship_id = ANY(${stale}::int[])`);
    }

    let inserted = 0;
    let updated = 0;
    for (const rel of desired) {
      const evidence = rel.evidence === undefined ? null : JSON.stringify(rel.evidence);
      const row = (await client.query(sql`
        INSERT INTO sm.contract_relationship
          (security_id_a, security_id_b, relationship_type, method, flags, evidence, derivation_version)
        VALUES (${rel.securityIdA}, ${rel.securityIdB}, ${rel.relationshipType}, ${r.method}, ${rel.flags}::text[],
                ${evidence}::jsonb, ${r.derivationVersion})
        ON CONFLICT (security_id_a, security_id_b) DO UPDATE SET
          relationship_type = EXCLUDED.relationship_type, method = EXCLUDED.method, flags = EXCLUDED.flags,
          evidence = EXCLUDED.evidence, derivation_version = EXCLUDED.derivation_version
        WHERE contract_relationship.method <> 'manual'
          AND (contract_relationship.relationship_type, contract_relationship.method, contract_relationship.flags,
               contract_relationship.evidence, contract_relationship.derivation_version)
            IS DISTINCT FROM (EXCLUDED.relationship_type, EXCLUDED.method, EXCLUDED.flags, EXCLUDED.evidence,
                              EXCLUDED.derivation_version)
        RETURNING (xmax = 0) AS inserted`)).rows[0];
      if (row?.inserted) inserted++;
      else if (row) updated++;
    }

    if (r.subjectId !== undefined) {
      const derivedAt = r.derivedAt ?? new Date().toISOString();
      await client.query(sql`
        UPDATE sm.proposition_subject SET derived_at = ${derivedAt}::timestamptz::timestamp
        WHERE subject_id = ${r.subjectId}`);
    }
    return {
      inserted, updated, deleted: stale.length,
      unchanged: desired.length - inserted - updated,
      kept_manual: r.relationships.length - desired.length,
    };
  });
}

export const handler = propositionHandler('Relationship reconcile', {
  POST: (client, event) => reconcileRelationships(client, parseReconcile(parseBody(event))),
});
