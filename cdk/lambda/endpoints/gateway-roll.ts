import { APIGatewayProxyEvent } from 'aws-lambda';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getActor } from './base';
import { RECONCILER_GROUP } from './gateway-reconciler-queue';
import { ROLL_PHASES_UNDER_WAY, rollId } from './gateway-status';
import { createResponse } from './ledger-common';

// An operator asking for a running order gateway to be rolled: stopped without cancelling its orders and started again
// on its host, on the release a fresh start would run (its pin, else the latest). It records the request on the
// gateway's row and wakes gnome-orchestrator's gateway reconciler, which does the roll, refuses it (not running, a
// release that can't hand over, ...) and records how it went in the gateway's roll item. People only, so every roll
// names who asked. Outside the VPC, to read the roll item and reach the reconciler's queue; the row is written through
// this API.

const KEY_PATTERN = /^(live|paper):[a-z0-9_]+:[a-z0-9-]+$/;
const TABLE = 'service-endpoints';
// A request the reconciler hasn't taken up within this long is taken to be lost (it takes each up within a tick, a
// minute), so asking again is allowed.
const UNTAKEN_REQUEST_MS = 5 * 60_000;

export class RollError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface RollRow {
  gateway_key: string;
  roll_requested_at: string | null;
}

export interface RollItem {
  requestedAtMs: number;
  phase: string;
}

export interface RollDeps {
  row(gatewayKey: string): Promise<RollRow | null>;
  rollItem(gatewayKey: string): Promise<RollItem | null>;
  markRollRequested(gatewayKey: string, actor: string): Promise<RollRow>;
  wake(deduplicationId: string): Promise<void>;
  nowMs(): number;
}

/** Records the roll request unless one is already under way or waiting, and wakes the reconciler. */
export async function requestRoll(gatewayKey: string, actor: string, deps: RollDeps) {
  if (!KEY_PATTERN.test(gatewayKey)) {
    throw new RollError(400, `gatewayKey must be a gateway's key, like live:kalshi:main, not ${JSON.stringify(gatewayKey)}`);
  }
  const [row, item] = await Promise.all([deps.row(gatewayKey), deps.rollItem(gatewayKey)]);
  if (!row) throw new RollError(404, `No gateway ${gatewayKey}`);
  if (item && ROLL_PHASES_UNDER_WAY.includes(item.phase)) {
    throw new RollError(409, `${gatewayKey} is already rolling (${item.phase})`);
  }
  const requestedMs = row.roll_requested_at ? Date.parse(row.roll_requested_at) : null;
  if (requestedMs !== null && (!item || item.requestedAtMs < requestedMs)
      && deps.nowMs() - requestedMs < UNTAKEN_REQUEST_MS) {
    throw new RollError(409, `A roll of ${gatewayKey} was asked for at ${row.roll_requested_at} and is about to start`);
  }
  const updated = await deps.markRollRequested(gatewayKey, actor);
  await deps.wake(`roll-${gatewayKey}-${deps.nowMs()}`);
  return { gatewayKey, rollRequestedAt: updated.roll_requested_at, rollRequestedBy: actor };
}

// ----- the Lambda -----

const REGISTRY_API_URL = process.env.REGISTRY_API_URL ?? '';
const REGISTRY_API_KEY_ID = process.env.REGISTRY_API_KEY_ID ?? '';
const RECONCILER_QUEUE_URL = process.env.RECONCILER_QUEUE_URL ?? '';
let cachedApiKey: string | undefined;

async function registryApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const res = await new APIGatewayClient({}).send(new GetApiKeyCommand({ apiKey: REGISTRY_API_KEY_ID, includeValue: true }));
  if (!res.value) throw new Error('Registry API key value not found');
  cachedApiKey = res.value;
  return cachedApiKey;
}

const sqs = new SQSClient({});
const dynamo = new DynamoDBClient({ region: process.env.SERVICE_ENDPOINTS_REGION });

const lambdaDeps: RollDeps = {
  async row(gatewayKey) {
    const res = await fetch(`${REGISTRY_API_URL}gateways?${new URLSearchParams({ gatewayKey })}`, {
      headers: { 'x-api-key': await registryApiKey() },
    });
    if (!res.ok) throw new RollError(502, `Couldn't read gateway ${gatewayKey} (${res.status})`);
    const rows = (await res.json()) as RollRow[];
    return rows[0] ?? null;
  },
  async rollItem(gatewayKey) {
    const res = await dynamo.send(new GetItemCommand({
      TableName: TABLE, Key: { service_id: { S: rollId(gatewayKey) } }, ConsistentRead: true,
    }));
    const item = res.Item;
    if (!item?.phase?.S || !item.requested_at_ms?.N) return null;
    return { requestedAtMs: Number(item.requested_at_ms.N), phase: item.phase.S };
  },
  async markRollRequested(gatewayKey, actor) {
    // Through the API: this Lambda runs outside the VPC, so it can't reach the database itself.
    const res = await fetch(`${REGISTRY_API_URL}gateways?${new URLSearchParams({ gatewayKey })}`, {
      method: 'PATCH',
      headers: { 'x-api-key': await registryApiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rollRequestedBy: actor }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 404) throw new RollError(404, `No gateway ${gatewayKey}`);
    if (!res.ok) throw new RollError(502, `Couldn't record the roll of ${gatewayKey} (${res.status}): ${JSON.stringify(body)}`);
    return body as RollRow;
  },
  async wake(deduplicationId) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: RECONCILER_QUEUE_URL,
      MessageBody: 'wake',
      MessageGroupId: RECONCILER_GROUP,
      MessageDeduplicationId: deduplicationId,
    }));
  },
  nowMs: () => Date.now(),
};

export const handler = async (event: APIGatewayProxyEvent) => {
  let gatewayKey = '';
  try {
    gatewayKey = (JSON.parse(event.body ?? '{}') as { gatewayKey?: unknown }).gatewayKey as string ?? '';
    return createResponse(200, await requestRoll(String(gatewayKey), getActor(event), lambdaDeps));
  } catch (error) {
    if (error instanceof RollError) return createResponse(error.statusCode, { message: error.message });
    if (error instanceof SyntaxError) return createResponse(400, { message: 'Body is not valid JSON' });
    console.error(`Couldn't roll gateway ${gatewayKey}`, error);
    return createResponse(500, { message: `Couldn't ask for a roll of ${gatewayKey}` });
  }
};
