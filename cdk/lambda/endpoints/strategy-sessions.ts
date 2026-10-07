import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ResourceHandler, withTransaction } from './base';

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
    if (params?.mode === 'paper' || params?.mode === 'live') {
      query += ` AND mode='${params.mode}'`;
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

  // The session and its leases go in together: a session that trades a listing holds it from creation until its
  // process is gone, so a second session of the same strategy and mode can't take it in between. A clash is a 409
  // naming the session that holds the listing.
  async createOne(body: string | null) {
    if (!body) return this.createResponse(400, { message: 'Missing body' });

    const s = JSON.parse(body) as ISession;
    if (!s.sessionId || !s.strategyId || !s.status || !s.mode || !s.config) {
      return this.createResponse(400, { message: 'Missing required fields: sessionId, strategyId, status, mode, config' });
    }
    const listings = parseListings(s.config.listings);
    if (!listings) {
      return this.createResponse(400, { message: 'config.listings must be a non-empty list of listing ids' });
    }

    const nullable = (v?: string) => (v != null ? `'${v}'` : 'null');

    try {
      const row = await withTransaction(this.client, async (client) => {
        const result = await client.query(`
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
        await client.query(
          `INSERT INTO strategy.session_listing (session_id, strategy_id, mode, listing_id)
           SELECT $1, $2, $3, unnest($4::int[])`,
          [s.sessionId, s.strategyId, s.mode, listings]);
        return result.rows[0];
      });
      return this.createResponse(200, row);
    } catch (error) {
      if ((error as { constraint?: string })?.constraint === 'idx_session_listing_lease') {
        const holder = await this.client.query(
          `SELECT session_id, listing_id FROM strategy.session_listing
           WHERE strategy_id = $1 AND mode = $2 AND listing_id = ANY($3::int[]) AND active LIMIT 1`,
          [s.strategyId, s.mode, listings]);
        const clash = holder.rows[0];
        return this.createResponse(409, {
          message: clash
            ? `Session ${clash.session_id} of this strategy is already trading listing ${clash.listing_id} in ${s.mode}`
            : 'Another session of this strategy is already trading one of these listings',
          conflictingSessionId: clash?.session_id,
        });
      }
      throw error;
    }
  }
}

export function parseListings(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.map(Number);
  return ids.every(id => Number.isInteger(id) && id > 0) ? [...new Set(ids)] : null;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new StrategySessionHandler().handleEvent(event);
};
