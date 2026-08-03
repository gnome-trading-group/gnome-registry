import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';

interface ISession {
  sessionId: string;
  strategyId: number;
  status: string;
  mode: string;
  config: Record<string, string>;
  researchCommit?: string;
  taskArn?: string;
  taskDefinitionArn?: string;
}

interface IUpdateSession {
  status?: string;
  taskArn?: string;
  failureReason?: string;
  stoppedAt?: string;
}

class StrategySessionHandler extends ResourceHandler {
  getPrimaryKey(): string {
    return 'session_id';
  }

  getCamelPrimaryKey(): string {
    return 'sessionId';
  }

  generateSelectQuery(params: APIGatewayProxyEventQueryStringParameters | null): string {
    let query = 'SELECT * FROM strategy.session WHERE 1=1';
    if (params?.sessionId) {
      query += ` AND session_id='${params.sessionId}'`;
    }
    if (params?.strategyId) {
      query += ` AND strategy_id=${params.strategyId}`;
    }
    if (params?.status) {
      query += ` AND status='${params.status}'`;
    }
    return query;
  }

  generateInsertQuery(_body: string): string {
    throw new Error('Use createOne override');
  }

  generateModifyQuery(row: any, body: string): string {
    const s = JSON.parse(body) as IUpdateSession;
    const updates: string[] = [];
    if (s.status != null) updates.push(`status='${s.status}'`);
    if (s.taskArn != null) updates.push(`task_arn='${s.taskArn}'`);
    if (s.failureReason != null) updates.push(`failure_reason='${s.failureReason}'`);
    if (s.stoppedAt != null) updates.push(`stopped_at='${s.stoppedAt}'`);
    updates.push(`date_modified=NOW()`);
    return `
      UPDATE strategy.session SET ${updates.join(', ')}
      WHERE session_id='${row['session_id']}'
      RETURNING *;
    `;
  }

  allowedSortColumns(): string[] {
    return ['started_at', 'date_created', 'date_modified', 'status'];
  }

  async createOne(body: string | null) {
    if (!body) return this.createResponse(400, { message: 'Missing body' });

    const s = JSON.parse(body) as ISession;
    if (!s.sessionId || !s.strategyId || !s.status || !s.mode || !s.config) {
      return this.createResponse(400, { message: 'Missing required fields: sessionId, strategyId, status, mode, config' });
    }

    const researchCommit = s.researchCommit != null ? `'${s.researchCommit}'` : 'null';
    const taskArn = s.taskArn != null ? `'${s.taskArn}'` : 'null';
    const taskDefinitionArn = s.taskDefinitionArn != null ? `'${s.taskDefinitionArn}'` : 'null';

    const result = await this.client.query(`
      INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, research_commit, task_arn, task_definition_arn)
      VALUES ('${s.sessionId}', ${s.strategyId}, '${s.status}', '${s.mode}', '${JSON.stringify(s.config)}', ${researchCommit}, ${taskArn}, ${taskDefinitionArn})
      RETURNING *;
    `);

    if (result.rowCount !== 1) {
      return this.createResponse(500, { message: `Insert returned ${result.rowCount} rows`, body });
    }

    return this.createResponse(200, result.rows[0]);
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new StrategySessionHandler().handleEvent(event);
};
