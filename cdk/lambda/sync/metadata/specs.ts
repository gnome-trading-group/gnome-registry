import { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { RefreshRequest } from '../../endpoints/listing-spec-refresh';
import { PriceBand, validatePriceBands } from '../../endpoints/price-bands';
import { readHyperliquidSpecs } from '../venues/hyperliquid';
import { readLighterSpecs } from '../venues/lighter';
import { registryFetch, registryFetchAll, resolveApiKey } from '../registry-client';
import { readKalshiChangedSpecs, readKalshiSpecs } from '../venues/kalshi';
import { readPolymarketIntlSpecs } from '../venues/polymarket-intl';
import { readPolymarketUsSpecs } from '../venues/polymarket-us';
import { Counts, Kind, Mode, runScheduled, RunRequest, s3Snapshots, Snapshots } from './kind';
import { hashOf } from './snapshot';
import { chunks, pause, ReadChangedSpecs, ReadSpecs, sameSpec, VenueSpec } from '../venues/specs';

// The one writer of listing specs (sm.listing_spec): each venue's reader says what the venue publishes for a listing
// now, and a listing whose spec differs gets a new row. A listing's first spec holds since the epoch; a later change is
// dated when it was seen: now for a scheduled pass, or when a shard saw the venue announce it (a refresh). Three ways in:
// - mode `new` (every minute): active listings created in the last NEW_LISTING_WINDOW_MS with no spec yet, so a new
//   listing is tradable within a minute and one its venue doesn't list yet is tried again each minute meanwhile;
// - mode `reconcile` (hourly, one run per venue): every active listing the venue lists as trading, against its spec
//   in force now; it also rebuilds the venue's snapshot (what the venue gave for each active listing);
// - mode `sweep` (every 15 minutes, one run per venue): reads the venue for the snapshot's listings and the ones
//   created since, and checks against the registry only the listings whose venue spec moved (with no snapshot yet,
//   it reconciles first, which makes one);
// - mode `missing` (daily, one run per venue): active listings older than that window still without a spec;
// - the refresh queue: one listing a shard saw change (POST /listing-specs/refresh), checked against the venue.
// Only the minute's pass runs every minute, and it reads only recent listings; the passes over every active listing
// page through them with a pause between pages, so they never take the registry's database from its other readers.
// A venue that fails doesn't stop the others, but fails the run, so its alarm fires.

export const READERS: Record<string, ReadSpecs> = {
  KALSHI: readKalshiSpecs,
  POLYMARKET_INTL: readPolymarketIntlSpecs,
  POLYMARKET_US: readPolymarketUsSpecs,
  HYPERLIQUID: readHyperliquidSpecs,
  LIGHTER: readLighterSpecs,
};

// Venues that can say which of their markets changed since a time. A sweep reads it beside its full read and counts
// the moves it would have missed, before it replaces the full read.
export const CHANGE_READERS: Record<string, ReadChangedSpecs> = {
  KALSHI: readKalshiChangedSpecs,
};

const POST_CHUNK = 200;
// Long enough that a listing whose venue is slow to list it gets many tries before the daily pass is its backstop.
export const NEW_LISTING_WINDOW_MS = 2 * 60 * 60_000;
// A listing is dated when its insert starts, so one committed a moment after a sweep looked can carry an earlier date.
const LISTED_OVERLAP_MS = 5 * 60_000;
const CONFIRM_CHUNK = 200;

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
  // Active listings with no spec, created in [after, before).
  unspeccedTargets(exchangeId: number, created: { after?: Date; before?: Date }): Promise<Target[]>;
  // Active listings created since `after`.
  createdListings(exchangeId: number, after: Date): Promise<Omit<Target, 'current'>[]>;
  // The specs in force now of these listings; one with none is left out.
  currentSpecs(listingIds: number[]): Promise<Map<number, VenueSpec>>;
  target(exchangeId: number, exchangeSecurityId: string): Promise<Target | null>;
  post(rows: SpecRow[]): Promise<Posted>;
}

export interface Posted {
  written: number;
  refused: number[];
}

/** A venue's active listings and what the venue last gave for each, so a sweep reads the registry only for changes. */
export interface SpecSnapshot {
  // Active listings created before this are in `listings`; a sweep adds the ones created since.
  listedThrough: string;
  // listing id → [its exchange security id, the hash of the spec its venue last gave, or null: none, or not recorded]
  listings: Record<string, [string, string | null]>;
}

export type SpecSnapshots = Snapshots<SpecSnapshot>;

export function specOf(row: SpecResponse): VenueSpec {
  return {
    priceBands: row.price_bands,
    lotSize: Number(row.lot_size),
    minNotional: Number(row.min_notional),
    minSize: Number(row.min_size),
    contractMultiplier: Number(row.contract_multiplier),
  };
}

const PAGE = 5000;
const PAUSE_BETWEEN_PAGES_MS = 250;

// Every row a listing-keyed GET lists, a page at a time after the last listing seen: an offset would read every row
// before it again.
async function pagesByListing<T extends { listing_id: number }>(path: string, apiKey: string): Promise<T[]> {
  let rows: T[] = [];
  for (let after = 0; ;) {
    const page = await registryFetch<T[]>(`${path}&afterListingId=${after}&limit=${PAGE}`, 'GET', apiKey);
    rows = rows.concat(page);
    if (page.length < PAGE) return rows;
    after = page[page.length - 1].listing_id;
    await pause(PAUSE_BETWEEN_PAGES_MS);
  }
}

export function apiRegistry(apiKey: string): Registry {
  return {
    async exchangeIds() {
      const rows = await registryFetchAll<{ exchange_id: number; exchange_code: string }>('/exchanges', apiKey);
      return new Map(rows.map(r => [r.exchange_code, r.exchange_id]));
    },
    async activeTargets(exchangeId) {
      const listings = await pagesByListing<ListingRow>(
        `/listings?exchangeId=${exchangeId}&active=true&sortBy=listing_id`, apiKey);
      const specs = await pagesByListing<SpecResponse>(`/listing-specs?exchangeId=${exchangeId}&activeListings=true`, apiKey);
      const specById = new Map(specs.map(s => [s.listing_id, specOf(s)]));
      return listings.map(l => ({
        listingId: l.listing_id, exchangeSecurityId: l.exchange_security_id, current: specById.get(l.listing_id) ?? null,
      }));
    },
    async unspeccedTargets(exchangeId, created) {
      const window = (created.after ? `&createdAfter=${created.after.toISOString()}` : '')
        + (created.before ? `&createdBefore=${created.before.toISOString()}` : '');
      const listings = await pagesByListing<ListingRow>(
        `/listings?exchangeId=${exchangeId}&active=true&withoutSpec=true&sortBy=listing_id${window}`, apiKey);
      return listings.map(l => ({ listingId: l.listing_id, exchangeSecurityId: l.exchange_security_id, current: null }));
    },
    async createdListings(exchangeId, after) {
      const listings = await pagesByListing<ListingRow>(
        `/listings?exchangeId=${exchangeId}&active=true&sortBy=listing_id&createdAfter=${after.toISOString()}`, apiKey);
      return listings.map(l => ({ listingId: l.listing_id, exchangeSecurityId: l.exchange_security_id }));
    },
    async currentSpecs(listingIds) {
      const specs = new Map<number, VenueSpec>();
      for (const ids of chunks(listingIds, CONFIRM_CHUNK)) {
        const rows = await registryFetch<SpecResponse[]>(`/listing-specs?listingIds=${ids.join(',')}`, 'GET', apiKey);
        for (const row of rows) specs.set(row.listing_id, specOf(row));
      }
      return specs;
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
export async function postInChunks(rows: SpecRow[], send: (body: SpecRow[] | SpecRow) => Promise<unknown>): Promise<Posted> {
  const result: Posted = { written: 0, refused: [] };
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
        result.refused.push(row.listingId);
        console.error(`Spec for listing ${row.listingId} was refused:`, error instanceof Error ? error.message : error);
      }
    }
  }
  return result;
}

// ----- passes -----

export interface VenueResult {
  venue: string;
  targets: number;
  // Of the targets: listings whose venue spec moved since the last read (a sweep reads the registry only for these).
  moved?: number;
  unchanged?: number;
  unknown?: number;
  invalid?: number;
  written?: number;
  failed?: number;
  // A sweep whose snapshot another run saved first: its reads are dropped, and the next sweep does them again.
  snapshotSaved?: boolean;
  // A sweep that found no snapshot and reconciled instead, to make one.
  noSnapshot?: boolean;
  // With a changed-since read: how many listings it named, and how many listings that moved (with a spec recorded
  // before) it didn't name.
  changedRead?: number;
  changedMissed?: number;
  seconds?: number;
}

function result(venue: string, targets: number, plan: Plan, posted: Posted, started: number): VenueResult {
  return {
    venue, targets, unchanged: plan.unchanged, unknown: plan.unknown, invalid: plan.invalid,
    written: posted.written, failed: posted.refused.length, seconds: Math.round((Date.now() - started) / 1000),
  };
}

// Each listing without a spec belongs to exactly one of `new` and `missing`, by when it was created, so no two passes
// race to give it a first spec (the second would be refused): `reconcile` and `sweep` leave them all to those two.
async function firstSpecs(
  exchangeCode: string, exchangeId: number, mode: 'new' | 'missing', registry: Registry, now: Date, read: ReadSpecs,
): Promise<VenueResult> {
  const windowStart = new Date(now.getTime() - NEW_LISTING_WINDOW_MS);
  const targets = await registry.unspeccedTargets(exchangeId, mode === 'new' ? { after: windowStart } : { before: windowStart });
  if (targets.length === 0) return { venue: exchangeCode, targets: 0 };
  const started = Date.now();
  const plan = planSpecs(targets, await read(targets.map(t => t.exchangeSecurityId), { listedOnly: false }), now);
  return result(exchangeCode, targets.length, plan, await registry.post(plan.rows), started);
}

/** What the venue gave for each active listing, with none recorded where the registry refused the write. */
export function snapshotOf(active: Omit<Target, 'current'>[], read: Map<string, VenueSpec>, refused: number[],
  listedThrough: Date): SpecSnapshot {
  const unrecorded = new Set(refused);
  const listings: SpecSnapshot['listings'] = {};
  for (const { listingId, exchangeSecurityId } of active) {
    const spec = read.get(exchangeSecurityId);
    listings[listingId] = [exchangeSecurityId, spec && !unrecorded.has(listingId) ? hashOf(spec) : null];
  }
  return { listedThrough: listedThrough.toISOString(), listings };
}

async function fullPass(
  exchangeCode: string, exchangeId: number, registry: Registry, now: Date, read: ReadSpecs, snapshots: SpecSnapshots,
): Promise<VenueResult> {
  const active = await registry.activeTargets(exchangeId);
  const targets = active.filter(t => t.current !== null);
  const started = Date.now();
  const specs = targets.length > 0
    ? await read(targets.map(t => t.exchangeSecurityId), { listedOnly: true })
    : new Map<string, VenueSpec>();
  const plan = planSpecs(targets, specs, now);
  const posted = await registry.post(plan.rows);
  // Rebuilt from every active listing, so it also drops the ones no longer active; a sweep saving meanwhile only
  // loses work the next sweep redoes.
  await snapshots({ venue: exchangeCode }).replace(snapshotOf(active, specs, posted.refused, now));
  return result(exchangeCode, targets.length, plan, posted, started);
}

async function sweep(
  exchangeCode: string, exchangeId: number, registry: Registry, now: Date, read: ReadSpecs, snapshots: SpecSnapshots,
  readChanged?: ReadChangedSpecs,
): Promise<VenueResult> {
  const store = snapshots({ venue: exchangeCode });
  const stored = await store.load();
  if (!stored) {
    console.warn(`Spec sweep for ${exchangeCode}: no snapshot; reconciling to make one`);
    return { ...await fullPass(exchangeCode, exchangeId, registry, now, read, snapshots), noSnapshot: true };
  }
  const { listings } = stored.value;
  const since = new Date(Date.parse(stored.value.listedThrough) - LISTED_OVERLAP_MS);
  for (const { listingId, exchangeSecurityId } of await registry.createdListings(exchangeId, since)) {
    listings[listingId] ??= [exchangeSecurityId, null];
  }
  const entries = Object.entries(listings);
  const started = Date.now();
  const changed = readChanged ? await readChanged(since) : null;
  const specs = await read(entries.map(([, [exchangeSecurityId]]) => exchangeSecurityId), { listedOnly: true });
  const moved = entries.flatMap(([id, [exchangeSecurityId, hash]]) => {
    const spec = specs.get(exchangeSecurityId);
    return spec && hashOf(spec) !== hash ? [{ listingId: Number(id), exchangeSecurityId, recorded: hash !== null }] : [];
  });
  // A listing with nothing recorded yet moved only in the snapshot, not at the venue.
  const missed = changed ? moved.filter(m => m.recorded && !changed.has(m.exchangeSecurityId)) : [];
  if (missed.length > 0) {
    console.warn(`Spec sweep for ${exchangeCode}: the changed-since read missed ${missed.length} moved listings, e.g. `
      + missed.slice(0, 10).map(m => m.exchangeSecurityId).join(', '));
  }
  const current = await registry.currentSpecs(moved.map(m => m.listingId));
  const targets = moved.filter(m => current.has(m.listingId))
    .map(({ listingId, exchangeSecurityId }) => ({ listingId, exchangeSecurityId, current: current.get(listingId)! }));
  const plan = planSpecs(targets, specs, now);
  const posted = await registry.post(plan.rows);
  const refused = new Set(posted.refused);
  for (const { listingId, exchangeSecurityId } of targets) {
    listings[listingId][1] = refused.has(listingId) ? null : hashOf(specs.get(exchangeSecurityId));
  }
  const snapshotSaved = await store.save({ listedThrough: now.toISOString(), listings }, stored.version);
  if (!snapshotSaved) console.warn(`Spec sweep for ${exchangeCode}: another run saved the snapshot first`);
  return {
    ...result(exchangeCode, entries.length, plan, posted, started), moved: moved.length, snapshotSaved,
    ...(changed ? { changedRead: changed.size, changedMissed: missed.length } : {}),
  };
}

export async function syncVenue(
  exchangeCode: string, exchangeId: number, mode: Mode, registry: Registry, now: Date, readers: Record<string, ReadSpecs>,
  snapshots: SpecSnapshots, changeReaders: Record<string, ReadChangedSpecs> = {},
): Promise<VenueResult> {
  const read = readers[exchangeCode];
  switch (mode) {
    case 'new':
    case 'missing': return firstSpecs(exchangeCode, exchangeId, mode, registry, now, read);
    case 'reconcile': return fullPass(exchangeCode, exchangeId, registry, now, read, snapshots);
    case 'sweep': return sweep(exchangeCode, exchangeId, registry, now, read, snapshots, changeReaders[exchangeCode]);
  }
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
  if (posted.refused.length > 0) throw new Error(`The registry refused the spec for ${request.exchangeCode} ${request.exchangeSecurityId}`);
  return posted;
}

// ----- the Lambda -----

function isSqsEvent(event: unknown): event is SQSEvent {
  return Array.isArray((event as SQSEvent)?.Records);
}

/** A venue's outcome as the counts the harness reports. */
export function countsOf(result: VenueResult): Counts {
  return {
    Listings: result.targets,
    Moved: result.moved ?? 0,
    Written: result.written ?? 0,
    Refused: result.failed ?? 0,
    Unknown: result.unknown ?? 0,
    ...(result.noSnapshot ? { NoSnapshot: 1 } : {}),
    ...(result.changedRead !== undefined ? { ChangedRead: result.changedRead, ChangedMissed: result.changedMissed ?? 0 } : {}),
  };
}

/** Listing specs as a kind of venue metadata: one unit per venue. */
export function specsKind(
  registry: Registry, readers: Record<string, ReadSpecs> = READERS,
  changeReaders: Record<string, ReadChangedSpecs> = CHANGE_READERS,
): Kind<SpecSnapshot> {
  let exchangeIds: Promise<Map<string, number>> | undefined;
  return {
    name: 'specs',
    venues: Object.keys(readers),
    modes: ['new', 'sweep', 'reconcile', 'missing'],
    async run(mode: Mode, unit, ctx) {
      exchangeIds ??= registry.exchangeIds();
      const exchangeId = (await exchangeIds).get(unit.venue);
      if (exchangeId === undefined) throw new Error(`The registry has no exchange ${unit.venue}`);
      return countsOf(await syncVenue(unit.venue, exchangeId, mode, registry, ctx.now, readers, ctx.snapshots, changeReaders));
    },
  };
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

export const handler = async (event: RunRequest | SQSEvent) => {
  const registry = apiRegistry(await resolveApiKey());
  if (isSqsEvent(event)) return refreshes(event, registry);
  const bucket = process.env.CACHE_BUCKET;
  if (!bucket) throw new Error('The specs sync needs CACHE_BUCKET for its snapshots');
  return runScheduled(specsKind(registry), event, { now: new Date(), snapshots: s3Snapshots(bucket, 'specs') });
};
