import { registryFetch, registryFetchAll, resolveApiKey } from '../registry-client';
import { VenueFeeRead, VenueFeeSchedule } from '../venues/fees';
import { readKalshiFeeSchedules } from '../venues/kalshi';
import { readPolymarketIntlFeeSchedules } from '../venues/polymarket-intl';
import { Counts, Kind, Mode, runScheduled, RunRequest, s3Snapshots, Snapshots } from './kind';
import { hashOf } from './snapshot';

// The venues' fee schedules (sm.fee_schedule, append-only and point in time): each venue's reader turns what it
// publishes into its whole dated history, which is written once, row by row, as it appears. Modes:
// - `sweep` (hourly per venue): reads the venue's history and posts the rows its snapshot (the rows the registry
//   holds) doesn't know. With no snapshot it reconciles first.
// - `reconcile` (daily per venue): reads the registry's venue rows of the exchange, rebuilds the snapshot from them
//   and posts any row of the venue's history still missing; the only read of the registry's rows.
// A row is known by its source_ref where the venue gives every change an id (Kalshi), or by its target and definition
// where it gives only the fee in force (Polymarket International), with its date when the date is the venue's: a row
// dated from when the sync first saw it is the same row whenever it is read. So a target going back to an earlier
// definition on a date the venue gave is a new row; one going back unannounced keeps the later row in force.

const POST_CHUNK = 500;

export interface VenueFees {
  read: (now: Date) => Promise<VenueFeeRead>;
  knownBy: 'sourceRef' | 'definition';
}

export const VENUES: Record<string, VenueFees> = {
  KALSHI: { read: () => readKalshiFeeSchedules(), knownBy: 'sourceRef' },
  POLYMARKET_INTL: { read: now => readPolymarketIntlFeeSchedules(now), knownBy: 'definition' },
};

/** The rows the registry holds for a venue, by the keys `keyOf` gives. */
export interface FeeSnapshot {
  known: string[];
}

type Keyed = Pick<VenueFeeSchedule, 'feeGroup' | 'feeEvent' | 'effectiveFrom' | 'definition' | 'sourceRef' | 'dated'>;

function definitionKey(row: Keyed, withDate: boolean): string {
  const parts = [row.feeGroup ?? '', row.feeEvent ?? '', row.definition === null ? 'none' : hashOf(row.definition)];
  return (withDate ? [...parts, String(Date.parse(row.effectiveFrom))] : parts).join('\u0000');
}

/** The key a row the venue's reader gives is known by. */
export function keyOf(row: Keyed, knownBy: VenueFees['knownBy']): string {
  return knownBy === 'sourceRef' ? row.sourceRef : definitionKey(row, row.dated === true);
}

/** The keys a row the registry holds answers to: it doesn't record whether its date was the venue's, so both. */
export function heldKeys(row: Keyed, knownBy: VenueFees['knownBy']): string[] {
  return knownBy === 'sourceRef' ? [row.sourceRef] : [definitionKey(row, false), definitionKey(row, true)];
}

export interface FeeRegistry {
  exchangeId(exchangeCode: string): Promise<number>;
  /** The schedules venue syncs wrote for the exchange (source VENUE_API). */
  held(exchangeId: number): Promise<Keyed[]>;
  /** Posts schedules; how many it recorded. */
  post(exchangeId: number, rows: VenueFeeSchedule[]): Promise<number>;
}

// Counts every mode reports from the venue's read; `Unreadable` is alarmed: listings keyed to such a type pay the
// exchange default until its schedule can be read.
function readCounts({ schedules, unreadable }: VenueFeeRead): Counts {
  if (unreadable.length > 0) console.warn(`Fee types whose schedule couldn't be read: ${unreadable.join(', ')}`);
  return {
    Read: schedules.length,
    Unsupported: schedules.filter(r => r.sourceRef.includes(':unsupported:')).length,
    Unreadable: unreadable.length,
  };
}

function unknown(rows: VenueFeeSchedule[], known: Set<string>, knownBy: VenueFees['knownBy']): VenueFeeSchedule[] {
  const pending = new Map<string, VenueFeeSchedule>();
  for (const row of rows) {
    const key = keyOf(row, knownBy);
    if (!known.has(key) && !pending.has(key)) pending.set(key, row);
  }
  return [...pending.values()];
}

async function postInChunks(registry: FeeRegistry, exchangeId: number, rows: VenueFeeSchedule[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += POST_CHUNK) written += await registry.post(exchangeId, rows.slice(i, i + POST_CHUNK));
  return written;
}

export async function reconcile(
  exchangeCode: string, venue: VenueFees, now: Date, registry: FeeRegistry, snapshots: Snapshots<FeeSnapshot>,
): Promise<Counts> {
  const exchangeId = await registry.exchangeId(exchangeCode);
  const read = await venue.read(now);
  const rows = read.schedules;
  const held = await registry.held(exchangeId);
  const known = new Set(held.flatMap(r => heldKeys(r, venue.knownBy)));
  const pending = unknown(rows, known, venue.knownBy);
  const written = await postInChunks(registry, exchangeId, pending);
  for (const row of pending) known.add(keyOf(row, venue.knownBy));
  await snapshots({ venue: exchangeCode }).replace({ known: [...known] });
  const given = new Set(rows.map(r => keyOf(r, venue.knownBy)));
  return {
    ...readCounts(read), Held: held.length, Written: written, Known: rows.length - pending.length,
    // Rows the venue's history no longer gives, such as Kalshi event overrides lifted since: kept, never re-read.
    NotRead: held.filter(r => !heldKeys(r, venue.knownBy).some(k => given.has(k))).length,
  };
}

export async function sweep(
  exchangeCode: string, venue: VenueFees, now: Date, registry: FeeRegistry, snapshots: Snapshots<FeeSnapshot>,
): Promise<Counts> {
  const store = snapshots({ venue: exchangeCode });
  const stored = await store.load();
  if (!stored) {
    console.warn(`Fee sweep for ${exchangeCode}: no snapshot; reconciling to make one`);
    return { ...await reconcile(exchangeCode, venue, now, registry, snapshots), NoSnapshot: 1 };
  }
  const read = await venue.read(now);
  const rows = read.schedules;
  const known = new Set(stored.value.known);
  const pending = unknown(rows, known, venue.knownBy);
  const written = pending.length === 0 ? 0 : await postInChunks(registry, await registry.exchangeId(exchangeCode), pending);
  if (pending.length > 0) {
    for (const row of pending) known.add(keyOf(row, venue.knownBy));
    if (!await store.save({ known: [...known] }, stored.version)) {
      console.warn(`Fee sweep for ${exchangeCode}: another run saved the snapshot first`);
    }
  }
  return { ...readCounts(read), Written: written, Known: rows.length - pending.length };
}

/** Fee schedules as a kind of venue metadata: one unit per venue. */
export function feesKind(registry: FeeRegistry, venues: Record<string, VenueFees> = VENUES): Kind<FeeSnapshot> {
  return {
    name: 'fees',
    venues: Object.keys(venues),
    modes: ['sweep', 'reconcile'],
    async run(mode: Mode, unit, ctx) {
      const venue = venues[unit.venue];
      if (mode === 'reconcile') return reconcile(unit.venue, venue, ctx.now, registry, ctx.snapshots);
      return sweep(unit.venue, venue, ctx.now, registry, ctx.snapshots);
    },
  };
}

interface FeeRow {
  effective_from: string;
  fee_group: string | null;
  fee_event: string | null;
  definition: VenueFeeSchedule['definition'];
  source: string;
  source_ref: string | null;
}

export function registryFees(apiKey: string): FeeRegistry {
  let exchanges: Promise<Map<string, number>> | undefined;
  return {
    async exchangeId(exchangeCode) {
      exchanges ??= registryFetchAll<{ exchange_id: number; exchange_code: string }>('/exchanges', apiKey)
        .then(rows => new Map(rows.map(r => [r.exchange_code, r.exchange_id])));
      const id = (await exchanges).get(exchangeCode);
      if (id === undefined) throw new Error(`The registry has no exchange ${exchangeCode}`);
      return id;
    },
    async held(exchangeId) {
      const rows = await registryFetchAll<FeeRow>(`/fees?exchangeId=${exchangeId}`, apiKey);
      return rows.filter(r => r.source === 'VENUE_API' && r.source_ref !== null).map(r => ({
        feeGroup: r.fee_group ?? undefined, feeEvent: r.fee_event ?? undefined, effectiveFrom: r.effective_from,
        definition: r.definition, sourceRef: r.source_ref!,
      }));
    },
    async post(exchangeId, rows) {
      const recorded = await registryFetch<unknown[]>('/fees', 'POST', apiKey,
        rows.map(({ dated: _dated, ...r }) => ({ ...r, exchangeId, source: 'VENUE_API' })));
      return recorded.length;
    },
  };
}

export const handler = async (event: RunRequest) => {
  const apiKey = await resolveApiKey();
  const bucket = process.env.CACHE_BUCKET;
  if (!bucket) throw new Error('The fees sync needs CACHE_BUCKET for its snapshots');
  return runScheduled(feesKind(registryFees(apiKey)), event, { now: new Date(), snapshots: s3Snapshots(bucket, 'fees') });
};
