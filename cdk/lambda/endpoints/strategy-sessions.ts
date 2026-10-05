import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler } from './base';

interface ISession {
  sessionId: string;
  strategyId: number;
  status: string;
  mode: string;
  config: Record<string, unknown>;
  researchCommit?: string;
  instanceId?: string;
  instanceType?: string;
  launchRegion?: string;
  availabilityZone?: string;
  orchestratorVersion?: string;
  gnomepyVersion?: string;
}

interface IUpdateSession {
  status?: string;
  failureReason?: string;
  stoppedAt?: string;
  instanceId?: string;
  instanceType?: string;
  launchRegion?: string;
  availabilityZone?: string;
  // Only update when the session is currently in one of these statuses. Lets concurrent writers (launcher,
  // EC2 monitor, the orchestrator itself) race without a late event dragging a session backwards.
  expectedStatus?: string | string[];
}

function sqlList(values: string[]): string {
  return values.map(v => `'${v}'`).join(', ');
}

export function parseStatuses(status: string | string[] | undefined): string[] {
  if (status == null) return [];
  const list = Array.isArray(status) ? status : status.split(',');
  return list.map(s => s.trim()).filter(s => s.length > 0);
}

export class StrategySessionHandler extends ResourceHandler {
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
    const statuses = parseStatuses(params?.status);
    if (statuses.length > 0) {
      query += ` AND status IN (${sqlList(statuses)})`;
    }
    if (params?.instanceId) {
      query += ` AND instance_id='${params.instanceId}'`;
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
    if (s.failureReason != null) updates.push(`failure_reason='${s.failureReason.replace(/'/g, "''")}'`);
    if (s.stoppedAt != null) updates.push(`stopped_at='${s.stoppedAt}'`);
    if (s.instanceId != null) updates.push(`instance_id='${s.instanceId}'`);
    if (s.instanceType != null) updates.push(`instance_type='${s.instanceType}'`);
    if (s.launchRegion != null) updates.push(`launch_region='${s.launchRegion}'`);
    if (s.availabilityZone != null) updates.push(`availability_zone='${s.availabilityZone}'`);
    updates.push(`date_modified=NOW()`);
    const expected = parseStatuses(s.expectedStatus);
    const guard = expected.length > 0 ? ` AND status IN (${sqlList(expected)})` : '';
    return `
      UPDATE strategy.session SET ${updates.join(', ')}
      WHERE session_id='${row['session_id']}'${guard}
      RETURNING *;
    `;
  }

  allowedSortColumns(): string[] {
    return ['started_at', 'date_created', 'date_modified', 'status'];
  }

  // Overridden to tell "no such session" (404) apart from "session exists but is no longer in an expected
  // status" (409), which callers treat as a normal outcome of a race rather than an error.
  async modifyOne(params: APIGatewayProxyEventQueryStringParameters | null, body: string | null) {
    if (!body) return this.createResponse(400, { message: 'Missing body' });

    const selected = await this.client.query(this.generateSelectQuery(params));
    if (selected.rowCount !== 1) {
      return this.createResponse(404, { message: 'Query params did not return one row only' });
    }
    const current = selected.rows[0];

    const result = await this.client.query(this.generateModifyQuery(current, body));
    if (result.rowCount !== 1) {
      const expected = parseStatuses((JSON.parse(body) as IUpdateSession).expectedStatus);
      if (expected.length > 0) {
        return this.createResponse(409, {
          message: `Session ${current.session_id} is ${current.status}, expected one of ${expected.join(', ')}`,
          status: current.status,
        });
      }
      return this.createResponse(404, { message: `Unable to modify resource from body: ${body}` });
    }
    return this.createResponse(200, result.rows[0]);
  }

  async createOne(body: string | null) {
    if (!body) return this.createResponse(400, { message: 'Missing body' });

    const s = JSON.parse(body) as ISession;
    if (!s.sessionId || !s.strategyId || !s.status || !s.mode || !s.config) {
      return this.createResponse(400, { message: 'Missing required fields: sessionId, strategyId, status, mode, config' });
    }

    const nullable = (v?: string) => (v != null ? `'${v}'` : 'null');

    const result = await this.client.query(`
      INSERT INTO strategy.session (
        session_id, strategy_id, status, mode, config, research_commit,
        instance_id, instance_type, launch_region, availability_zone, orchestrator_version, gnomepy_version
      )
      VALUES (
        '${s.sessionId}', ${s.strategyId}, '${s.status}', '${s.mode}', '${JSON.stringify(s.config)}', ${nullable(s.researchCommit)},
        ${nullable(s.instanceId)}, ${nullable(s.instanceType)}, ${nullable(s.launchRegion)}, ${nullable(s.availabilityZone)},
        ${nullable(s.orchestratorVersion)}, ${nullable(s.gnomepyVersion)}
      )
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
