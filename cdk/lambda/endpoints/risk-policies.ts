import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';

interface ICreateRiskPolicy {
  policyType: string;
  scope: number;
  strategyId?: number;
  listingId?: number;
  parameters: Record<string, unknown>;
  enabled?: boolean;
}

interface IUpdateRiskPolicy {
  parameters?: Record<string, unknown>;
  enabled?: boolean;
}

class RiskPolicyHandler extends ResourceHandler {
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM risk.policy WHERE 1=1';
    if (params?.policyId) query += ` AND policy_id=${params.policyId}`;
    if (params?.scope != null) query += ` AND scope=${params.scope}`;
    if (params?.strategyId) query += ` AND strategy_id=${params.strategyId}`;
    if (params?.listingId) query += ` AND listing_id=${params.listingId}`;
    if (params?.enabled != null) query += ` AND enabled=${params.enabled}`;
    return query;
  }

  generateInsertQuery(body: string): string {
    const p = JSON.parse(body) as ICreateRiskPolicy;
    const strategyId = p.strategyId != null ? p.strategyId : 'null';
    const listingId = p.listingId != null ? p.listingId : 'null';
    const enabled = p.enabled !== false;
    return `
      INSERT INTO risk.policy (policy_type, scope, strategy_id, listing_id, parameters, enabled)
      VALUES ('${p.policyType}', ${p.scope}, ${strategyId}, ${listingId}, '${JSON.stringify(p.parameters)}', ${enabled})
      RETURNING *;
    `;
  }

  generateDeleteQuery(body: string): string {
    const p = JSON.parse(body) as { policyId: number };
    return `
      DELETE FROM risk.policy
      WHERE policy_id = ${p.policyId}
      RETURNING *;
    `;
  }

  generateModifyQuery(row: any, body: string): string {
    const p = JSON.parse(body) as IUpdateRiskPolicy;
    const updates: string[] = [];
    if (p.parameters != null) updates.push(`parameters='${JSON.stringify(p.parameters)}'`);
    if (p.enabled != null) updates.push(`enabled=${p.enabled}`);
    updates.push(`date_modified=NOW()`);
    return `
      UPDATE risk.policy SET ${updates.join(', ')}
      WHERE policy_id=${row['policy_id']}
      RETURNING *;
    `;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new RiskPolicyHandler().handleEvent(event);
};
