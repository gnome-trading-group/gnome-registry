import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeSubnetsCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { ResourceHandler } from './base';

const CLUSTER_NAME = 'gnome-orchestrator';
const TASK_DEFINITION_FAMILY = 'gnome-orchestrator-trading';
const ORCHESTRATOR_TAG_KEY = 'gnome:purpose';
const ORCHESTRATOR_TAG_VALUE = 'orchestrator-ecs';

interface ICreateSession {
  sessionId: string;
  strategyId: number;
  mode: string;
  config: Record<string, string>;
  researchCommit?: string;
  region?: string;
}

interface IUpdateSession {
  status?: string;
  taskArn?: string;
  failureReason?: string;
  stoppedAt?: string;
}

function toEnvVarName(propertyKey: string): string {
  return propertyKey.replace(/\./g, '_').toUpperCase();
}

async function lookupExchangeRegion(client: any, listingIds: number[]): Promise<string> {
  const placeholders = listingIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await client.query(
    `SELECT DISTINCT e.region
     FROM sm.exchange e
     JOIN sm.listing l ON l.exchange_id = e.exchange_id
     WHERE l.listing_id IN (${placeholders})`,
    listingIds
  );
  if (result.rowCount === 0) {
    throw new Error(`No exchange region found for listing IDs: ${listingIds.join(', ')}`);
  }
  if (result.rowCount > 1) {
    throw new Error(`Listings span multiple exchange regions: ${result.rows.map((r: any) => r.region).join(', ')}`);
  }
  return result.rows[0].region as string;
}

async function discoverNetworkConfig(region: string): Promise<{ subnetIds: string[]; securityGroupId: string }> {
  const ec2 = new EC2Client({ region });

  const [subnetsRes, sgsRes] = await Promise.all([
    ec2.send(new DescribeSubnetsCommand({
      Filters: [{ Name: `tag:${ORCHESTRATOR_TAG_KEY}`, Values: [ORCHESTRATOR_TAG_VALUE] }],
    })),
    ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [{ Name: `tag:${ORCHESTRATOR_TAG_KEY}`, Values: [ORCHESTRATOR_TAG_VALUE] }],
    })),
  ]);

  const subnetIds = (subnetsRes.Subnets ?? []).map(s => s.SubnetId!);
  if (subnetIds.length === 0) throw new Error(`No orchestrator subnets found in ${region}`);

  const sg = sgsRes.SecurityGroups?.[0];
  if (!sg?.GroupId) throw new Error(`No orchestrator security group found in ${region}`);

  return { subnetIds, securityGroupId: sg.GroupId };
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
    throw new Error('Use createOne override — generateInsertQuery is not called for sessions');
  }

  generateDeleteQuery(_body: string): string {
    throw new Error('Use deleteOne override — generateDeleteQuery is not called for sessions');
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

    const s = JSON.parse(body) as ICreateSession;
    if (!s.sessionId || !s.strategyId || !s.mode || !s.config) {
      return this.createResponse(400, { message: 'Missing required fields: sessionId, strategyId, mode, config' });
    }

    const listingIds = String(s.config['listings'] ?? '')
      .split(',')
      .map(id => parseInt(id.trim(), 10))
      .filter(id => !isNaN(id));
    if (listingIds.length === 0) {
      return this.createResponse(400, { message: 'config.listings must be a non-empty comma-separated list of listing IDs' });
    }

    const region = s.region ?? await lookupExchangeRegion(this.client, listingIds);
    const { subnetIds, securityGroupId } = await discoverNetworkConfig(region);

    const envOverrides = Object.entries(s.config).map(([key, value]) => ({
      name: toEnvVarName(key),
      value: String(value),
    }));
    envOverrides.push({ name: 'STRATEGY_ID', value: String(s.strategyId) });
    envOverrides.push({ name: 'MODE', value: s.mode });
    envOverrides.push({ name: 'SESSION_ID', value: s.sessionId });

    const ecs = new ECSClient({ region });
    const runResult = await ecs.send(new RunTaskCommand({
      cluster: CLUSTER_NAME,
      taskDefinition: TASK_DEFINITION_FAMILY,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: subnetIds,
          securityGroups: [securityGroupId],
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        containerOverrides: [{
          name: 'orchestrator',
          environment: envOverrides,
        }],
      },
      count: 1,
    }));

    const task = runResult.tasks?.[0];
    if (!task?.taskArn) {
      const reason = runResult.failures?.[0]?.reason ?? 'unknown';
      return this.createResponse(500, { message: `ECS RunTask failed: ${reason}` });
    }

    const researchCommit = s.researchCommit != null ? `'${s.researchCommit}'` : 'null';
    const taskDefArn = runResult.tasks?.[0]?.taskDefinitionArn ?? null;
    const insertResult = await this.client.query(`
      INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, research_commit, task_arn, task_definition_arn)
      VALUES ('${s.sessionId}', ${s.strategyId}, 'SUBMITTED', '${s.mode}', '${JSON.stringify(s.config)}', ${researchCommit}, '${task.taskArn}', ${taskDefArn != null ? `'${taskDefArn}'` : 'null'})
      RETURNING *;
    `);

    return this.createResponse(200, insertResult.rows[0]);
  }

  async deleteOne(body: string | null) {
    if (!body) return this.createResponse(400, { message: 'Missing body' });

    const { sessionId } = JSON.parse(body) as { sessionId: string };
    const selectResult = await this.client.query(
      `SELECT task_arn FROM strategy.session WHERE session_id = '${sessionId}'`
    );
    if (selectResult.rowCount === 0) {
      return this.createResponse(404, { message: `Session not found: ${sessionId}` });
    }

    const taskArn: string = selectResult.rows[0].task_arn;
    if (taskArn) {
      const region = taskArn.split(':')[3];
      const ecs = new ECSClient({ region });
      await ecs.send(new StopTaskCommand({
        cluster: CLUSTER_NAME,
        task: taskArn,
        reason: 'Stopped via registry API',
      }));
    }

    const updateResult = await this.client.query(`
      UPDATE strategy.session
      SET status='STOPPED', stopped_at=NOW(), date_modified=NOW()
      WHERE session_id='${sessionId}'
      RETURNING *;
    `);

    return this.createResponse(200, updateResult.rows[0]);
  }
}

export const handler = async (event: APIGatewayProxyEvent) => {
  return await new StrategySessionHandler().handleEvent(event);
};
