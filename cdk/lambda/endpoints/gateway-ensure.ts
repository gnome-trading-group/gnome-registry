import { APIGatewayProxyEvent } from 'aws-lambda';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { AllocateAddressCommand, DescribeAddressesCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  CreateServiceCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, KeyValuePair,
  RegisterTaskDefinitionCommand, UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { platformRegions } from '@gnome-trading-group/gnome-shared-cdk/dist/regions';
import { createResponse } from './ledger-common';

// Starts an order gateway when a session wants it: gateways run only while live sessions use them, as market-data
// shards run only while leased. The registry's gateway row says where (its exchange's region) and which release (its
// pinned one, else the latest); gnome-orchestrator's OrderGatewayStack, in every platform region, holds the cluster,
// the hosts that scale from zero, and the base task definition each gateway's own revision is copied from. A gateway
// idle long enough sets its service back to zero and stops.

// Named in gnome-orchestrator's order-gateway-stack.ts and OrderGatewayOrchestrator.
export const CLUSTER = 'order-gateways';
export const BASE_FAMILY = 'order-gateway';
export const CAPACITY_PROVIDER = 'order-gateway-hosts';
export const SERVICE_PREFIX = 'order-gateway-';
// The tag a gateway finds its Elastic IP by, at startup (gnome-orchestrator start-session.sh).
export const ADDRESS_TAG = 'gnome:order-gateway';
const LATEST_VERSION_PARAMETER = '/gnome/orchestrator/latest-version';
const KEY_PATTERN = /^live:[a-z0-9_]+:[a-z0-9-]+$/;

export class EnsureError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface GatewayRow {
  gateway_key: string;
  mode: string;
  region: string;
  orchestrator_version: string | null;
}

/** What starting a gateway needs from outside: its row (marked wanted), the release to run, and AWS in its region. */
export interface EnsureDeps {
  markWanted(gatewayKey: string): Promise<GatewayRow>;
  latestVersion(): Promise<string>;
  ecs(region: string): { send(command: any): Promise<any> };
  ec2(region: string): { send(command: any): Promise<any> };
}

export interface EnsureResult {
  gatewayKey: string;
  region: string;
  // What this call did: started a stopped gateway, created its service, or found it already wanted.
  action: 'created' | 'started' | 'running';
  // The release a start put it on; a running gateway keeps its own.
  orchestratorVersion?: string;
}

export function serviceName(gatewayKey: string): string {
  return SERVICE_PREFIX + gatewayKey.replace(/:/g, '-');
}

/**
 * Records that a session wants the gateway and makes sure it runs: its service created from the base task definition,
 * or set back to one task; and its Elastic IP allocated the first time. A running gateway is left as it is, its release
 * too: a new pin or release reaches it at its next start. Idempotent, so a waiting session calls it again and again.
 */
export async function ensureGateway(gatewayKey: string, deps: EnsureDeps): Promise<EnsureResult> {
  if (!KEY_PATTERN.test(gatewayKey)) {
    throw new EnsureError(400, `gatewayKey must be a live gateway's key, like live:kalshi:main, not ${JSON.stringify(gatewayKey)}`);
  }
  const row = await deps.markWanted(gatewayKey);
  if (row.mode !== 'live') throw new EnsureError(400, `${gatewayKey} isn't a live gateway`);
  if (!platformRegions().includes(row.region)) {
    throw new EnsureError(400, `${gatewayKey} trades from ${row.region}, where no gateway can run`);
  }
  const ecs = deps.ecs(row.region);
  const service = serviceName(gatewayKey);
  const described = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [service] }));
  const current = (described.services ?? []).find((s: any) => s.status === 'ACTIVE');
  if (current && current.desiredCount > 0) {
    return { gatewayKey, region: row.region, action: 'running' };
  }
  const version = row.orchestrator_version ?? await deps.latestVersion();
  await ensureAddress(deps.ec2(row.region), gatewayKey);
  const taskDefinition = await registerRevision(ecs, gatewayKey, version);
  if (current) {
    await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service, taskDefinition, desiredCount: 1 }));
    return { gatewayKey, region: row.region, action: 'started', orchestratorVersion: version };
  }
  try {
    await ecs.send(new CreateServiceCommand({
      cluster: CLUSTER,
      serviceName: service,
      taskDefinition,
      desiredCount: 1,
      capacityProviderStrategy: [{ capacityProvider: CAPACITY_PROVIDER, weight: 1 }],
      // One host per gateway and fixed ports: the old task stops before a new one starts.
      deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 100 },
    }));
  } catch (error) {
    // The launcher and the session ask at once for a gateway that has never run: the other created it.
    const again = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [service] }));
    if (!(again.services ?? []).some((s: any) => s.status === 'ACTIVE')) throw error;
    return { gatewayKey, region: row.region, action: 'running' };
  }
  return { gatewayKey, region: row.region, action: 'created', orchestratorVersion: version };
}

/** The gateway's own revision: the base task definition as deployed, with its key and release. */
async function registerRevision(ecs: { send(command: any): Promise<any> }, gatewayKey: string, version: string) {
  const base = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: BASE_FAMILY }))).taskDefinition;
  if (!base) throw new EnsureError(503, `No ${BASE_FAMILY} task definition: the gateway stack isn't deployed there`);
  const containerDefinitions = base.containerDefinitions.map((container: any) => ({
    ...container,
    environment: [
      ...(container.environment ?? []).filter((e: KeyValuePair) =>
        e.name !== 'GATEWAY_KEY' && e.name !== 'ORCHESTRATOR_VERSION'),
      { name: 'GATEWAY_KEY', value: gatewayKey },
      { name: 'ORCHESTRATOR_VERSION', value: version },
    ],
  }));
  const registered = await ecs.send(new RegisterTaskDefinitionCommand({
    family: serviceName(gatewayKey),
    taskRoleArn: base.taskRoleArn,
    executionRoleArn: base.executionRoleArn,
    networkMode: base.networkMode,
    containerDefinitions,
    volumes: base.volumes,
    requiresCompatibilities: base.requiresCompatibilities,
    placementConstraints: base.placementConstraints,
  }));
  return registered.taskDefinition.taskDefinitionArn as string;
}

/** The gateway's Elastic IP, allocated once and kept, so the gateway trades from one address whatever host it is on. */
async function ensureAddress(ec2: { send(command: any): Promise<any> }, gatewayKey: string) {
  const found = await ec2.send(new DescribeAddressesCommand({
    Filters: [{ Name: `tag:${ADDRESS_TAG}`, Values: [gatewayKey] }],
  }));
  if ((found.Addresses ?? []).length > 0) return;
  await ec2.send(new AllocateAddressCommand({
    Domain: 'vpc',
    TagSpecifications: [{
      ResourceType: 'elastic-ip',
      Tags: [{ Key: ADDRESS_TAG, Value: gatewayKey }, { Key: 'Name', Value: `order-gateway ${gatewayKey}` }],
    }],
  }));
}

// ----- the Lambda -----

const REGISTRY_API_URL = process.env.REGISTRY_API_URL ?? '';
const REGISTRY_API_KEY_ID = process.env.REGISTRY_API_KEY_ID ?? '';
let cachedApiKey: string | undefined;

async function registryApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const res = await new APIGatewayClient({}).send(new GetApiKeyCommand({ apiKey: REGISTRY_API_KEY_ID, includeValue: true }));
  if (!res.value) throw new Error('Registry API key value not found');
  cachedApiKey = res.value;
  return cachedApiKey;
}

const lambdaDeps: EnsureDeps = {
  async markWanted(gatewayKey) {
    // Through the API: this Lambda runs outside the VPC to reach ECS and EC2, so it can't reach the database itself.
    const res = await fetch(`${REGISTRY_API_URL}gateways?${new URLSearchParams({ gatewayKey })}`, {
      method: 'PATCH',
      headers: { 'x-api-key': await registryApiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ wanted: true }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 404) throw new EnsureError(404, `No gateway ${gatewayKey}`);
    if (!res.ok) throw new EnsureError(502, `Couldn't mark ${gatewayKey} wanted (${res.status}): ${JSON.stringify(body)}`);
    return body as GatewayRow;
  },
  async latestVersion() {
    const res = await new SSMClient({ region: 'us-east-1' }).send(new GetParameterCommand({ Name: LATEST_VERSION_PARAMETER }));
    if (!res.Parameter?.Value) throw new EnsureError(503, `No ${LATEST_VERSION_PARAMETER}`);
    return res.Parameter.Value;
  },
  ecs: (region) => new ECSClient({ region }),
  ec2: (region) => new EC2Client({ region }),
};

export const handler = async (event: APIGatewayProxyEvent) => {
  const gatewayKey = event.queryStringParameters?.gatewayKey ?? '';
  try {
    const result = await ensureGateway(gatewayKey, lambdaDeps);
    if (result.action !== 'running') {
      console.log(`Gateway ${gatewayKey}: ${result.action} in ${result.region} on ${result.orchestratorVersion}`);
    }
    return createResponse(200, result);
  } catch (error) {
    if (error instanceof EnsureError) return createResponse(error.statusCode, { message: error.message });
    console.error(`Couldn't ensure gateway ${gatewayKey}`, error);
    return createResponse(500, { message: `Couldn't start gateway ${gatewayKey}` });
  }
};
