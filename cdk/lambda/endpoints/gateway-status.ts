import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { AttributeValue, BatchGetItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createResponse } from './ledger-common';

// Every order gateway as it stands, for the controller: its registry row (what is wanted of it), its endpoint item in
// gnome-orchestrator's `service-endpoints` table (what it says of itself every 15 s: state, linked sessions, working
// orders, release) and its minutes item beside it (its last hour, written each minute: per account what went, waited,
// was refused and each session's share; for a paper gateway its books' lag). Outside the VPC, to reach DynamoDB; the
// rows come through this API.

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
}

export interface GatewayStatus {
  gatewayKey: string;
  mode: string;
  exchangeId: number;
  exchangeCode: string | null;
  region: string;
  profile: string;
  pinnedVersion: string | null;
  wantedAt: string | null;
  accounts: number;
  // Null when it isn't running: no item, or one not written in the last minute.
  endpoint: GatewayEndpoint | null;
  // Its last hour as the gateway wrote it, or null if it has written none in the last 10 minutes.
  minutes: unknown | null;
}

type Item = Record<string, AttributeValue>;

export const endpointId = (gatewayKey: string) => `order-gateway#${gatewayKey}`;
export const minutesId = (gatewayKey: string) => `order-gateway#${gatewayKey}#minutes`;

const num = (item: Item, name: string) => Number(item[name]?.N ?? 0);
const str = (item: Item, name: string) => item[name]?.S ?? '';
// Written in epoch nanoseconds; milliseconds keep every digit a timestamp needs within a double.
const writtenAtMs = (item: Item) => Number(BigInt(item.written_at_ns?.N ?? '0') / 1_000_000n);

function endpointOf(item: Item | undefined, nowMs: number): GatewayEndpoint | null {
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
export function gatewayStatuses(rows: GatewayRow[], items: Map<string, Item>, nowMs: number): GatewayStatus[] {
  return rows.map((row) => ({
    gatewayKey: row.gateway_key,
    mode: row.mode,
    exchangeId: row.exchange_id,
    exchangeCode: row.exchange_code,
    region: row.region,
    profile: row.profile,
    pinnedVersion: row.orchestrator_version,
    wantedAt: row.wanted_at,
    accounts: row.accounts,
    endpoint: endpointOf(items.get(endpointId(row.gateway_key)), nowMs),
    minutes: minutesOf(items.get(minutesId(row.gateway_key)), nowMs),
  }));
}

export interface StatusDeps {
  rows(): Promise<GatewayRow[]>;
  items(ids: string[]): Promise<Map<string, Item>>;
  nowMs(): number;
}

export async function readStatuses(deps: StatusDeps): Promise<GatewayStatus[]> {
  const rows = await deps.rows();
  const ids = rows.flatMap((row) => [endpointId(row.gateway_key), minutesId(row.gateway_key)]);
  return gatewayStatuses(rows, ids.length ? await deps.items(ids) : new Map(), deps.nowMs());
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

const lambdaDeps: StatusDeps = {
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
