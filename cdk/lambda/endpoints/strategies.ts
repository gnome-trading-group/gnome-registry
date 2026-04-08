import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';

interface ICreateStrategy {
  strategyId: number;
  name: string;
  description?: string;
  status?: number;
  parameters?: Record<string, unknown>;
}

interface IUpdateStrategy {
  name?: string;
  description?: string;
  status?: number;
  parameters?: Record<string, unknown>;
}

class StrategyHandler extends ResourceHandler {
  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM strategy.strategy WHERE 1=1';
    if (params?.strategyId) {
      query += ` AND strategy_id=${params.strategyId}`;
    }
    if (params?.name) {
      query += ` AND name='${params.name}'`;
    }
    if (params?.status != null) {
      query += ` AND status=${params.status}`;
    }
    return query;
  }

  generateInsertQuery(body: string): string {
    const s = JSON.parse(body) as ICreateStrategy;
    const description = s.description != null ? `'${s.description}'` : 'null';
    const status = s.status != null ? s.status : 0;
    const parameters = s.parameters != null ? `'${JSON.stringify(s.parameters)}'` : 'null';
    return `
      INSERT INTO strategy.strategy (strategy_id, name, description, status, parameters)
      VALUES (${s.strategyId}, '${s.name}', ${description}, ${status}, ${parameters})
      RETURNING *;
    `;
  }

  generateDeleteQuery(body: string): string {
    const s = JSON.parse(body) as { strategyId: number };
    return `
      DELETE FROM strategy.strategy
      WHERE strategy_id = ${s.strategyId}
      RETURNING *;
    `;
  }

  generateModifyQuery(row: any, body: string): string {
    const s = JSON.parse(body) as IUpdateStrategy;
    const updates: string[] = [];
    if (s.name != null) updates.push(`name='${s.name}'`);
    if (s.description != null) updates.push(`description='${s.description}'`);
    if (s.status != null) updates.push(`status=${s.status}`);
    if (s.parameters != null) updates.push(`parameters='${JSON.stringify(s.parameters)}'`);
    updates.push(`date_modified=NOW()`);
    return `
      UPDATE strategy.strategy SET ${updates.join(', ')}
      WHERE strategy_id=${row['strategy_id']}
      RETURNING *;
    `;
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new StrategyHandler().handleEvent(event);
};
