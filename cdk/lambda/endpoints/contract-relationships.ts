import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';
import { ICreateContractRelationship, IDeleteContractRelationship } from '../types';

class ContractRelationshipHandler extends ResourceHandler {
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
        method = EXCLUDED.method,
        reviewed = false,
        reviewed_at = NULL
      RETURNING *;
    `;
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM sm.contract_relationship WHERE 1=1';
    if (params?.relationshipId) {
      query += ` AND relationship_id = ${params.relationshipId}`;
    }
    if (params?.securityId) {
      query += ` AND (security_id_a = ${params.securityId} OR security_id_b = ${params.securityId})`;
    }
    if (params?.reviewed !== undefined) {
      query += ` AND reviewed = ${params.reviewed === 'true'}`;
    }
    if (params?.method) {
      query += ` AND method = '${params.method}'`;
    }
    if (params?.relationshipType) {
      query += ` AND relationship_type = '${params.relationshipType}'`;
    }
    query += ' ORDER BY confidence DESC, date_created DESC';
    return query;
  }

  generateModifyQuery(row: any, body: string): string {
    const rel = JSON.parse(body) as Partial<ICreateContractRelationship> & { reviewed?: boolean; reviewedAt?: string };
    const updates: string[] = [];
    if (rel.relationshipType !== undefined) updates.push(`relationship_type = '${rel.relationshipType}'`);
    if (rel.confidence !== undefined) updates.push(`confidence = ${rel.confidence}`);
    if (rel.method !== undefined) updates.push(`method = '${rel.method}'`);
    if (rel.reviewed !== undefined) {
      updates.push(`reviewed = ${rel.reviewed}`);
      if (rel.reviewed) {
        updates.push(`reviewed_at = NOW()`);
      }
    }
    return `UPDATE sm.contract_relationship SET ${updates.join(', ')} WHERE relationship_id = ${row['relationship_id']} RETURNING *`;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new ContractRelationshipHandler().handleEvent(event);
};
