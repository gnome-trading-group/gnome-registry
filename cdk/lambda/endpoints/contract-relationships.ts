import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { parseIdList, ResourceHandler, ValidationError } from './base';
import { join, raw, set, Sql, sql, where } from './sql';
import { ICreateContractRelationship, IDeleteContractRelationship } from '../types';

const BINARY = 7;

// The other security of a BINARY event with exactly two securities: the complement consumers reverse rows through.
function complementOf(column: string): Sql {
  return sql`(
    SELECT o.security_id FROM sm.event_contract ec
    JOIN sm.event_contract o ON o.event_id = ec.event_id AND o.security_id <> ec.security_id
    JOIN sm.security s ON s.security_id = ec.security_id AND s.contract_type = ${BINARY}
    JOIN sm.security so ON so.security_id = o.security_id AND so.contract_type = ${BINARY}
    WHERE ec.security_id = ${raw(column)}
      AND (SELECT count(*) FROM sm.event_contract n WHERE n.event_id = ec.event_id) = 2
    LIMIT 1)`;
}

// Every row in the connected sets of some securities, reached through rows and complements in either direction, with
// each side's complement. Only the fewest rows that rebuild the relation are stored, so a consumer needs the rows a
// route can run through, not just the ones touching its own securities. Derivation units keep the sets small.
function connectedQuery(securityIds: number[]): Sql {
  return sql`
    WITH RECURSIVE reach(security_id) AS (
      SELECT unnest(${securityIds}::int[])
      UNION
      SELECT n.security_id FROM reach CROSS JOIN LATERAL (
        SELECT r.security_id_b AS security_id FROM sm.contract_relationship r WHERE r.security_id_a = reach.security_id
        UNION ALL
        SELECT r.security_id_a FROM sm.contract_relationship r WHERE r.security_id_b = reach.security_id
        UNION ALL
        SELECT ${complementOf('reach.security_id')} AS security_id
      ) n
      WHERE n.security_id IS NOT NULL
    )
    SELECT cr.*, ${complementOf('cr.security_id_a')} AS complement_a, ${complementOf('cr.security_id_b')} AS complement_b
    FROM sm.contract_relationship cr
    WHERE cr.security_id_a IN (SELECT security_id FROM reach)
    ORDER BY cr.relationship_id`;
}

export class ContractRelationshipHandler extends ResourceHandler {
  allowedSortColumns(): string[] {
    return ['relationship_id', 'security_id_a', 'security_id_b', 'relationship_type', 'method', 'date_created'];
  }

  generateDeleteQuery(body: string): Sql {
    const rel = JSON.parse(body) as IDeleteContractRelationship;
    return sql`DELETE FROM sm.contract_relationship WHERE relationship_id = ${rel.relationshipId} RETURNING *`;
  }

  generateInsertQuery(body: string): Sql {
    const rel = JSON.parse(body) as ICreateContractRelationship;
    const flags = rel.flags ?? [];
    const evidence = rel.evidence === undefined ? null : JSON.stringify(rel.evidence);
    const version = rel.derivationVersion ?? null;
    // A manual row is a person's call and only another manual write replaces it. The conflict still updates (to the
    // same values) rather than skipping, so the insert returns a row and one kept pair doesn't fail a bulk create.
    const keep = raw("contract_relationship.method = 'manual' AND EXCLUDED.method <> 'manual'");
    const keepOr = (column: string) =>
      sql`CASE WHEN ${keep} THEN contract_relationship.${raw(column)} ELSE EXCLUDED.${raw(column)} END`;
    return sql`
      INSERT INTO sm.contract_relationship
        (security_id_a, security_id_b, relationship_type, method, flags, evidence, derivation_version)
      VALUES
        (${rel.securityIdA}, ${rel.securityIdB}, ${rel.relationshipType}, ${rel.method}, ${flags}::text[],
         ${evidence}::jsonb, ${version})
      ON CONFLICT (security_id_a, security_id_b) DO UPDATE SET
        relationship_type = ${keepOr('relationship_type')},
        method = ${keepOr('method')},
        flags = ${keepOr('flags')},
        evidence = ${keepOr('evidence')},
        derivation_version = ${keepOr('derivation_version')}
      RETURNING *`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    if (params?.connected === 'true') {
      const ids = parseIdList(params.securityIds ?? '');
      if (ids.length === 0) throw new ValidationError('connected needs securityIds');
      return connectedQuery(ids);
    }
    const denormalize = params?.denormalize === 'true';
    const filterUnresolved = params?.eventResolved === 'false';
    const column = (name: string) => raw(denormalize ? `cr.${name}` : name);

    const filters = where([
      params?.relationshipId && sql`${column('relationship_id')} = ${params.relationshipId}`,
      params?.securityId
        && sql`(${column('security_id_a')} = ${params.securityId} OR ${column('security_id_b')} = ${params.securityId})`,
      params?.subjectId && sql`(${column('security_id_a')} IN (SELECT security_id FROM subject_securities)
        OR ${column('security_id_b')} IN (SELECT security_id FROM subject_securities))`,
      params?.method && sql`${column('method')} = ${params.method}`,
      params?.relationshipType && sql`${column('relationship_type')} = ${params.relationshipType}`,
      filterUnresolved && sql`(${column('security_id_a')} IN (SELECT security_id FROM unresolved_securities) OR ${column('security_id_b')} IN (SELECT security_id FROM unresolved_securities))`,
    ]);

    const ctes: Sql[] = [];
    if (params?.subjectId) {
      ctes.push(sql`subject_securities AS (SELECT security_id FROM sm.contract_proposition WHERE subject_id = ${params.subjectId})`);
    }
    if (filterUnresolved) {
      ctes.push(sql`unresolved_securities AS (SELECT DISTINCT ec.security_id FROM sm.event_contract ec JOIN sm.event e ON ec.event_id = e.event_id WHERE e.resolved = false)`);
    }

    if (params?.eventId) {
      ctes.push(sql`event_securities AS (SELECT security_id FROM sm.event_contract WHERE event_id = ${params.eventId})`);
      const cteClause = sql`WITH ${join(ctes, ', ')} `;
      const branch = (joinCol: string) => denormalize
        ? sql`SELECT cr.*, sa.symbol AS symbol_a, sb.symbol AS symbol_b
           FROM sm.contract_relationship cr
           JOIN sm.security sa ON cr.security_id_a = sa.security_id
           JOIN sm.security sb ON cr.security_id_b = sb.security_id
           JOIN event_securities es ON ${raw(joinCol)} = es.security_id${filters}`
        : sql`SELECT cr.*
           FROM sm.contract_relationship cr
           JOIN event_securities es ON ${raw(joinCol)} = es.security_id${filters}`;
      return sql`${cteClause}${branch('cr.security_id_a')} UNION ${branch('cr.security_id_b')}`;
    }

    const cteClause = ctes.length > 0 ? sql`WITH ${join(ctes, ', ')} ` : raw('');
    const from = denormalize
      ? sql`SELECT cr.*, sa.symbol AS symbol_a, sb.symbol AS symbol_b
         FROM sm.contract_relationship cr
         JOIN sm.security sa ON cr.security_id_a = sa.security_id
         JOIN sm.security sb ON cr.security_id_b = sb.security_id`
      : sql`SELECT * FROM sm.contract_relationship`;
    return sql`${cteClause}${from}${filters}`;
  }

  generateModifyQuery(row: any, body: string): Sql {
    const rel = JSON.parse(body) as Partial<ICreateContractRelationship>;
    if (rel.relationshipType === undefined && rel.method === undefined && rel.flags === undefined) {
      throw new ValidationError('Nothing to modify: give relationshipType, method or flags');
    }
    return sql`UPDATE sm.contract_relationship SET ${set({
      relationship_type: rel.relationshipType,
      method: rel.method,
      flags: rel.flags === undefined ? undefined : sql`${rel.flags}::text[]`,
    })} WHERE relationship_id = ${row['relationship_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ContractRelationshipHandler().handleEvent(event);
};
