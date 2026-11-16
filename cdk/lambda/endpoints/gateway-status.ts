import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { AttributeValue, BatchGetItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createResponse } from './ledger-common';

// Every order gateway as it stands, for the controller: its registry row (what is wanted of it), its endpoint item in
// gnome-orchestrator's `service-endpoints` table (what it says of itself every 15 s: state, linked sessions, working
// orders, release) and its minutes item beside it (its last hour, written each minute: per account what went, waited,
// was refused and each session's share; for a paper gateway its books' lag), and its roll item (the gateway
// reconciler's record of the last roll an operator asked for). With the orchestrator's latest release, so the
// controller can say what a roll would move an unpinned gateway to. Outside the VPC, to reach DynamoDB; the rows come
// through this API.

const TABLE = 'service-endpoints';
// The endpoint's writer refreshes it every 15 s; four missed writes and it is gone, as the reconciler and sessions read it.
const ENDPOINT_FRESH_MS = 60_000;
// BatchGetItem reads at most this many keys a call.
const BATCH = 100;

export interface GatewayRow {
  gateway_key: string;
  mode: string;
  exchange_id: number;
  exchange_code: string | null;
  region: string;
  profile: string;
  orchestrator_version: string | null;
  wanted_at: string | null;
  roll_requested_at: string | null;
  roll_requested_by: string | null;
  accounts: number;
}

export interface GatewayEndpoint {
  state: string;
  instance: string;
  privateIp: string;
  port: number;
  version: string;
  writtenAt: string;
  linkedSessions: number;
  workingOrders: number;
  // Whether its release stops without cancelling when the reconciler rolls it; one that can't cancels everything.
  canHandOver: boolean;
  // Stopping for a roll, its orders left resting for the next process on its host.
  handover: boolean;
  // When its process started, so a restart is told apart from one still running; null from an older release.
  startedAt: string | null;
  // A paper gateway's load against its caps; null for a live one or an older release.
  paper: PaperLoad | null;
}

/** What a paper gateway carries against its caps: books (a session's listing each) and distinct streams. */
export interface PaperLoad {
  books: number;
  streams: number;
  recordsPerSecond: number;
  maxBooks: number;
  maxStreams: number;
}

// The phases a roll goes through; the first three are a roll under way.
export const ROLL_PHASES_UNDER_WAY = ['stopping', 'starting', 'rolling_back'];

export interface GatewayRoll {
  requestedAt: string;
  // stopping | starting | rolling_back | done | rolled_back | failed | refused
  phase: string;
  fromVersion: string | null;
  toVersion: string | null;
  startedAt: string | null;
  endedAt: string | null;
  // What came of it, or why it was refused, in a few words.
  reason: string | null;
}

export interface GatewayStatus {
  gatewayKey: string;
  mode: string;
  exchangeId: number;
  exchangeCode: string | null;
  region: string;
  profile: string;
  pinnedVersion: string | null;
  // What a start, and so a roll, would run: its pin, else the orchestrator's latest release; null if that couldn't be
  // read.
  rollTargetVersion: string | null;
  wantedAt: string | null;
  accounts: number;
  rollRequestedAt: string | null;
  rollRequestedBy: string | null;
  // The last roll the reconciler took up, kept for a day; null if none.
  roll: GatewayRoll | null;
  // Null when it isn't running: no item, or one not written in the last minute.
  endpoint: GatewayEndpoint | null;
  // Its last hour as the gateway wrote it, or null if it has written none in the last 10 minutes.
  minutes: unknown | null;
}

type Item = Record<string, AttributeValue>;

export const endpointId = (gatewayKey: string) => `order-gateway#${gatewayKey}`;
export const minutesId = (gatewayKey: string) => `order-gateway#${gatewayKey}#minutes`;
export const rollId = (gatewayKey: string) => `order-gateway#${gatewayKey}#roll`;

const num = (item: Item, name: string) => Number(item[name]?.N ?? 0);
const str = (item: Item, name: string) => item[name]?.S ?? '';
const optionalStr = (item: Item, name: string) => item[name]?.S ?? null;
const isoOfMs = (item: Item, name: string) => (item[name]?.N ? new Date(Number(item[name].N)).toISOString() : null);
// Written in epoch nanoseconds; milliseconds keep every digit a timestamp needs within a double.
const writtenAtMs = (item: Item) => Number(BigInt(item.written_at_ns?.N ?? '0') / 1_000_000n);

export function endpointOf(item: Item | undefined, nowMs: number): GatewayEndpoint | null {
  if (!item) return null;
  const written = writtenAtMs(item);
  if (nowMs - written > ENDPOINT_FRESH_MS) return null;
  return {
    state: str(item, 'state'),
    instance: str(item, 'instance'),
    privateIp: str(item, 'private_ip'),
    port: num(item, 'port'),
    version: str(item, 'version'),
    writtenAt: new Date(written).toISOString(),
    linkedSessions: num(item, 'linked_sessions'),
    workingOrders: num(item, 'working_orders'),
    canHandOver: item.can_hand_over?.BOOL === true,
    handover: item.handover?.BOOL === true,
    startedAt: isoOfMs(item, 'started_at_ms'),
    paper: item.paper_max_books?.N
      ? {
        books: num(item, 'paper_books'),
        streams: num(item, 'paper_streams'),
        recordsPerSecond: num(item, 'paper_records_per_second'),
        maxBooks: num(item, 'paper_max_books'),
        maxStreams: num(item, 'paper_max_streams'),
      }
      : null,
  };
}

export function rollOf(item: Item | undefined): GatewayRoll | null {
  if (!item?.phase?.S || !item.requested_at_ms?.N) return null;
  return {
    requestedAt: isoOfMs(item, 'requested_at_ms') as string,
    phase: item.phase.S,
    fromVersion: optionalStr(item, 'from_version'),
    toVersion: optionalStr(item, 'to_version'),
    startedAt: isoOfMs(item, 'started_at_ms'),
    endedAt: isoOfMs(item, 'ended_at_ms'),
    reason: optionalStr(item, 'reason'),
  };
}

function minutesOf(item: Item | undefined, nowMs: number): unknown | null {
  // DynamoDB removes an expired item only eventually, so its expiry is checked here too.
  if (!item?.minutes_json?.S || num(item, 'expires_at') * 1000 < nowMs) return null;
  try {
    return JSON.parse(item.minutes_json.S);
  } catch {
    return null;
  }
}

/** Each gateway row with what its two items say, keyed by service id. */
export function gatewayStatuses(
  rows: GatewayRow[], items: Map<string, Item>, latestVersion: string | null, nowMs: number,
): GatewayStatus[] {
  return rows.map((row) => ({
    gatewayKey: row.gateway_key,
    mode: row.mode,
    exchangeId: row.exchange_id,
    exchangeCode: row.exchange_code,
    region: row.region,
    profile: row.profile,
    pinnedVersion: row.orchestrator_version,
    rollTargetVersion: row.orchestrator_version ?? latestVersion,
    wantedAt: row.wanted_at,
    accounts: row.accounts,
    rollRequestedAt: row.roll_requested_at,
    rollRequestedBy: row.roll_requested_by,
    roll: rollOf(items.get(rollId(row.gateway_key))),
    endpoint: endpointOf(items.get(endpointId(row.gateway_key)), nowMs),
    minutes: minutesOf(items.get(minutesId(row.gateway_key)), nowMs),
  }));
}

export interface StatusDeps {
  rows(): Promise<GatewayRow[]>;
  items(ids: string[]): Promise<Map<string, Item>>;
  latestVersion(): Promise<string | null>;
  nowMs(): number;
}

export async function readStatuses(deps: StatusDeps): Promise<GatewayStatus[]> {
  const [rows, latestVersion] = await Promise.all([deps.rows(), deps.latestVersion()]);
  const ids = rows.flatMap((row) => [endpointId(row.gateway_key), minutesId(row.gateway_key), rollId(row.gateway_key)]);
  return gatewayStatuses(rows, ids.length ? await deps.items(ids) : new Map(), latestVersion, deps.nowMs());
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

const dynamo = new DynamoDBClient({ region: process.env.SERVICE_ENDPOINTS_REGION });
// The orchestrator publishes its latest release in the same primary region as the endpoints table.
const ssm = new SSMClient({ region: process.env.SERVICE_ENDPOINTS_REGION });
const LATEST_VERSION_PARAMETER = process.env.LATEST_VERSION_PARAMETER ?? '';

export const lambdaDeps: StatusDeps = {
  async rows() {
    const res = await fetch(`${REGISTRY_API_URL}gateways`, { headers: { 'x-api-key': await registryApiKey() } });
    if (!res.ok) throw new Error(`Couldn't read the gateways (${res.status})`);
    return (await res.json()) as GatewayRow[];
  },
  async items(ids) {
    const found = new Map<string, Item>();
    for (let i = 0; i < ids.length; i += BATCH) {
      let keys: Item[] | undefined = ids.slice(i, i + BATCH).map((id) => ({ service_id: { S: id } }));
      // Unprocessed keys (throttling) are asked for again, as BatchGetItem expects of its caller.
      for (let attempt = 0; keys?.length && attempt < 3; attempt++) {
        const res = await dynamo.send(new BatchGetItemCommand({ RequestItems: { [TABLE]: { Keys: keys } } }));
        for (const item of res.Responses?.[TABLE] ?? []) found.set(item.service_id.S!, item);
        keys = res.UnprocessedKeys?.[TABLE]?.Keys as Item[] | undefined;
      }
    }
    return found;
  },
  async latestVersion() {
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: LATEST_VERSION_PARAMETER }));
      return res.Parameter?.Value ?? null;
    } catch (error) {
      // The page is still worth showing without it; the controller then can't say what a roll moves to.
      console.warn("Couldn't read the orchestrator's latest release", error);
      return null;
    }
  },
  nowMs: () => Date.now(),
};

export const handler = async () => {
  try {
    return createResponse(200, await readStatuses(lambdaDeps));
  } catch (error) {
    console.error("Couldn't read the gateways' status", error);
    return createResponse(500, { message: "Couldn't read the gateways' status" });
  }
};
