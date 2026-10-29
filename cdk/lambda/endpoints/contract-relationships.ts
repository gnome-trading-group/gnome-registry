import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, ValidationError } from './base';
import { join, raw, set, Sql, sql, where } from './sql';
import { ICreateContractRelationship, IDeleteContractRelationship } from '../types';

class ContractRelationshipHandler extends ResourceHandler {
  allowedSortColumns(): string[] {
    return ['relationship_id', 'security_id_a', 'security_id_b', 'relationship_type', 'confidence', 'method', 'date_created'];
  }

  generateDeleteQuery(body: string): Sql {
    const rel = JSON.parse(body) as IDeleteContractRelationship;
    return sql`DELETE FROM sm.contract_relationship WHERE relationship_id = ${rel.relationshipId} RETURNING *`;
  }

  generateInsertQuery(body: string): Sql {
    const rel = JSON.parse(body) as ICreateContractRelationship;
    return sql`
      INSERT INTO sm.contract_relationship
        (security_id_a, security_id_b, relationship_type, confidence, method)
      VALUES
        (${rel.securityIdA}, ${rel.securityIdB}, ${rel.relationshipType}, ${rel.confidence}, ${rel.method})
      ON CONFLICT (security_id_a, security_id_b) DO UPDATE SET
        relationship_type = EXCLUDED.relationship_type,
        confidence = EXCLUDED.confidence,
        method = EXCLUDED.method
      RETURNING *`;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): Sql {
    const denormalize = params?.denormalize === 'true';
    const filterUnresolved = params?.eventResolved === 'false';
    const column = (name: string) => raw(denormalize ? `cr.${name}` : name);

    const filters = where([
      params?.relationshipId && sql`${column('relationship_id')} = ${params.relationshipId}`,
      params?.securityId
        && sql`(${column('security_id_a')} = ${params.securityId} OR ${column('security_id_b')} = ${params.securityId})`,
      params?.method && sql`${column('method')} = ${params.method}`,
      params?.relationshipType && sql`${column('relationship_type')} = ${params.relationshipType}`,
      filterUnresolved && sql`(${column('security_id_a')} IN (SELECT security_id FROM unresolved_securities) OR ${column('security_id_b')} IN (SELECT security_id FROM unresolved_securities))`,
    ]);

    const ctes: Sql[] = [];
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
    if (rel.relationshipType === undefined && rel.confidence === undefined && rel.method === undefined) {
      throw new ValidationError('Nothing to modify: give relationshipType, confidence or method');
    }
    return sql`UPDATE sm.contract_relationship SET ${set({
      relationship_type: rel.relationshipType,
      confidence: rel.confidence,
      method: rel.method,
    })} WHERE relationship_id = ${row['relationship_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ContractRelationshipHandler().handleEvent(event);
};
