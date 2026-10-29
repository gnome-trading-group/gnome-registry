import { APIGatewayProxyEvent } from 'aws-lambda';
import {
  EC2Client,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { PLATFORM_NETWORK_TAG } from '@gnome-trading-group/gnome-shared-cdk/dist/regions';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ISessionSimulation, PAPER_BLOCKS, validateSessionSimulation } from '../simulation/parameters';
import { ALERT_BUS_NAME, ALERT_DETAIL_TYPE, ALERT_EVENT_SOURCE, AlertEvent } from '../alerts/model';

const REGISTRY_API_URL = (process.env.REGISTRY_API_URL ?? '').replace(/\/$/, '');
const REGISTRY_API_KEY_ID = process.env.REGISTRY_API_KEY_ID ?? '';
const STAGE = process.env.STAGE ?? '';
// The market-data API key's Secrets Manager mirror (gnome-shared-cdk API_KEY_SECRET_NAMES.MARKET_DATA, us-east-1).
// The launcher reads it to lease a paper session's streams, and passes the name on so the session reads it too.
const MARKET_DATA_API_KEY_SECRET = process.env.MARKET_DATA_API_KEY_SECRET ?? '';

// Sessions run in the platform network (gnome-shared-infra): its subnets and security group carry this tag, and the
// launcher passes both, so where a session runs is decided here alone, not partly by the launch template.
const NETWORK_TAG_KEY = PLATFORM_NETWORK_TAG.key;
const NETWORK_TAG_VALUE = PLATFORM_NETWORK_TAG.value;
const INSTANCE_PURPOSE = 'orchestrator-ec2';
// A live session runs under the live template's role, the only one allowed to read venue account credentials.
const LAUNCH_TEMPLATE_NAME = 'gnome-orchestrator';
const LIVE_LAUNCH_TEMPLATE_NAME = 'gnome-orchestrator-live';
const AMI_PARAMETER_PREFIX = '/gnome/orchestrator/ami';
const LATEST_ORCHESTRATOR_PARAMETER = '/gnome/orchestrator/latest-version';
const ENDED_SESSION_STATUSES = ['STOPPED', 'FAILED'];
const ENDED_SESSION_LOGS_GRACE_MS = 5 * 60 * 1000;
// Published by gnome-orchestrator per release as <prefix>/<version>, plus <prefix>/latest:
// { version, properties: { key: defaultValue } }.
const ORCHESTRATOR_PROPERTIES_PREFIX = '/gnome/orchestrator/properties';
// Session config keys under this prefix override an orchestrator property of the same name for that session only.
export const OVERRIDE_PREFIX = 'overrides.';
const VERSION_PARAMETER_REGION = 'us-east-1';
const PYPI_GNOMEPY_URL = 'https://pypi.org/pypi/gnomepy/json';
// EC2's limit on raw (pre-base64) user data.
const MAX_USER_DATA_BYTES = 16 * 1024;
// Aeron stream ids are int32 (md.stream.stream_id doubles as one).
const MAX_STREAM_ID = 2 ** 31 - 1;
// Published by gnome-market-data: the market-data API's URL, stage included (e.g. https://<id>.execute-api.../api/).
const MARKET_DATA_API_URL_PARAMETER = '/gnome/market-data/api-url';
// The lease POST is idempotent per session, so a timeout or 5xx is retried. Each try allows for the lease Lambda's
// cold start; two of them stay inside API Gateway's 29s with the launch's other calls.
const LEASE_ATTEMPTS = 2;
const LEASE_TIMEOUT_MS = 9000;
const LEASE_RETRY_BACKOFF_MS = 250;
// The lease API's MAX_STREAMS (gnome-market-data leases.py): refused here before the session is recorded.
const MAX_LEASE_STREAMS = 500;
// Only a courtesy on stop (the reconciler releases leases of ended sessions), so it must not eat the stop's budget.
const LEASE_RELEASE_TIMEOUT_MS = 2000;

const STANDARD = 'standard';
const LOW_LATENCY = 'low_latency';

// vCPUs per supported size. Each low-latency size has an AMI whose isolcpus range matches it; c7i.large and
// c7i.xlarge have too few cores to isolate any, so they only run the standard profile. t3.small is burstable (2 GB):
// for paper sessions that mostly wait, at about a quarter of c7i.large's price.
export const INSTANCE_VCPUS: Record<string, number> = {
  't3.small': 2,
  'c7i.large': 2,
  'c7i.xlarge': 4,
  'c7i.4xlarge': 16,
  'c7i.8xlarge': 32,
  'c7i.12xlarge': 48,
};
// t3.small ran a live one-listing session at ~9% CPU (under its 20% baseline, so credits grew) and ~630 MB used of
// 1.9 GB (2026-10-16). Sessions that care about latency run the low-latency profile on dedicated cores instead.
const DEFAULT_INSTANCE_TYPE: Record<string, string> = {
  [STANDARD]: 't3.small',
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

// The listings and exchanges endpoints return their rows as stored, in snake_case.
async function listingExchanges(listingIds: number[]): Promise<Map<number, number>> {
  const exchangeOf = new Map<number, number>();
  for (const listingId of listingIds) {
    const listings = await registryFetch('/listings', 'GET', undefined, { listingId: String(listingId) });
    if (!listings?.length) throw new Error(`Listing not found: ${listingId}`);
    exchangeOf.set(listingId, listings[0].exchange_id);
  }
  return exchangeOf;
}

interface ExchangeRow {
  exchange_id: number;
  exchange_code: string;
  region: string;
}

async function exchangeRows(exchangeIds: Set<number>): Promise<Map<number, ExchangeRow>> {
  const rows = new Map<number, ExchangeRow>();
  for (const exchangeId of exchangeIds) {
    const exchanges = await registryFetch('/exchanges', 'GET', undefined, { exchangeId: String(exchangeId) });
    if (!exchanges?.length) throw new Error(`Exchange not found: ${exchangeId}`);
    rows.set(exchangeId, exchanges[0]);
  }
  return rows;
}

function resolveRegion(exchanges: Map<number, ExchangeRow>): string {
  const regions = new Set([...exchanges.values()].map((e) => e.region));
  if (regions.size === 0) throw new Error('No listings provided');
  if (regions.size > 1) throw new Error(`Listings span multiple regions: ${[...regions].join(', ')}`);
  return [...regions][0];
}

// A session's data-only streams (config `streams`): stream ids it reads but doesn't trade, from any region. Returned
// de-duplicated, in the order given.
export function parseStreams(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('config.streams must be an array of stream IDs');
  const bad = raw.filter((id) => !Number.isInteger(id) || id <= 0 || id > MAX_STREAM_ID);
  if (bad.length) throw new Error(`config.streams must hold positive integer stream IDs; got ${bad.map((b) => JSON.stringify(b)).join(', ')}`);
  return [...new Set(raw as number[])];
}

// `active` is the stream's, else its listing's: an inactive stream is never collected, so a lease on it never goes
// LIVE.
interface StreamRow { stream_id: number; listing_id?: number; family?: string; active?: boolean }

// The registry's rows for these streams; a stream it doesn't know has none.
async function streamRows(streamIds: number[]): Promise<StreamRow[]> {
  if (streamIds.length === 0) return [];
  return registryFetch('/streams', 'GET', undefined, { streamIds: streamIds.join(',') });
}

// Every listing has exactly one stream, its book (created with the listing by the database).
async function bookStreams(listingIds: number[]): Promise<StreamRow[]> {
  const rows: StreamRow[] = await registryFetch('/streams', 'GET', undefined, { listingIds: listingIds.join(',') });
  const books = rows.filter((r) => r.family === 'book');
  const covered = new Set(books.map((r) => r.listing_id));
  const missing = listingIds.filter((id) => !covered.has(id));
  if (missing.length) throw new Error(`No market-data book stream for listing(s) ${missing.join(', ')}`);
  return books;
}

// Refuses a paper session that would fail on its instance or quietly not simulate as asked: overrides for an exchange
// that doesn't exist (a misspelt code would leave that exchange's listings on the registry's parameters), or a listing
// whose exchange has no simulation parameters as of the session's pinned time and which the config doesn't fully
// override. Overrides for a real exchange the session doesn't trade are fine: a rule launching one session per venue
// carries every venue's.
export async function simulationProblem(
  simulation: ISessionSimulation, exchangeOf: Map<number, number>, exchanges: Map<number, ExchangeRow>,
): Promise<string | null> {
  const traded = new Set([...exchanges.values()].map((e) => e.exchange_code));
  const unknown: string[] = [];
  for (const code of Object.keys(simulation.exchanges ?? {}).filter((c) => !traded.has(c))) {
    const found = await registryFetch('/exchanges', 'GET', undefined, { exchangeCode: code });
    if (!found?.length) unknown.push(code);
  }
  if (unknown.length) return `simulation.exchanges ${unknown.join(', ')} are not exchanges`;
  const strayListings = Object.keys(simulation.listings ?? {}).filter((id) => !exchangeOf.has(Number(id)));
  if (strayListings.length) return `simulation.listings ${strayListings.join(', ')} are not listings of the session`;

  const rows: { exchange_id: number }[] = await registryFetch(
    '/simulation-parameters', 'GET', undefined, { knownAsOf: simulation.as_of as string });
  const covered = new Set(rows.map((r) => r.exchange_id));
  const uncovered: number[] = [];
  for (const [listingId, exchangeId] of exchangeOf) {
    if (covered.has(exchangeId)) continue;
    const layers = [simulation.exchanges?.[exchanges.get(exchangeId)!.exchange_code], simulation.listings?.[String(listingId)]];
    if (!PAPER_BLOCKS.every((block) => layers.some((layer) => layer && block in layer))) uncovered.push(listingId);
  }
  if (uncovered.length === 0) return null;
  return `No simulation parameters for the exchange of listing(s) ${uncovered.join(', ')} as of ${simulation.as_of}:`
    + ' record them in the Security Master, or set every block for those listings in simulation';
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
  if (subnets.length === 0) throw new Error(`No platform network subnets found in ${region}`);
  const sg = sgsRes.SecurityGroups?.[0];
  if (!sg?.GroupId) throw new Error(`No platform network security group found in ${region}`);
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

// Where a session reports a fatal error (published by the alerting stack). Read once per container, and optional:
// a session launched before alerting is deployed simply has nowhere to report and records its failure reason only.
const ALERTS_API_URL_PARAMETER = '/gnome/alerting/api-url';
let alertsApiUrl: Promise<string | undefined> | undefined;

function resolveAlertsApiUrl(): Promise<string | undefined> {
  alertsApiUrl ??= getParameter(VERSION_PARAMETER_REGION, ALERTS_API_URL_PARAMETER).catch((error) => {
    console.warn('No alerts API URL; sessions will not report fatal errors as alerts', error);
    return undefined;
  });
  return alertsApiUrl;
}

interface MarketDataApi {
  url: string;
  apiKey: string;
}

// Cached per container once found, but a failed lookup is retried on the next call rather than remembered.
let cachedMarketDataApi: MarketDataApi | undefined;

async function resolveMarketDataApi(): Promise<MarketDataApi> {
  if (cachedMarketDataApi) return cachedMarketDataApi;
  const url = (await getParameter(VERSION_PARAMETER_REGION, MARKET_DATA_API_URL_PARAMETER)).replace(/\/$/, '');
  const secret = await new SecretsManagerClient({ region: VERSION_PARAMETER_REGION })
    .send(new GetSecretValueCommand({ SecretId: MARKET_DATA_API_KEY_SECRET }));
  if (!secret.SecretString) throw new Error(`Secret ${MARKET_DATA_API_KEY_SECRET} has no value`);
  cachedMarketDataApi = { url, apiKey: secret.SecretString };
  return cachedMarketDataApi;
}

// A rotated market-data API key reads as a 401/403 with the cached copy, so a caller drops it and tries once more.
function isAuthRefusal(status: number): boolean {
  return status === 401 || status === 403;
}

async function marketDataRequest(
  api: MarketDataApi, path: string, method: string, timeoutMs: number, body?: object,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers: { 'x-api-key': api.apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
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

export interface LeaseRequest {
  sessionId: string;
  streams: number[];
  mode: string;
  region: string;
}

// The session waits for these streams to be LIVE on a shard before it trades (gnome-market-data collection leases).
// A key refusal re-reads the key and spends the next try on it; the API's 5xx (a throttle, a failed write) and
// timeouts are retried as well.
async function createLease(api: MarketDataApi, lease: LeaseRequest): Promise<void> {
  let lastError = '';
  let refreshed = false;
  for (let attempt = 1; attempt <= LEASE_ATTEMPTS; attempt++) {
    try {
      const res = await marketDataRequest(api, '/collection/leases', 'POST', LEASE_TIMEOUT_MS, lease);
      if (res.status >= 200 && res.status < 300) return;
      lastError = `${res.status}: ${JSON.stringify(res.body)}`;
      if (isAuthRefusal(res.status) && !refreshed) {
        refreshed = true;
        cachedMarketDataApi = undefined;
        api = await resolveMarketDataApi();
        continue;
      }
      // A refusal won't change on a retry.
      if (res.status < 500 && res.status !== 429) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < LEASE_ATTEMPTS) await sleep(LEASE_RETRY_BACKOFF_MS * attempt);
  }
  throw new Error(`POST /collection/leases failed (${lastError})`);
}

// Best effort: the reconciler also releases the leases of STOPPED and FAILED sessions, so a failure here only logs.
async function releaseLease(sessionId: string): Promise<void> {
  const path = `/collection/leases/${encodeURIComponent(sessionId)}`;
  try {
    let res = await marketDataRequest(await resolveMarketDataApi(), path, 'DELETE', LEASE_RELEASE_TIMEOUT_MS);
    if (isAuthRefusal(res.status)) {
      cachedMarketDataApi = undefined;
      res = await marketDataRequest(await resolveMarketDataApi(), path, 'DELETE', LEASE_RELEASE_TIMEOUT_MS);
    }
    if ((res.status < 200 || res.status >= 300) && res.status !== 404) {
      console.warn(`Couldn't release the market-data lease of ${sessionId} (${res.status}): ${JSON.stringify(res.body)}`);
    }
  } catch (error) {
    console.warn(`Couldn't release the market-data lease of ${sessionId}`, error);
  }
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
  alertsUrl?: string,
  marketDataApiUrl?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  const args: Record<string, unknown> = {};
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s.config)) {
    // The registry binds the session's accounts when it is created; the orchestrator reads them from there.
    if (key === 'accounts') continue;
    // One JSON value, in the shape a backtest config takes (gnome-simulation SessionSimulationConfig).
    if (key === 'simulation') {
      env.SIMULATION_JSON = JSON.stringify(value);
      continue;
    }
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
  // The streams leased for the session: an override must not point it at streams no lease keeps collected.
  delete env.STREAMS;
  if (Array.isArray(s.config.streams)) env.STREAMS = JSON.stringify(s.config.streams);
  if (Object.keys(args).length > 0) env.STRATEGY_ARGS_JSON = JSON.stringify(args);
  env.STRATEGY_ID = String(s.strategyId);
  env.MODE = s.mode;
  env.SESSION_ID = s.sessionId;
  env.STAGE = STAGE;
  env.REGISTRY_API_KEY_ID = REGISTRY_API_KEY_ID;
  env.ORCHESTRATOR_VERSION = versions.orchestratorVersion;
  env.GNOMEPY_VERSION = versions.gnomepyVersion;
  if (alertsUrl) env.ALERTS_API_URL = alertsUrl;
  // A paper session polls its lease (GET /collection/leases/{sessionId}) for where its streams are published.
  if (marketDataApiUrl) {
    env.MARKET_DATA_API_URL = marketDataApiUrl;
    env.MARKET_DATA_API_KEY_SECRET = MARKET_DATA_API_KEY_SECRET;
  }
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

async function markLaunchFailed(sessionId: string, failureReason: string): Promise<void> {
  await registryRequest('/strategy-sessions', 'PATCH', {
    status: 'FAILED',
    failureReason,
    stoppedAt: new Date().toISOString(),
    expectedStatus: ['SUBMITTED'],
  }, { sessionId });
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

  let dataStreams: number[];
  try {
    dataStreams = parseStreams(s.config['streams']);
  } catch (e) {
    return createResponse(400, { message: (e as Error).message });
  }
  if (dataStreams.length > 0 && s.mode !== 'paper') {
    return createResponse(400, { message: 'config.streams needs a paper session: live sessions read their own feeds' });
  }

  const exchangeOf = await listingExchanges(listingIds);
  const exchanges = await exchangeRows(new Set(exchangeOf.values()));
  let leaseStreams: number[] = [];
  let marketData: MarketDataApi | undefined;
  if (s.mode === 'paper') {
    let simulation: ISessionSimulation;
    try {
      simulation = validateSessionSimulation(s.config.simulation);
    } catch (e) {
      return createResponse(400, { message: (e as Error).message });
    }
    // Pinned so the instance, the stored session and a replay all simulate with the parameters and fees recorded by
    // then, whatever is recorded later.
    const asOf = simulation.as_of ?? new Date().toISOString();
    if (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf))) {
      return createResponse(400, { message: 'simulation.as_of must be an ISO-8601 timestamp' });
    }
    simulation.as_of = new Date(asOf).toISOString();
    s.config.simulation = simulation;
    const problem = await simulationProblem(simulation, exchangeOf, exchanges);
    if (problem) return createResponse(400, { message: problem });

    const dataRows = await streamRows(dataStreams);
    const known = new Set(dataRows.map((r) => r.stream_id));
    const unknown = dataStreams.filter((id) => !known.has(id));
    if (unknown.length) return createResponse(400, { message: `config.streams ${unknown.join(', ')} are not streams` });
    let traded: StreamRow[];
    try {
      traded = await bookStreams(listingIds);
    } catch (e) {
      return createResponse(400, { message: (e as Error).message });
    }
    // A traded listing's book stream is already the session's; listed again it would be subscribed twice.
    const tradedStreams = new Set(traded.map((r) => r.stream_id));
    dataStreams = dataStreams.filter((id) => !tradedStreams.has(id));
    if ('streams' in s.config) s.config.streams = dataStreams;
    leaseStreams = [...tradedStreams, ...dataStreams];
    const inactive = [...traded, ...dataRows].filter((r) => r.active === false).map((r) => r.stream_id);
    if (inactive.length) {
      return createResponse(400, {
        message: `Streams ${[...new Set(inactive)].join(', ')} are not active, so no shard would collect them`,
      });
    }
    if (leaseStreams.length > MAX_LEASE_STREAMS) {
      return createResponse(400, {
        message: `A paper session reads at most ${MAX_LEASE_STREAMS} streams; this one needs ${leaseStreams.length}`,
      });
    }
    // Before the session is recorded, so a missing API URL or key refuses the launch instead of failing a session.
    try {
      marketData = await resolveMarketDataApi();
    } catch (e) {
      throw new Error(`Market-data API unavailable for leasing streams: ${(e as Error).message}`);
    }
  } else {
    delete s.config.simulation;
  }

  const region = s.region ?? resolveRegion(exchanges);
  const network = await discoverNetworkConfig(region);
  const subnet = s.availabilityZone
    ? network.subnets.find(n => n.availabilityZone === s.availabilityZone)
    : network.subnets[0];
  if (!subnet) {
    return createResponse(400, {
      message: `No platform network subnet in ${s.availabilityZone}; available: ${network.subnets.map(n => n.availabilityZone).join(', ')}`,
    });
  }

  const isPython = String(s.config['strategy.type'] ?? '') === 'python';
  // Java sessions need gnomepy too: the instance reads the JVM flags from it, so both strategy types launch the
  // JVM identically.
  const gnomepyVersion = s.gnomepyVersion || await resolveLatestGnomepyVersion();
  const imageId = await getParameter(region, amiParameterName(profile, instanceType));

  const userData = buildUserData(
    buildSessionEnvironment(s, { orchestratorVersion, gnomepyVersion }, await resolveAlertsApiUrl(), marketData?.url));
  if (Buffer.byteLength(userData) > MAX_USER_DATA_BYTES) {
    return createResponse(400, { message: `Session config too large for EC2 user data (${Buffer.byteLength(userData)} bytes)` });
  }

  // The row exists before the instance does, so an instance can never be running without a session to stop it.
  // A refusal is passed back as is: a 409 names the session already holding one of these listings, a 422 the venue
  // account or risk policy a live session lacks.
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
  if (created.status >= 400 && created.status < 500) {
    return createResponse(created.status, created.body);
  }
  if (created.status < 200 || created.status >= 300) {
    throw new Error(`Registry POST /strategy-sessions failed (${created.status}): ${JSON.stringify(created.body)}`);
  }

  // After the session row, so the reconciler can always find the session a lease belongs to (it releases those of
  // ended sessions), and before the instance, which waits on these streams.
  if (marketData) {
    try {
      await createLease(marketData, { sessionId: s.sessionId, streams: leaseStreams, mode: s.mode, region });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markLaunchFailed(s.sessionId, `Market-data lease failed: ${message}`);
      return createResponse(502, { message: `Market-data lease failed: ${message}` });
    }
  }

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
      LaunchTemplate: {
        LaunchTemplateName: s.mode === 'live' ? LIVE_LAUNCH_TEMPLATE_NAME : LAUNCH_TEMPLATE_NAME, Version: '$Latest',
      },
      ImageId: imageId,
      InstanceType: instanceType as any,
      SubnetId: subnet.subnetId,
      SecurityGroupIds: [network.securityGroupId],
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
    await markLaunchFailed(s.sessionId, `Launch failed: ${message}`);
    if (marketData) await releaseLease(s.sessionId);
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

const eventBridge = new EventBridgeClient({});

async function alertStopWithoutKill(session: any, actor: string, error: string): Promise<void> {
  const alert: AlertEvent = {
    action: 'FIRING', key: `STOP_WITHOUT_KILL:${session.session_id}`, type: 'STOP_WITHOUT_KILL', source: 'ingest',
    title: `Session ${session.session_id} stopped without its kill switch`,
    body: `The halt failed (${error}), so orders it had resting may still be on the venue`,
    actor, sessionId: session.session_id, strategyId: session.strategy_id, mode: session.mode,
    stateAt: new Date().toISOString(),
  };
  try {
    await eventBridge.send(new PutEventsCommand({ Entries: [{
      EventBusName: ALERT_BUS_NAME, Source: ALERT_EVENT_SOURCE, DetailType: ALERT_DETAIL_TYPE, Detail: JSON.stringify(alert),
    }] }));
  } catch (alertError) {
    console.error(`Couldn't raise STOP_WITHOUT_KILL for ${session.session_id}`, alertError);
  }
}

async function handleStop(event: APIGatewayProxyEvent) {
  const body = event.body;
  if (!body) return createResponse(400, { message: 'Missing body' });

  const { sessionId, stopGraceMs, actor: requestedActor, reason: requestedReason } = JSON.parse(body) as {
    sessionId: string;
    stopGraceMs?: number;
    actor?: unknown;
    reason?: unknown;
  };
  const reason = typeof requestedReason === 'string' && requestedReason.trim() ? requestedReason.trim() : undefined;
  // A person's identity comes only from their token, never the body, so nobody can stop as someone else. Only
  // API-key callers (services) have no token, and they say who they are in `actor`.
  const authorizer = event.requestContext?.authorizer;
  const tokenActor: string | undefined = authorizer?.kind === 'service' ? undefined : authorizer?.actor;
  const actor = tokenActor
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
    stoppedBy: actor,
    ...(reason ? { stopReason: reason } : {}),
    expectedStatus: [...ACTIVE_STATUSES, 'STOPPING'],
  }, { sessionId });
  if (stopping.status === 409) {
    // Already STOPPED or FAILED. Its kill may have been released when the instance terminated, and a fresh one
    // would then never be released, so only make sure the instance (and its lease) are gone.
    await Promise.all([terminateInstance(session), releaseSessionLease(session)]);
    return createResponse(409, stopping.body);
  }
  if (stopping.status !== 200) {
    throw new Error(`Registry PATCH /strategy-sessions failed (${stopping.status}): ${JSON.stringify(stopping.body)}`);
  }
  // Alongside the kill and the grace wait rather than after them, so it costs the stop no time. Releasing before the
  // instance is gone is safe: shards keep publishing a released lease's streams for five minutes (the reconciler's
  // lease retire grace), long enough for the session to wind down.
  const leaseReleased = releaseSessionLease(session);

  // Kill first so the OMS stops trading and cancels resting orders while the instance is still alive to do it;
  // terminating outright would leave whatever was resting on the venue. This lambda runs outside the VPC with
  // no DB access, so the kill goes through the registry's halt endpoint, attributed to the operator.
  let killed = false;
  try {
    // Only this session: a stop must not halt other running sessions of the same strategy.
    await registryFetch('/risk/halts', 'POST', {
      sessionId,
      reason: reason ? `${STOP_KILL_REASON}: ${reason}` : STOP_KILL_REASON,
      actor,
    });
    killed = true;
  } catch (error) {
    // A stop must never get stuck behind the kill, so the instance is terminated regardless.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Kill switch upsert failed for session ${sessionId}, terminating anyway:`, message);
    // Terminating without the kill leaves whatever the session had resting on the venue to its own shutdown.
    if (session.instance_id) await alertStopWithoutKill(session, actor, message);
  }

  if (killed && session.instance_id) {
    await sleep(clampStopGraceMs(stopGraceMs));
  }

  // A session with an instance stays STOPPING until the session monitor sees that instance terminated: only then is
  // the orchestrator (and its final ledger writes) certainly gone, so only then may its listings be released. A
  // session that never got an instance has nothing to wait for.
  if (session.instance_id) {
    await terminateInstance(session);
    await leaseReleased;
    return createResponse(200, { ...session, status: 'STOPPING' });
  }
  const stopped = await registryRequest('/strategy-sessions', 'PATCH', {
    status: 'STOPPED',
    stoppedAt: new Date().toISOString(),
    expectedStatus: ['STOPPING'],
  }, { sessionId });
  await leaseReleased;
  if (stopped.status !== 200 && stopped.status !== 409) {
    throw new Error(`Registry PATCH /strategy-sessions failed (${stopped.status}): ${JSON.stringify(stopped.body)}`);
  }
  return createResponse(stopped.status, stopped.body);
}

// Only paper sessions lease streams: live sessions still open their own feeds.
function releaseSessionLease(session: { session_id: string; mode?: string }): Promise<void> {
  return session.mode === 'paper' ? releaseLease(session.session_id) : Promise.resolve();
}

async function terminateInstance(session: { instance_id?: string | null; launch_region?: string | null }) {
  if (session.instance_id && session.launch_region) {
    await new EC2Client({ region: session.launch_region }).send(new TerminateInstancesCommand({
      InstanceIds: [session.instance_id],
    }));
  }
}

// A FAILED session may never have had stopped_at set. The grace period covers the instance's shutdown output, which
// it writes after the session is marked ended.
function logsEndTime(session: { status: string; stopped_at?: string | null; date_modified?: string | null }): number {
  if (!ENDED_SESSION_STATUSES.includes(session.status)) return Date.now();
  const endedAt = session.stopped_at ?? session.date_modified;
  if (!endedAt) return Date.now();
  return Math.min(Date.parse(endedAt) + ENDED_SESSION_LOGS_GRACE_MS, Date.now());
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
    // With no startTime the stream's newest events are returned, so an ended session shows how it ended rather than
    // an empty window around now.
    const response = await logsClient.send(new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      endTime: logsEndTime(sessions[0]),
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
