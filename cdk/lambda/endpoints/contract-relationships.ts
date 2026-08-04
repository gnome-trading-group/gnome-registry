import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateContractRelationship, IDeleteContractRelationship } from '../types';

class ContractRelationshipHandler extends ResourceHandler {
  allowedSortColumns(): string[] {
    return ['relationship_id', 'security_id_a', 'security_id_b', 'relationship_type', 'confidence', 'method', 'date_created'];
  }

  generateDeleteQuery(body: string): string {
    const rel = JSON.parse(body) as IDeleteContractRelationship;
    return `
      DELETE FROM sm.contract_relationship
      WHERE relationship_id = ${rel.relationshipId}
      RETURNING *;
    `;
  }

  generateInsertQuery(body: string): string {
    const rel = JSON.parse(body) as ICreateContractRelationship;
    return `
      INSERT INTO sm.contract_relationship
        (security_id_a, security_id_b, relationship_type, confidence, method)
      VALUES
        (${rel.securityIdA}, ${rel.securityIdB}, '${rel.relationshipType}', ${rel.confidence}, '${rel.method}')
      ON CONFLICT (security_id_a, security_id_b) DO UPDATE SET
        relationship_type = EXCLUDED.relationship_type,
        confidence = EXCLUDED.confidence,
        method = EXCLUDED.method
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    const denormalize = params?.denormalize === 'true';
    const filterUnresolved = params?.eventResolved === 'false';
    const p = denormalize ? 'cr.' : '';

    let filters = '';
    if (params?.relationshipId) {
      filters += ` AND ${p}relationship_id = ${params.relationshipId}`;
    }
    if (params?.securityId) {
      filters += ` AND (${p}security_id_a = ${params.securityId} OR ${p}security_id_b = ${params.securityId})`;
    }
    if (params?.method) {
      filters += ` AND ${p}method = '${params.method}'`;
    }
    if (params?.relationshipType) {
      filters += ` AND ${p}relationship_type = '${params.relationshipType}'`;
    }

    if (filterUnresolved) {
      filters += ` AND (${p}security_id_a IN (SELECT security_id FROM unresolved_securities) OR ${p}security_id_b IN (SELECT security_id FROM unresolved_securities))`;
    }

    const cte = filterUnresolved
      ? `WITH unresolved_securities AS (SELECT DISTINCT ec.security_id FROM sm.event_contract ec JOIN sm.event e ON ec.event_id = e.event_id WHERE e.resolved = false) `
      : '';

    let query = denormalize
      ? `SELECT cr.*, sa.symbol AS symbol_a, sb.symbol AS symbol_b
         FROM sm.contract_relationship cr
         JOIN sm.security sa ON cr.security_id_a = sa.security_id
         JOIN sm.security sb ON cr.security_id_b = sb.security_id
         WHERE 1=1`
      : 'SELECT * FROM sm.contract_relationship WHERE 1=1';
    query += filters;
    return `${cte}${query}`;
  }

  generateModifyQuery(row: any, body: string): string {
    const rel = JSON.parse(body) as Partial<ICreateContractRelationship>;
    const updates: string[] = [];
    if (rel.relationshipType !== undefined) updates.push(`relationship_type = '${rel.relationshipType}'`);
    if (rel.confidence !== undefined) updates.push(`confidence = ${rel.confidence}`);
    if (rel.method !== undefined) updates.push(`method = '${rel.method}'`);
    return `UPDATE sm.contract_relationship SET ${updates.join(', ')} WHERE relationship_id = ${row['relationship_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ContractRelationshipHandler().handleEvent(event);
};
