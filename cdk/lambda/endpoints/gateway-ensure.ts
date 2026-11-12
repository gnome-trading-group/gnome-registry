import { APIGatewayProxyEvent } from 'aws-lambda';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { RECONCILER_GROUP } from './gateway-reconciler-queue';
import { createResponse } from './ledger-common';

// A session wanting an order gateway, live or paper: the launcher for each venue a session trades, the session itself
// every 10 s while it waits for its gateway and every minute once linked. It records that on the gateway's row
// (wanted_at; a paper gateway's row is created then if it is the first time, by the gateways route) and wakes the
// gateway reconciler, the only thing that starts and stops gateways (gnome-orchestrator's), so it starts a stopped one
// in seconds rather than at its next minute's tick. It touches nothing in ECS or EC2 itself.

const KEY_PATTERN = /^(live|paper):[a-z0-9_]+:[a-z0-9-]+$/;
// Wake-ups within this long of each other are one: the queue drops a message with a deduplication id it has seen.
const WAKE_BUCKET_MS = 5_000;

export class EnsureError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface EnsureDeps {
  markWanted(gatewayKey: string): Promise<{ mode: string }>;
  wake(deduplicationId: string): Promise<void>;
  nowMs(): number;
}

/** Records that the gateway is wanted and wakes the reconciler. */
export async function ensureGateway(gatewayKey: string, deps: EnsureDeps): Promise<{ gatewayKey: string; wanted: true }> {
  const kind = KEY_PATTERN.exec(gatewayKey)?.[1];
  if (!kind) {
    throw new EnsureError(400,
      `gatewayKey must be a gateway's key, like live:kalshi:main or paper:kalshi:main, not ${JSON.stringify(gatewayKey)}`);
  }
  const row = await deps.markWanted(gatewayKey);
  if (row.mode !== kind) throw new EnsureError(400, `${gatewayKey} isn't a ${kind} gateway`);
  await deps.wake(`wake-${Math.floor(deps.nowMs() / WAKE_BUCKET_MS)}`);
  return { gatewayKey, wanted: true };
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

const lambdaDeps: EnsureDeps = {
  async markWanted(gatewayKey) {
    // Through the API: this Lambda runs outside the VPC to reach the queue, so it can't reach the database itself.
    const res = await fetch(`${REGISTRY_API_URL}gateways?${new URLSearchParams({ gatewayKey })}`, {
      method: 'PATCH',
      headers: { 'x-api-key': await registryApiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ wanted: true }),
    });
    const body = await res.json().catch(() => null);
    // A live gateway without a row, or a paper one on an exchange that doesn't exist.
    if (res.status === 404) throw new EnsureError(404, `No gateway ${gatewayKey}`);
    if (!res.ok) throw new EnsureError(502, `Couldn't mark ${gatewayKey} wanted (${res.status}): ${JSON.stringify(body)}`);
    return body as { mode: string };
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
  const gatewayKey = event.queryStringParameters?.gatewayKey ?? '';
  try {
    return createResponse(200, await ensureGateway(gatewayKey, lambdaDeps));
  } catch (error) {
    if (error instanceof EnsureError) return createResponse(error.statusCode, { message: error.message });
    console.error(`Couldn't ensure gateway ${gatewayKey}`, error);
    return createResponse(500, { message: `Couldn't ask for gateway ${gatewayKey}` });
  }
};
