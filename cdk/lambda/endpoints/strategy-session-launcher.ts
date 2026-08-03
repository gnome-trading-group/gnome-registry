import { APIGatewayProxyEvent } from 'aws-lambda';
import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeSubnetsCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';

const REGISTRY_API_URL = (process.env.REGISTRY_API_URL ?? '').replace(/\/$/, '');
const REGISTRY_API_KEY_ID = process.env.REGISTRY_API_KEY_ID ?? '';

const CLUSTER_NAME = 'gnome-orchestrator';
const TASK_DEFINITION_FAMILY = 'gnome-orchestrator-trading';
const ORCHESTRATOR_TAG_KEY = 'gnome:purpose';
const ORCHESTRATOR_TAG_VALUE = 'orchestrator-ecs';

let cachedApiKey: string | undefined;

async function getRegistryApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const client = new APIGatewayClient({});
  const res = await client.send(new GetApiKeyCommand({ apiKey: REGISTRY_API_KEY_ID, includeValue: true }));
  if (!res.value) throw new Error('Registry API key value not found');
  cachedApiKey = res.value;
  return cachedApiKey;
}

async function registryFetch(path: string, method: string = 'GET', body?: object, params?: Record<string, string>): Promise<any> {
  const apiKey = await getRegistryApiKey();
  let url = `${REGISTRY_API_URL}${path}`;
  if (params && Object.keys(params).length > 0) {
    url += `?${new URLSearchParams(params).toString()}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Registry ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function toEnvVarName(key: string): string {
  return key.replace(/\./g, '_').toUpperCase();
}

async function resolveRegion(listingIds: number[]): Promise<string> {
  const exchangeIds = new Set<number>();
  for (const listingId of listingIds) {
    const listings = await registryFetch('/listings', 'GET', undefined, { listingId: String(listingId) });
    if (!listings?.length) throw new Error(`Listing not found: ${listingId}`);
    exchangeIds.add(listings[0].exchangeId);
  }
  const regions = new Set<string>();
  for (const exchangeId of exchangeIds) {
    const exchanges = await registryFetch('/exchanges', 'GET', undefined, { exchangeId: String(exchangeId) });
    if (!exchanges?.length) throw new Error(`Exchange not found: ${exchangeId}`);
    regions.add(exchanges[0].region);
  }
  if (regions.size === 0) throw new Error('No listings provided');
  if (regions.size > 1) throw new Error(`Listings span multiple regions: ${[...regions].join(', ')}`);
  return [...regions][0];
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

interface ICreateSession {
  sessionId: string;
  strategyId: number;
  mode: string;
  config: Record<string, string>;
  researchCommit?: string;
  region?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

function createResponse(statusCode: number, body: any) {
  return {
    statusCode,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: CORS_HEADERS,
  };
}

async function handleLaunch(body: string | null) {
  if (!body) return createResponse(400, { message: 'Missing body' });

  const s = JSON.parse(body) as ICreateSession;
  if (!s.sessionId || !s.strategyId || !s.mode || !s.config) {
    return createResponse(400, { message: 'Missing required fields: sessionId, strategyId, mode, config' });
  }

  const listingIds = String(s.config['listings'] ?? '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(id => !isNaN(id));
  if (listingIds.length === 0) {
    return createResponse(400, { message: 'config.listings must be a non-empty comma-separated list of listing IDs' });
  }

  const region = s.region ?? await resolveRegion(listingIds);
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
    return createResponse(500, { message: `ECS RunTask failed: ${reason}` });
  }

  const session = await registryFetch('/strategy-sessions', 'POST', {
    sessionId: s.sessionId,
    strategyId: s.strategyId,
    status: 'SUBMITTED',
    mode: s.mode,
    config: s.config,
    researchCommit: s.researchCommit,
    taskArn: task.taskArn,
    taskDefinitionArn: runResult.tasks?.[0]?.taskDefinitionArn ?? null,
  });

  return createResponse(200, session);
}

async function handleStop(body: string | null) {
  if (!body) return createResponse(400, { message: 'Missing body' });

  const { sessionId } = JSON.parse(body) as { sessionId: string };

  const sessions = await registryFetch('/strategy-sessions', 'GET', undefined, { sessionId });
  if (!sessions?.length) {
    return createResponse(404, { message: `Session not found: ${sessionId}` });
  }

  const taskArn: string = sessions[0].task_arn;
  if (taskArn) {
    const region = taskArn.split(':')[3];
    const ecs = new ECSClient({ region });
    await ecs.send(new StopTaskCommand({
      cluster: CLUSTER_NAME,
      task: taskArn,
      reason: 'Stopped via registry API',
    }));
  }

  const updated = await registryFetch('/strategy-sessions', 'PATCH', {
    status: 'STOPPED',
    stoppedAt: new Date().toISOString(),
  }, { sessionId });

  return createResponse(200, updated);
}

export const handler = async (event: APIGatewayProxyEvent) => {
  try {
    const path = event.resource ?? event.path;
    if (path.endsWith('/launch') && event.httpMethod === 'POST') {
      return await handleLaunch(event.body);
    }
    if (path.endsWith('/stop') && event.httpMethod === 'POST') {
      return await handleStop(event.body);
    }
    return createResponse(400, { message: `Unknown route: ${event.httpMethod} ${path}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('Launcher error:', message, stack);
    return createResponse(500, { message, stack });
  }
};
