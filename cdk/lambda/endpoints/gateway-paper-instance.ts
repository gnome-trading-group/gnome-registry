import { APIGatewayProxyEvent } from 'aws-lambda';
import { ensureGateway, EnsureError, lambdaDeps as ensureDeps } from './gateway-ensure';
import { endpointId, endpointOf, GatewayEndpoint, GatewayRow, lambdaDeps as statusDeps } from './gateway-status';
import { createResponse } from './ledger-common';

// Which paper gateway a paper session should link to on a venue: a venue runs as many paper gateways as its sessions
// need (paper:<venue>:main, :2, :3, ...), each refusing sessions past its caps (books, the session's listing each, and
// distinct streams). The session asks each time it is about to say hello after its link went down, and the launcher
// asks once so the chosen gateway boots with the session.
//
// - A session still linked to a gateway that is up and is the same process it linked to stays: its books, and the
//   paper orders resting on them, live in that process, so it is kept even when that gateway is now full.
// - Otherwise the lowest-numbered gateway up (or just asked for) with room for all of its listings, so sessions pack
//   onto low instances and high ones empty as sessions end; the gateway reconciler stops an instance nothing wants.
// - Otherwise the next instance, up to MAX_INSTANCES; past that, the least loaded, whose refusal then says it's full.
//
// It marks the chosen gateway wanted (creating a paper row the first time) and wakes the reconciler, as
// /gateways/ensure does; a GET all the same, as sessions read its answer through the registry client, which posts
// nothing that answers, and asking twice changes nothing. Outside the VPC, to read `service-endpoints`; the rows come
// through this API.

const MAX_INSTANCES = Number(process.env.MAX_PAPER_INSTANCES ?? '8');
// A gateway asked for this recently and not yet up counts as starting: empty, so the next sessions go to it rather
// than each starting another.
const STARTING_MS = 5 * 60_000;
const UP_STATES = new Set(['READY', 'DEGRADED']);
const EXCHANGE_PATTERN = /^[a-z0-9_]+$/;

export interface PaperInstanceRequest {
  sessionId: string;
  // The venue's exchange code, lower case, as in its gateway keys.
  exchange: string;
  // The session's listings on the venue: a book each, and at most a stream each.
  listings: number;
  // The gateway the session was last linked to, and when that gateway's process started, as its welcome said.
  currentKey?: string | null;
  currentStartedAtMs?: number | null;
}

/** A venue's paper gateway as the choice sees it. */
export interface Instance {
  gatewayKey: string;
  // `main` is 1; `:2` is 2 and so on.
  number: number;
  endpoint: GatewayEndpoint | null;
  wantedAtMs: number | null;
}

export class PaperInstanceError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function instanceNumber(gatewayKey: string): number | null {
  const instance = gatewayKey.split(':')[2];
  if (instance === 'main') return 1;
  return /^[1-9][0-9]*$/.test(instance ?? '') ? Number(instance) : null;
}

export function instanceKey(exchange: string, number: number): string {
  return `paper:${exchange}:${number === 1 ? 'main' : number}`;
}

function up(instance: Instance): boolean {
  return instance.endpoint !== null && UP_STATES.has(instance.endpoint.state);
}

function starting(instance: Instance, nowMs: number): boolean {
  return !up(instance) && instance.wantedAtMs !== null && nowMs - instance.wantedAtMs < STARTING_MS;
}

function fits(instance: Instance, listings: number): boolean {
  const paper = instance.endpoint?.paper;
  // A release that doesn't say its load also doesn't refuse: it takes everyone, as one gateway per venue always did.
  if (!paper) return true;
  return paper.books + listings <= paper.maxBooks && paper.streams + listings <= paper.maxStreams;
}

function fill(instance: Instance): number {
  const paper = instance.endpoint?.paper;
  if (!paper) return 0;
  return Math.max(paper.books / Math.max(1, paper.maxBooks), paper.streams / Math.max(1, paper.maxStreams));
}

/** The gateway the session should link to, from the venue's paper gateways as they stand. */
export function choosePaperInstance(
  request: PaperInstanceRequest, instances: Instance[], nowMs: number, maxInstances = MAX_INSTANCES,
): string {
  const byNumber = [...instances].sort((a, b) => a.number - b.number);
  const current = byNumber.find((i) => i.gatewayKey === request.currentKey);
  if (current && up(current) && request.currentStartedAtMs
    && current.endpoint?.startedAt && Date.parse(current.endpoint.startedAt) === request.currentStartedAtMs) {
    return current.gatewayKey;
  }
  const running = byNumber.filter((i) => up(i) || starting(i, nowMs));
  const roomy = running.find((i) => starting(i, nowMs) || fits(i, request.listings));
  if (roomy) return roomy.gatewayKey;
  if (running.length < maxInstances) {
    const taken = new Set(running.map((i) => i.number));
    let number = 1;
    while (taken.has(number)) number++;
    return instanceKey(request.exchange, number);
  }
  return running.reduce((least, i) => (fill(i) < fill(least) ? i : least)).gatewayKey;
}

const WHOLE = /^[0-9]+$/;

/** {@code sessionId}, {@code exchange}, {@code listings}, and optionally {@code currentKey}, {@code currentStartedAtMs}. */
export function parseRequest(params: Record<string, string | undefined> | null): PaperInstanceRequest {
  const sessionId = params?.sessionId ?? '';
  const exchange = params?.exchange ?? '';
  const listings = params?.listings ?? '';
  const startedAt = params?.currentStartedAtMs ?? '';
  if (!sessionId) throw new PaperInstanceError(400, 'sessionId is required');
  if (!EXCHANGE_PATTERN.test(exchange)) {
    throw new PaperInstanceError(400, `exchange must be an exchange code in lower case, not ${JSON.stringify(exchange)}`);
  }
  if (!WHOLE.test(listings)) {
    throw new PaperInstanceError(400, 'listings must be a whole number, the session\'s listings on the venue');
  }
  if (startedAt && !WHOLE.test(startedAt)) {
    throw new PaperInstanceError(400, 'currentStartedAtMs must be epoch milliseconds');
  }
  return {
    sessionId,
    exchange,
    listings: Number(listings),
    currentKey: params?.currentKey || null,
    currentStartedAtMs: startedAt ? Number(startedAt) : null,
  };
}

export interface PaperInstanceDeps {
  rows(): Promise<GatewayRow[]>;
  endpoints(gatewayKeys: string[]): Promise<Map<string, GatewayEndpoint | null>>;
  ensure(gatewayKey: string): Promise<void>;
  nowMs(): number;
}

/** Chooses the session's paper gateway on the venue and asks for it. */
export async function resolvePaperInstance(
  request: PaperInstanceRequest, deps: PaperInstanceDeps, maxInstances = MAX_INSTANCES,
): Promise<{ gatewayKey: string }> {
  const prefix = `paper:${request.exchange}:`;
  const rows = (await deps.rows()).filter((row) => row.mode === 'paper' && row.gateway_key.startsWith(prefix));
  const endpoints = rows.length ? await deps.endpoints(rows.map((row) => row.gateway_key)) : new Map();
  const instances: Instance[] = [];
  for (const row of rows) {
    const number = instanceNumber(row.gateway_key);
    if (number === null) continue;
    instances.push({
      gatewayKey: row.gateway_key,
      number,
      endpoint: endpoints.get(row.gateway_key) ?? null,
      wantedAtMs: row.wanted_at ? Date.parse(row.wanted_at) : null,
    });
  }
  const gatewayKey = choosePaperInstance(request, instances, deps.nowMs(), maxInstances);
  await deps.ensure(gatewayKey);
  return { gatewayKey };
}

// ----- the Lambda -----

const lambdaDeps: PaperInstanceDeps = {
  rows: () => statusDeps.rows(),
  async endpoints(gatewayKeys) {
    const items = await statusDeps.items(gatewayKeys.map(endpointId));
    const nowMs = Date.now();
    return new Map(gatewayKeys.map((key) => [key, endpointOf(items.get(endpointId(key)), nowMs)]));
  },
  async ensure(gatewayKey) {
    await ensureGateway(gatewayKey, ensureDeps);
  },
  nowMs: () => Date.now(),
};

export const handler = async (event: APIGatewayProxyEvent) => {
  try {
    const request = parseRequest(event.queryStringParameters);
    return createResponse(200, await resolvePaperInstance(request, lambdaDeps));
  } catch (error) {
    if (error instanceof PaperInstanceError || error instanceof EnsureError) {
      return createResponse(error.statusCode, { message: error.message });
    }
    console.error('Couldn\'t choose a paper gateway', error);
    return createResponse(500, { message: 'Couldn\'t choose a paper gateway' });
  }
};
