import { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { RefreshRequest } from '../endpoints/listing-spec-refresh';
import { PriceBand, validatePriceBands } from '../endpoints/price-bands';
import { readHyperliquidSpecs } from './venues/hyperliquid';
import { readLighterSpecs } from './venues/lighter';
import { registryFetch, registryFetchAll, resolveApiKey } from './registry-client';
import { readKalshiSpecs } from './venues/kalshi';
import { readPolymarketIntlSpecs } from './venues/polymarket-intl';
import { readPolymarketUsSpecs } from './venues/polymarket-us';
import { chunks, ReadSpecs, sameSpec, VenueSpec } from './venues/specs';

// The one writer of listing specs (sm.listing_spec): each venue's reader says what the venue publishes for a listing
// now, and a listing whose spec differs gets a new row. A listing's first spec holds since the epoch; a later change is
// dated when it was seen: now for a scheduled pass, or when a shard saw the venue announce it (a refresh). Three ways in:
// - mode `full` (every 15 minutes, one run per venue): every active listing the venue lists as trading, against its
//   spec in force now;
// - mode `missing` (every minute): active listings with no spec yet, so a new listing is tradable within a minute;
// - the refresh queue: one listing a shard saw change (POST /listing-specs/refresh), checked against the venue.
// A venue that fails doesn't stop the others, but fails the run, so its alarm fires.

export const READERS: Record<string, ReadSpecs> = {
  KALSHI: readKalshiSpecs,
  POLYMARKET_INTL: readPolymarketIntlSpecs,
  POLYMARKET_US: readPolymarketUsSpecs,
  HYPERLIQUID: readHyperliquidSpecs,
  LIGHTER: readLighterSpecs,
};

const POST_CHUNK = 200;

export interface Target {
  listingId: number;
  exchangeSecurityId: string;
  current: VenueSpec | null;
}

export interface SpecRow extends VenueSpec {
  listingId: number;
  effectiveFrom?: string;
}

export interface Plan {
  rows: SpecRow[];
  unchanged: number;
  // Listings the venue didn't answer for, and ones it answered with a grid the registry would refuse.
  unknown: number;
  invalid: number;
}

/** The rows to write for these listings given what their venue publishes: a first spec, or a change dated `seenAt`. */
export function planSpecs(targets: Target[], read: Map<string, VenueSpec>, seenAt: Date): Plan {
  const plan: Plan = { rows: [], unchanged: 0, unknown: 0, invalid: 0 };
  for (const target of targets) {
    const spec = read.get(target.exchangeSecurityId);
    if (!spec) {
      plan.unknown++;
      continue;
    }
    try {
      validatePriceBands(spec.priceBands);
    } catch (error) {
      plan.invalid++;
      console.warn(`Listing ${target.listingId} (${target.exchangeSecurityId}) has an invalid grid:`,
        JSON.stringify(spec.priceBands), error instanceof Error ? error.message : error);
      continue;
    }
    if (target.current && sameSpec(target.current, spec)) {
      plan.unchanged++;
      continue;
    }
    plan.rows.push({ listingId: target.listingId, ...spec, ...(target.current ? { effectiveFrom: seenAt.toISOString() } : {}) });
  }
  return plan;
}

// ----- the registry -----

interface ListingRow {
  listing_id: number;
  exchange_security_id: string;
}

interface SpecResponse {
  listing_id: number;
  price_bands: PriceBand[];
  lot_size: string | number;
  min_notional: string | number;
  min_size: string | number;
  contract_multiplier: string | number;
}

export interface Registry {
  exchangeIds(): Promise<Map<string, number>>;
  activeTargets(exchangeId: number): Promise<Target[]>;
  missingTargets(exchangeId: number): Promise<Target[]>;
  target(exchangeId: number, exchangeSecurityId: string): Promise<Target | null>;
  post(rows: SpecRow[]): Promise<{ written: number; failed: number }>;
}

export function specOf(row: SpecResponse): VenueSpec {
  return {
    priceBands: row.price_bands,
    lotSize: Number(row.lot_size),
    minNotional: Number(row.min_notional),
    minSize: Number(row.min_size),
    contractMultiplier: Number(row.contract_multiplier),
  };
}

const SPEC_PAGE = 5000;

// The specs in force of an exchange's active listings, a page at a time after the last listing seen.
async function activeSpecs(exchangeId: number, apiKey: string): Promise<SpecResponse[]> {
  let specs: SpecResponse[] = [];
  for (let after = 0; ;) {
    const page = await registryFetch<SpecResponse[]>(
      `/listing-specs?exchangeId=${exchangeId}&activeListings=true&afterListingId=${after}&limit=${SPEC_PAGE}`, 'GET', apiKey);
    specs = specs.concat(page);
    if (page.length < SPEC_PAGE) return specs;
    after = page[page.length - 1].listing_id;
  }
}

export function apiRegistry(apiKey: string): Registry {
  return {
    async exchangeIds() {
      const rows = await registryFetchAll<{ exchange_id: number; exchange_code: string }>('/exchanges', apiKey);
      return new Map(rows.map(r => [r.exchange_code, r.exchange_id]));
    },
    async activeTargets(exchangeId) {
      const [listings, specs] = await Promise.all([
        registryFetchAll<ListingRow>(`/listings?exchangeId=${exchangeId}&active=true`, apiKey),
        activeSpecs(exchangeId, apiKey),
      ]);
      const specById = new Map(specs.map(s => [s.listing_id, specOf(s)]));
      return listings.map(l => ({
        listingId: l.listing_id, exchangeSecurityId: l.exchange_security_id, current: specById.get(l.listing_id) ?? null,
      }));
    },
    async missingTargets(exchangeId) {
      const listings = await registryFetchAll<ListingRow>(
        `/listings?exchangeId=${exchangeId}&active=true&withoutSpec=true`, apiKey);
      return listings.map(l => ({ listingId: l.listing_id, exchangeSecurityId: l.exchange_security_id, current: null }));
    },
    async target(exchangeId, exchangeSecurityId) {
      const [listing] = await registryFetch<ListingRow[]>(
        `/listings?exchangeId=${exchangeId}&exchangeSecurityId=${encodeURIComponent(exchangeSecurityId)}`, 'GET', apiKey);
      if (!listing) return null;
      const [spec] = await registryFetch<SpecResponse[]>(`/listing-specs?listingId=${listing.listing_id}`, 'GET', apiKey);
      return { listingId: listing.listing_id, exchangeSecurityId, current: spec ? specOf(spec) : null };
    },
    async post(rows) {
      return postInChunks(rows, body => registryFetch('/listing-specs', 'POST', apiKey, body));
    },
  };
}

/** Posts rows a chunk at a time; a chunk the registry refuses goes again row by row, so one bad row costs only itself. */
export async function postInChunks(rows: SpecRow[], send: (body: SpecRow[] | SpecRow) => Promise<unknown>) {
  const result = { written: 0, failed: 0 };
  for (const chunk of chunks(rows, POST_CHUNK)) {
    try {
      await send(chunk);
      result.written += chunk.length;
      continue;
    } catch (error) {
      console.warn(`A chunk of ${chunk.length} specs was refused; posting them one by one:`, error instanceof Error ? error.message : error);
    }
    for (const row of chunk) {
      try {
        await send(row);
        result.written++;
      } catch (error) {
        result.failed++;
        console.error(`Spec for listing ${row.listingId} was refused:`, error instanceof Error ? error.message : error);
      }
    }
  }
  return result;
}

// ----- passes -----

export type Mode = 'full' | 'missing';

export async function syncVenue(
  exchangeCode: string, exchangeId: number, mode: Mode, registry: Registry, now: Date, readers = READERS,
) {
  // A full pass leaves listings with no spec to the missing pass, which may give one its first meanwhile: two first
  // specs would race, and the second is refused.
  const targets = mode === 'full'
    ? (await registry.activeTargets(exchangeId)).filter(t => t.current !== null)
    : await registry.missingTargets(exchangeId);
  if (targets.length === 0) return { venue: exchangeCode, targets: 0 };
  const started = Date.now();
  const read = await readers[exchangeCode](targets.map(t => t.exchangeSecurityId), { listedOnly: mode === 'full' });
  const plan = planSpecs(targets, read, now);
  const posted = await registry.post(plan.rows);
  return {
    venue: exchangeCode, targets: targets.length, unchanged: plan.unchanged, unknown: plan.unknown,
    invalid: plan.invalid, ...posted, seconds: Math.round((Date.now() - started) / 1000),
  };
}

/** Checks one listing a shard saw change against its venue, dating any change when the shard saw it. */
export async function refreshListing(
  request: RefreshRequest, registry: Registry, exchangeIds: Map<string, number>, readers = READERS,
) {
  const exchangeId = exchangeIds.get(request.exchangeCode);
  const read = readers[request.exchangeCode];
  if (exchangeId === undefined || !read) throw new Error(`No spec reader for exchange ${request.exchangeCode}`);
  const target = await registry.target(exchangeId, request.exchangeSecurityId);
  if (!target) {
    console.warn(`Refresh for ${request.exchangeCode} ${request.exchangeSecurityId}: no such listing`);
    return { written: 0 };
  }
  const specs = await read([request.exchangeSecurityId]);
  const spec = specs.get(request.exchangeSecurityId);
  // The venue's API can lag its feed by a moment; leave the message to be read again rather than record the old tick.
  if (request.newTick !== undefined && !spec?.priceBands.some(b => b.step === request.newTick)) {
    throw new Error(`${request.exchangeCode} ${request.exchangeSecurityId} still shows ${JSON.stringify(spec?.priceBands)}, `
      + `not the tick ${request.newTick} its feed announced`);
  }
  const plan = planSpecs([target], specs, new Date(request.observedAt));
  const posted = await registry.post(plan.rows);
  if (posted.failed > 0) throw new Error(`The registry refused the spec for ${request.exchangeCode} ${request.exchangeSecurityId}`);
  return posted;
}

// ----- the Lambda -----

function isSqsEvent(event: unknown): event is SQSEvent {
  return Array.isArray((event as SQSEvent)?.Records);
}

// A full pass runs one venue per invocation, so the slowest venue can't run the others past the Lambda's timeout.
export async function scheduled(mode: Mode, registry: Registry, venue?: string, readers = READERS) {
  const exchangeIds = await registry.exchangeIds();
  const now = new Date();
  const venues = Object.keys(readers).filter(code => exchangeIds.has(code) && (venue === undefined || code === venue));
  const settled = await Promise.allSettled(
    venues.map(code => syncVenue(code, exchangeIds.get(code)!, mode, registry, now, readers)));
  const failed = venues.filter((code, i) => {
    const outcome = settled[i];
    if (outcome.status === 'rejected') {
      console.error(`Spec sync (${mode}) for ${code} failed:`, outcome.reason instanceof Error ? outcome.reason.stack : outcome.reason);
      return true;
    }
    // Refused writes leave specs stale, so they fail the run like a venue that couldn't be read: the alarm fires.
    return 'failed' in outcome.value && outcome.value.failed > 0;
  });
  console.log(`Spec sync (${mode}):`, JSON.stringify(settled.flatMap(s => (s.status === 'fulfilled' ? [s.value] : []))));
  if (failed.length > 0) throw new Error(`Spec sync (${mode}) failed for ${failed.join(', ')}`);
}

export async function refreshes(event: SQSEvent, registry: Registry, readers = READERS): Promise<SQSBatchResponse> {
  const exchangeIds = await registry.exchangeIds();
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  // A FIFO group is one listing's notices, in order: once one fails, the later ones wait for it rather than overtake it.
  const failedGroups = new Set<string>();
  for (const record of event.Records) {
    const group = record.attributes?.MessageGroupId ?? record.messageId;
    if (failedGroups.has(group)) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      const result = await refreshListing(JSON.parse(record.body) as RefreshRequest, registry, exchangeIds, readers);
      console.log(`Spec refresh ${record.body}:`, JSON.stringify(result));
    } catch (error) {
      console.warn(`Spec refresh ${record.body} will be retried:`, error instanceof Error ? error.message : error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      failedGroups.add(group);
    }
  }
  return { batchItemFailures };
}

export const handler = async (event: { mode?: Mode; venue?: string } | SQSEvent) => {
  const registry = apiRegistry(await resolveApiKey());
  if (isSqsEvent(event)) return refreshes(event, registry);
  const { mode, venue } = event;
  if (mode !== 'full' && mode !== 'missing') throw new Error(`Spec sync needs mode full or missing, not ${mode}`);
  if (venue !== undefined && !READERS[venue]) throw new Error(`Spec sync has no reader for venue ${venue}`);
  return scheduled(mode, registry, venue);
};
