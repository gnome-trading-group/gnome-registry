import { APIGatewayProxyEvent } from 'aws-lambda';
import {
  EC2Client,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const REGISTRY_API_URL = (process.env.REGISTRY_API_URL ?? '').replace(/\/$/, '');
const REGISTRY_API_KEY_ID = process.env.REGISTRY_API_KEY_ID ?? '';
const STAGE = process.env.STAGE ?? '';

// Subnets and the security group keep their original tag; only the compute moved from Fargate to EC2.
const NETWORK_TAG_KEY = 'gnome:purpose';
const NETWORK_TAG_VALUE = 'orchestrator-ecs';
const INSTANCE_PURPOSE = 'orchestrator-ec2';
const LAUNCH_TEMPLATE_NAME = 'gnome-orchestrator';
const AMI_PARAMETER_PREFIX = '/gnome/orchestrator/ami';
const LATEST_ORCHESTRATOR_PARAMETER = '/gnome/orchestrator/latest-version';
// Published by gnome-orchestrator per release as <prefix>/<version>, plus <prefix>/latest:
// { version, properties: { key: defaultValue } }.
const ORCHESTRATOR_PROPERTIES_PREFIX = '/gnome/orchestrator/properties';
// Session config keys under this prefix override an orchestrator property of the same name for that session only.
export const OVERRIDE_PREFIX = 'overrides.';
const VERSION_PARAMETER_REGION = 'us-east-1';
const PYPI_GNOMEPY_URL = 'https://pypi.org/pypi/gnomepy/json';
// EC2's limit on raw (pre-base64) user data.
const MAX_USER_DATA_BYTES = 16 * 1024;

const STANDARD = 'standard';
const LOW_LATENCY = 'low_latency';

// vCPUs per supported size. Each low-latency size has an AMI whose isolcpus range matches it; c7i.large and
// c7i.xlarge have too few cores to isolate any, so they only run the standard profile.
export const INSTANCE_VCPUS: Record<string, number> = {
  'c7i.large': 2,
  'c7i.xlarge': 4,
  'c7i.4xlarge': 16,
  'c7i.8xlarge': 32,
  'c7i.12xlarge': 48,
};
// c7i.large measured at ~2-7% CPU and ~370 MB with five listings on the standard profile (2026-10).
const DEFAULT_INSTANCE_TYPE: Record<string, string> = {
  [STANDARD]: 'c7i.large',
  [LOW_LATENCY]: 'c7i.4xlarge',
};

export const ACTIVE_STATUSES = ['SUBMITTED', 'STARTING', 'RUNNING'];

const DEFAULT_STOP_GRACE_MS = 5000;
// Stays well under API Gateway's 29s integration timeout once the lookups, halt and termination are added.
const MAX_STOP_GRACE_MS = 20000;
const STOP_KILL_REASON = 'session stop';
const UNKNOWN_ACTOR = 'unknown';

let cachedApiKey: string | undefined;

async function getRegistryApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const client = new APIGatewayClient({});
  const res = await client.send(new GetApiKeyCommand({ apiKey: REGISTRY_API_KEY_ID, includeValue: true }));
  if (!res.value) throw new Error('Registry API key value not found');
  cachedApiKey = res.value;
  return cachedApiKey;
}

async function registryRequest(
  path: string,
  method: string,
  body?: object,
  params?: Record<string, string>,
): Promise<{ status: number; body: any }> {
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
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error bodies are passed through as text.
  }
  return { status: res.status, body: parsed };
}

async function registryFetch(path: string, method: string = 'GET', body?: object, params?: Record<string, string>): Promise<any> {
  const res = await registryRequest(path, method, body, params);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Registry ${method} ${path} failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
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

interface NetworkConfig {
  subnets: { subnetId: string; availabilityZone: string }[];
  securityGroupId: string;
}

async function discoverNetworkConfig(region: string): Promise<NetworkConfig> {
  const ec2 = new EC2Client({ region });
  const [subnetsRes, sgsRes] = await Promise.all([
    ec2.send(new DescribeSubnetsCommand({
      Filters: [{ Name: `tag:${NETWORK_TAG_KEY}`, Values: [NETWORK_TAG_VALUE] }],
    })),
    ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [{ Name: `tag:${NETWORK_TAG_KEY}`, Values: [NETWORK_TAG_VALUE] }],
    })),
  ]);
  const subnets = (subnetsRes.Subnets ?? []).map(s => ({ subnetId: s.SubnetId!, availabilityZone: s.AvailabilityZone! }));
  if (subnets.length === 0) throw new Error(`No orchestrator subnets found in ${region}`);
  const sg = sgsRes.SecurityGroups?.[0];
  if (!sg?.GroupId) throw new Error(`No orchestrator security group found in ${region}`);
  return { subnets, securityGroupId: sg.GroupId };
}

async function getParameter(region: string, name: string): Promise<string> {
  const ssm = new SSMClient({ region });
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty in ${region}`);
  return value;
}

export function amiParameterName(profile: string, instanceType: string): string {
  if (profile === STANDARD) return `${AMI_PARAMETER_PREFIX}/standard`;
  return `${AMI_PARAMETER_PREFIX}/${INSTANCE_VCPUS[instanceType]}core`;
}

async function resolveLatestOrchestratorVersion(): Promise<string> {
  return getParameter(VERSION_PARAMETER_REGION, LATEST_ORCHESTRATOR_PARAMETER);
}

// Kept behind one function so moving gnomepy's "latest" into SSM later is a one-line change.
async function resolveLatestGnomepyVersion(): Promise<string> {
  const res = await fetch(PYPI_GNOMEPY_URL);
  if (!res.ok) throw new Error(`PyPI lookup for gnomepy failed (${res.status})`);
  const json = (await res.json()) as { info?: { version?: string } };
  if (!json.info?.version) throw new Error('PyPI response for gnomepy has no version');
  return json.info.version;
}

interface ICreateSession {
  sessionId: string;
  strategyId: number;
  mode: string;
  config: Record<string, unknown>;
  researchCommit?: string;
  region?: string;
  availabilityZone?: string;
  instanceType?: string;
  orchestratorVersion?: string;
  gnomepyVersion?: string;
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

export interface OrchestratorProperties {
  version: string;
  properties: Record<string, string>;
}

// Releases from before per-version publishing have no list of their own, so they're checked against the latest one.
async function loadOrchestratorProperties(version?: string): Promise<OrchestratorProperties> {
  if (version) {
    try {
      return JSON.parse(await getParameter(VERSION_PARAMETER_REGION, `${ORCHESTRATOR_PROPERTIES_PREFIX}/${version}`));
    } catch {
      // Falls through to latest.
    }
  }
  return JSON.parse(await getParameter(VERSION_PARAMETER_REGION, `${ORCHESTRATOR_PROPERTIES_PREFIX}/latest`));
}

// Read with no fallback at startup (the orchestrator needs the type, and the Java class; gnomepy's runner needs the
// Python class), so a session without them boots an instance that dies before it trades.
export function missingStrategyConfig(config: Record<string, unknown>): string | null {
  if (!String(config['strategy.type'] ?? '').trim()) return 'config["strategy.type"] is required (java or python)';
  if (!String(config['strategy.class'] ?? '').trim()) return 'config["strategy.class"] is required';
  return null;
}

export function overrideKeys(config: Record<string, unknown>): string[] {
  return Object.keys(config).filter((k) => k.startsWith(OVERRIDE_PREFIX)).map((k) => k.slice(OVERRIDE_PREFIX.length));
}

export function buildSessionEnvironment(
  s: ICreateSession,
  versions: { orchestratorVersion: string; gnomepyVersion: string },
  sessionSeq: number,
): Record<string, string> {
  const env: Record<string, string> = {};
  const args: Record<string, unknown> = {};
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s.config)) {
    if (key.startsWith('strategy.args.')) {
      args[key.substring('strategy.args.'.length)] = value;
    } else if (key.startsWith(OVERRIDE_PREFIX)) {
      overrides[key.substring(OVERRIDE_PREFIX.length)] = value;
    } else {
      env[toEnvVarName(key)] = Array.isArray(value) ? JSON.stringify(value) : String(value);
    }
  }
  // After the plain config so an explicit override wins, and before the launcher's own values below so an override
  // can never change the session's identity or stage.
  for (const [property, value] of Object.entries(overrides)) {
    env[toEnvVarName(property)] = String(value);
  }
  if (Object.keys(args).length > 0) env.STRATEGY_ARGS_JSON = JSON.stringify(args);
  env.STRATEGY_ID = String(s.strategyId);
  env.MODE = s.mode;
  env.SESSION_ID = s.sessionId;
  // The session's short number, which venues with client-chosen order ids (Kalshi) carry in each order's id.
  env.SESSION_SEQ = String(sessionSeq);
  env.STAGE = STAGE;
  env.REGISTRY_API_KEY_ID = REGISTRY_API_KEY_ID;
  env.ORCHESTRATOR_VERSION = versions.orchestratorVersion;
  env.GNOMEPY_VERSION = versions.gnomepyVersion;
  if (s.researchCommit) env.RESEARCH_COMMIT = s.researchCommit;
  return env;
}

// Base64 so arbitrary JSON (strategy args, simulation profiles) survives the shell untouched. Any failure here
// shuts the instance down, which terminates it via the launch template's shutdown behaviour.
export function buildUserData(env: Record<string, string>): string {
  const payload = Buffer.from(JSON.stringify(env)).toString('base64');
  return [
    '#!/bin/bash',
    "trap 'shutdown -h now' ERR",
    'set -euo pipefail',
    'install -d -m 0755 /etc/gnome',
    `echo '${payload}' | base64 -d > /etc/gnome/session.json`,
    'systemctl start gnome-strategy.service',
    '',
  ].join('\n');
}

function launchErrorResponse(error: any) {
  const name = error?.name ?? error?.Code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'VcpuLimitExceeded') {
    return createResponse(409, { message: `EC2 vCPU quota exceeded for this instance type: ${message}` });
  }
  if (name === 'InsufficientInstanceCapacity') {
    return createResponse(503, { message: `No EC2 capacity for this instance type in the chosen AZ: ${message}` });
  }
  return createResponse(500, { message: `RunInstances failed: ${message}` });
}

async function handleLaunch(body: string | null) {
  if (!body) return createResponse(400, { message: 'Missing body' });

  const s = JSON.parse(body) as ICreateSession;
  if (!s.sessionId || !s.strategyId || !s.mode || !s.config) {
    return createResponse(400, { message: 'Missing required fields: sessionId, strategyId, mode, config' });
  }

  const missing = missingStrategyConfig(s.config);
  if (missing) return createResponse(400, { message: missing });

  const rawListings = s.config['listings'];
  const listingIds: number[] = Array.isArray(rawListings)
    ? rawListings.map(Number).filter(id => !isNaN(id))
    : [];
  if (listingIds.length === 0) {
    return createResponse(400, { message: 'config.listings must be a non-empty array of listing IDs' });
  }

  // Paper fills come from a simulated exchange that models its own latency, so isolated cores buy it nothing.
  const profile = String(s.config['latency.profile'] ?? (s.mode === 'live' ? LOW_LATENCY : STANDARD)).toLowerCase();
  if (profile !== STANDARD && profile !== LOW_LATENCY) {
    return createResponse(400, { message: `Unknown latency.profile: ${profile}` });
  }
  // Written back so the instance, the stored session and a relaunch all see the profile actually chosen, rather
  // than each applying its own default.
  s.config['latency.profile'] = profile;
  const instanceType = s.instanceType ?? DEFAULT_INSTANCE_TYPE[profile];
  if (!(instanceType in INSTANCE_VCPUS)) {
    return createResponse(400, {
      message: `Unsupported instanceType ${instanceType}; expected one of ${Object.keys(INSTANCE_VCPUS).join(', ')}`,
    });
  }
  if (profile === LOW_LATENCY && INSTANCE_VCPUS[instanceType] <= 4) {
    return createResponse(400, { message: `${instanceType} is too small to isolate cores; use latency.profile=standard` });
  }

  const orchestratorVersion = s.orchestratorVersion || await resolveLatestOrchestratorVersion();

  const overridden = overrideKeys(s.config);
  if (overridden.length > 0) {
    let known: OrchestratorProperties;
    try {
      known = await loadOrchestratorProperties(orchestratorVersion);
    } catch {
      return createResponse(400, {
        message: 'Orchestrator overrides need the published property list, which is not available yet; launch without overrides or deploy gnome-orchestrator first',
      });
    }
    const unknown = overridden.filter((k) => !(k in known.properties));
    if (unknown.length > 0) {
      return createResponse(400, {
        message: `Unknown orchestrator properties (not in orchestrator ${known.version}): ${unknown.join(', ')}`,
      });
    }
  }

  const region = s.region ?? await resolveRegion(listingIds);
  const network = await discoverNetworkConfig(region);
  const subnet = s.availabilityZone
    ? network.subnets.find(n => n.availabilityZone === s.availabilityZone)
    : network.subnets[0];
  if (!subnet) {
    return createResponse(400, {
      message: `No orchestrator subnet in ${s.availabilityZone}; available: ${network.subnets.map(n => n.availabilityZone).join(', ')}`,
    });
  }

  const isPython = String(s.config['strategy.type'] ?? '') === 'python';
  // Java sessions need gnomepy too: the instance reads the JVM flags from it, so both strategy types launch the
  // JVM identically.
  const gnomepyVersion = s.gnomepyVersion || await resolveLatestGnomepyVersion();
  const imageId = await getParameter(region, amiParameterName(profile, instanceType));

  // Checked before the session exists, with the longest sequence number it could be given.
  const sizedUserData = buildUserData(
    buildSessionEnvironment(s, { orchestratorVersion, gnomepyVersion }, Number.MAX_SAFE_INTEGER));
  if (Buffer.byteLength(sizedUserData) > MAX_USER_DATA_BYTES) {
    return createResponse(400, { message: `Session config too large for EC2 user data (${Buffer.byteLength(sizedUserData)} bytes)` });
  }

  // The row exists before the instance does, so an instance can never be running without a session to stop it.
  // A 409 means another session of this strategy already holds one of these listings: passed back as is, so the
  // caller sees which session.
  const created = await registryRequest('/strategy-sessions', 'POST', {
    sessionId: s.sessionId,
    strategyId: s.strategyId,
    status: 'SUBMITTED',
    mode: s.mode,
    config: s.config,
    researchCommit: s.researchCommit,
    instanceType,
    launchRegion: region,
    orchestratorVersion,
    gnomepyVersion,
  });
  if (created.status === 409) {
    return createResponse(409, created.body);
  }
  if (created.status < 200 || created.status >= 300) {
    throw new Error(`Registry POST /strategy-sessions failed (${created.status}): ${JSON.stringify(created.body)}`);
  }
  const userData = buildUserData(buildSessionEnvironment(
    s, { orchestratorVersion, gnomepyVersion }, Number((created.body as { session_seq: number | string }).session_seq)));

  const tags = [
    { Key: 'gnome:purpose', Value: INSTANCE_PURPOSE },
    { Key: 'gnome:session-id', Value: s.sessionId },
    { Key: 'gnome:strategy-id', Value: String(s.strategyId) },
    { Key: 'gnome:strategy-type', Value: isPython ? 'python' : 'java' },
    { Key: 'Name', Value: `orchestrator-${s.sessionId.substring(0, 8)}` },
  ];

  let instanceId: string;
  let availabilityZone: string | undefined;
  try {
    const result = await new EC2Client({ region }).send(new RunInstancesCommand({
      LaunchTemplate: { LaunchTemplateName: LAUNCH_TEMPLATE_NAME, Version: '$Latest' },
      ImageId: imageId,
      InstanceType: instanceType as any,
      SubnetId: subnet.subnetId,
      MinCount: 1,
      MaxCount: 1,
      UserData: Buffer.from(userData).toString('base64'),
      TagSpecifications: [
        { ResourceType: 'instance', Tags: tags },
        { ResourceType: 'volume', Tags: tags },
      ],
    }));
    const instance = result.Instances?.[0];
    if (!instance?.InstanceId) throw new Error('RunInstances returned no instance');
    instanceId = instance.InstanceId;
    availabilityZone = instance.Placement?.AvailabilityZone ?? subnet.availabilityZone;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await registryRequest('/strategy-sessions', 'PATCH', {
      status: 'FAILED',
      failureReason: `Launch failed: ${message}`,
      stoppedAt: new Date().toISOString(),
      expectedStatus: ['SUBMITTED'],
    }, { sessionId: s.sessionId });
    return launchErrorResponse(error);
  }

  const session = await registryFetch('/strategy-sessions', 'PATCH', {
    instanceId,
    availabilityZone,
  }, { sessionId: s.sessionId });

  return createResponse(200, session);
}

export function clampStopGraceMs(stopGraceMs: unknown): number {
  if (typeof stopGraceMs !== 'number' || !Number.isFinite(stopGraceMs)) return DEFAULT_STOP_GRACE_MS;
  return Math.min(MAX_STOP_GRACE_MS, Math.max(0, Math.floor(stopGraceMs)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleStop(event: APIGatewayProxyEvent) {
  const body = event.body;
  if (!body) return createResponse(400, { message: 'Missing body' });

  const { sessionId, stopGraceMs, actor: requestedActor } = JSON.parse(body) as {
    sessionId: string;
    stopGraceMs?: number;
    actor?: unknown;
  };
  // A person's identity comes only from their Cognito token, never the body, so nobody can stop as someone else.
  // Only API-key callers (services) have no token, and they say who they are in `actor`.
  const claimsEmail: string | undefined = event.requestContext?.authorizer?.claims?.email;
  const actor = claimsEmail
    ?? (typeof requestedActor === 'string' && requestedActor.trim() ? requestedActor.trim() : UNKNOWN_ACTOR);

  const sessions = await registryFetch('/strategy-sessions', 'GET', undefined, { sessionId });
  if (!sessions?.length) {
    return createResponse(404, { message: `Session not found: ${sessionId}` });
  }
  const session = sessions[0];

  // STOPPING goes on before the kill, so a stop's kill never sits on a session that still reads as live: anything
  // watching kill switches (the controller's halt alerts) can tell a routine stop from a halt by status alone. A
  // retry of a stop that died part-way finds the session already STOPPING and carries on.
  const stopping = await registryRequest('/strategy-sessions', 'PATCH', {
    status: 'STOPPING',
    expectedStatus: [...ACTIVE_STATUSES, 'STOPPING'],
  }, { sessionId });
  if (stopping.status === 409) {
    // Already STOPPED or FAILED. Its kill may have been released when the instance terminated, and a fresh one
    // would then never be released, so only make sure the instance is gone.
    await terminateInstance(session);
    return createResponse(409, stopping.body);
  }
  if (stopping.status !== 200) {
    throw new Error(`Registry PATCH /strategy-sessions failed (${stopping.status}): ${JSON.stringify(stopping.body)}`);
  }

  // Kill first so the OMS stops trading and cancels resting orders while the instance is still alive to do it;
  // terminating outright would leave whatever was resting on the venue. This lambda runs outside the VPC with
  // no DB access, so the kill goes through the registry's halt endpoint, attributed to the operator.
  let killed = false;
  try {
    // Only this session: a stop must not halt other running sessions of the same strategy.
    await registryFetch('/risk/halts', 'POST', {
      sessionId,
      reason: STOP_KILL_REASON,
      actor,
    });
    killed = true;
  } catch (error) {
    // A stop must never get stuck behind the kill, so the instance is terminated regardless.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Kill switch upsert failed for session ${sessionId}, terminating anyway:`, message);
  }

  if (killed && session.instance_id) {
    await sleep(clampStopGraceMs(stopGraceMs));
  }

  // A session with an instance stays STOPPING until the session monitor sees that instance terminated: only then is
  // the orchestrator (and its final ledger writes) certainly gone, so only then may its listings be released. A
  // session that never got an instance has nothing to wait for.
  if (session.instance_id) {
    await terminateInstance(session);
    return createResponse(200, { ...session, status: 'STOPPING' });
  }
  const stopped = await registryRequest('/strategy-sessions', 'PATCH', {
    status: 'STOPPED',
    stoppedAt: new Date().toISOString(),
    expectedStatus: ['STOPPING'],
  }, { sessionId });
  if (stopped.status !== 200 && stopped.status !== 409) {
    throw new Error(`Registry PATCH /strategy-sessions failed (${stopped.status}): ${JSON.stringify(stopped.body)}`);
  }
  return createResponse(stopped.status, stopped.body);
}

async function terminateInstance(session: { instance_id?: string | null; launch_region?: string | null }) {
  if (session.instance_id && session.launch_region) {
    await new EC2Client({ region: session.launch_region }).send(new TerminateInstancesCommand({
      InstanceIds: [session.instance_id],
    }));
  }
}

async function handleLogs(queryParams: Record<string, string> | null) {
  const sessionId = queryParams?.sessionId;
  if (!sessionId) return createResponse(400, { message: 'sessionId is required' });

  const sessions = await registryFetch('/strategy-sessions', 'GET', undefined, { sessionId });
  if (!sessions?.length) return createResponse(404, { message: `Session not found: ${sessionId}` });

  const instanceId: string | undefined = sessions[0].instance_id;
  const region: string | undefined = sessions[0].launch_region;
  if (!instanceId || !region) return createResponse(200, { logs: [] });

  const logGroupName = `/gnome/orchestrator/${region}`;
  const logStreamName = `ec2/${instanceId}`;

  const logsClient = new CloudWatchLogsClient({ region });
  let logEvents: { timestamp: number; message: string }[] = [];
  try {
    const response = await logsClient.send(new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      startTime: Date.now() - 60 * 60 * 1000,
      endTime: Date.now(),
      limit: 500,
    }));
    logEvents = (response.events ?? []).map(e => ({ timestamp: e.timestamp ?? 0, message: e.message ?? '' }));
  } catch (err: any) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }

  const encodeLogPath = (s: string) => s.replace(/\//g, '$252F');
  const consoleUrl = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeLogPath(logGroupName)}/log-events/${encodeLogPath(logStreamName)}`;

  return createResponse(200, { logs: [{ instanceId, logs: logEvents, consoleUrl }] });
}

export const handler = async (event: APIGatewayProxyEvent) => {
  try {
    const path = event.resource ?? event.path;
    if (path.endsWith('/launch') && event.httpMethod === 'POST') {
      return await handleLaunch(event.body);
    }
    if (path.endsWith('/stop') && event.httpMethod === 'POST') {
      return await handleStop(event);
    }
    if (path.endsWith('/orchestrator/properties') && event.httpMethod === 'GET') {
      try {
        return createResponse(200, await loadOrchestratorProperties(event.queryStringParameters?.version || undefined));
      } catch {
        return createResponse(404, { message: 'No orchestrator property list has been published yet' });
      }
    }
    if (path.endsWith('/logs') && event.httpMethod === 'GET') {
      return await handleLogs(event.queryStringParameters as Record<string, string> | null);
    }
    return createResponse(400, { message: `Unknown route: ${event.httpMethod} ${path}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('Launcher error:', message, stack);
    return createResponse(500, { message, stack });
  }
};
