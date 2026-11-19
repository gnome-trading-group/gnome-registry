import { APIGatewayProxyEvent } from 'aws-lambda';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createHash } from 'crypto';
import { createResponse } from './ledger-common';
import { SPEC_SYNC_EXCHANGES } from './spec-refresh-queue';

// A shard saw a venue announce a listing's new tick (Polymarket Intl's tick_size_change): queue it for the spec sync,
// which reads the venue and records any change dated when the shard saw it. The spec sync is the only spec writer, so
// this records nothing itself. Outside the VPC, to reach the queue.

const MAX_REQUESTS = 50;
const SQS_BATCH = 10;
// A notice from further back than this is a shard replaying old data, not news; one from the future is a bad clock.
const MAX_AGE_MS = 24 * 3_600_000;
const MAX_AHEAD_MS = 5 * 60_000;

export interface RefreshRequest {
  exchangeCode: string;
  exchangeSecurityId: string;
  observedAt: string;
  newTick?: number;
}

export class RefreshError extends Error {}

export function parseRefreshRequests(body: string | null, nowMs: number): RefreshRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    throw new RefreshError('body must be JSON');
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0 || items.length > MAX_REQUESTS) throw new RefreshError(`send 1 to ${MAX_REQUESTS} refreshes`);
  return items.map((item, i) => {
    const { exchangeCode, exchangeSecurityId, observedAt, newTick } = (item ?? {}) as Record<string, unknown>;
    if (typeof exchangeCode !== 'string' || !SPEC_SYNC_EXCHANGES.includes(exchangeCode)) {
      throw new RefreshError(`[${i}] exchangeCode must be one of ${SPEC_SYNC_EXCHANGES.join(', ')}`);
    }
    if (typeof exchangeSecurityId !== 'string' || exchangeSecurityId.length === 0 || exchangeSecurityId.length > 256) {
      throw new RefreshError(`[${i}] needs an exchangeSecurityId`);
    }
    const at = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
    if (!Number.isFinite(at) || at < nowMs - MAX_AGE_MS || at > nowMs + MAX_AHEAD_MS) {
      throw new RefreshError(`[${i}] observedAt must be an ISO time within the last day`);
    }
    if (newTick !== undefined && !(typeof newTick === 'number' && Number.isSafeInteger(newTick) && newTick > 0)) {
      throw new RefreshError(`[${i}] newTick must be a positive whole number of price units`);
    }
    return { exchangeCode, exchangeSecurityId, observedAt: new Date(at).toISOString(), ...(newTick !== undefined ? { newTick } : {}) };
  });
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** One message per listing and notice: a group per listing, and a notice two shards both send goes once. */
export function refreshMessage(request: RefreshRequest, index: number) {
  const listing = `${request.exchangeCode}:${request.exchangeSecurityId}`;
  return {
    Id: String(index),
    MessageBody: JSON.stringify(request),
    MessageGroupId: hash(listing),
    MessageDeduplicationId: hash(`${listing}@${request.observedAt}`),
  };
}

const sqs = new SQSClient({});

export const handler = async (event: APIGatewayProxyEvent) => {
  let requests: RefreshRequest[];
  try {
    requests = parseRefreshRequests(event.body, Date.now());
  } catch (error) {
    if (error instanceof RefreshError) return createResponse(400, { message: error.message });
    throw error;
  }
  const messages = requests.map(refreshMessage);
  for (let i = 0; i < messages.length; i += SQS_BATCH) {
    const result = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: process.env.SPEC_REFRESH_QUEUE_URL, Entries: messages.slice(i, i + SQS_BATCH),
    }));
    if (result.Failed && result.Failed.length > 0) {
      console.error('Spec refreshes the queue refused:', JSON.stringify(result.Failed));
      return createResponse(502, { message: `${result.Failed.length} refreshes couldn't be queued` });
    }
  }
  return createResponse(200, { queued: messages.length });
};
