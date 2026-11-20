import { registryFetch, resolveApiKey } from '../registry-client';
import { readKalshiIncentivePrograms } from '../venues/kalshi';
import { polymarketIntlUnlistedEnd, readPolymarketIntlIncentivePrograms } from '../venues/polymarket-intl';
import { polymarketUsUnlistedEnd, readPolymarketUsIncentivePrograms } from '../venues/polymarket-us';
import { DAY_MS, IncentiveProgramReading } from '../venues/types';
import { Counts, Kind, Mode, runScheduled, RunRequest, s3Snapshots, Snapshots } from './kind';
import { hashOf } from './snapshot';

// The venues' incentive programs (sm.incentive_program, append-only and point in time; the registry dates each new or
// changed program). Each venue's reader returns what the venue publishes now. Modes:
// - `sweep` (every 15 minutes per venue): compares the read with the venue's snapshot (each program's terms as last
//   written) and posts only the programs that are new or whose terms moved; a program a complete read no longer lists
//   is ended, by the venue's rule, from the terms the snapshot holds. With no snapshot it reconciles first. Kalshi's
//   `payouts` read (daily) also reads the programs it paid lately, so a payout is recorded the day it happens.
// - `reconcile` (daily per venue): posts every program read and ends those the registry holds open that the read no
//   longer lists (paging the registry's open programs), then rebuilds the snapshot: the one pass that reads them all.
//   Kalshi's reconcile reads as its payouts sweep does, so the programs it paid lately are in the snapshot and the
//   payouts sweep posts only the ones whose payout is new.

const POST_CHUNK = 1000;
const OPEN_PAGE = 5000;
// Kalshi's periods last at most 31 days, so a payout comes within this of a program's end.
const KALSHI_PAYOUT_LOOKBACK_MS = 45 * DAY_MS;
// A program ended this long ago can no longer change; its snapshot entry goes.
const SNAPSHOT_KEEP_MS = 60 * DAY_MS;

export type Post = (rows: IncentiveProgramReading[], exchangeCode: string, source: string) => Promise<{ inserted: number; unchanged: number }>;
export type ReadOpen = (exchangeCode: string, endingAfter: Date) => Promise<IncentiveProgramReading[]>;

export interface VenueRead {
  programs: IncentiveProgramReading[];
  // Markets the venue lists but that no longer trade, for a venue whose programs end with their market.
  stopped?: Set<string>;
}

export interface VenueSync {
  read: (now: Date, variant?: string) => Promise<VenueRead>;
  // The read a reconcile makes: one that also returns the programs a variant sweep reads, so the snapshot it rebuilds
  // already holds them and that sweep posts only what changed.
  reconcileVariant?: string;
  // When a program the registry holds as running, which a complete read no longer lists, ended.
  closeUnlisted?: (program: IncentiveProgramReading, now: Date, read: VenueRead) => Date;
}

export const VENUES: Record<string, VenueSync> = {
  KALSHI: {
    reconcileVariant: 'payouts',
    read: async (now, variant) => ({
      programs: await readKalshiIncentivePrograms(
        variant === 'payouts' ? new Date(now.getTime() - KALSHI_PAYOUT_LOOKBACK_MS) : undefined),
    }),
  },
  POLYMARKET_INTL: {
    read: async () => ({ programs: await readPolymarketIntlIncentivePrograms() }),
    closeUnlisted: (_program, now) => polymarketIntlUnlistedEnd(now),
  },
  POLYMARKET_US: {
    read: () => readPolymarketUsIncentivePrograms(),
    closeUnlisted: (program, now, read) => polymarketUsUnlistedEnd(program, now, read.stopped ?? new Set()),
  },
};

/** Terms as the registry compares them: a program is new or changed only when these move. */
export type Terms = Omit<IncentiveProgramReading, 'sourceRef' | 'raw'>;

/**
 * A venue's programs as last written: the hash of each program's terms and, for a venue that ends the programs a read
 * stops listing, the terms themselves, to end it with.
 */
export interface IncentiveSnapshot {
  programs: Record<string, [string, Terms | null]>;
}

export function termsOf(program: IncentiveProgramReading): Terms {
  const { sourceRef: _sourceRef, raw: _raw, ...terms } = program;
  return terms;
}

export const termsHash = (program: IncentiveProgramReading | Terms) => hashOf(termsOf(program as IncentiveProgramReading));

// The open programs the read didn't list, posted again with their last terms and an end. An end already recorded
// that comes sooner stands, so a later run can't push a closed program's end back.
export function unlistedEnded(
  open: IncentiveProgramReading[], read: IncentiveProgramReading[], endOf: (program: IncentiveProgramReading) => Date,
): IncentiveProgramReading[] {
  const listed = new Set(read.map(p => p.venueProgramId));
  return open.filter(p => !listed.has(p.venueProgramId)).flatMap(p => {
    const end = endOf(p);
    return p.periodEnd !== null && Date.parse(p.periodEnd) <= end.getTime() ? [] : [{ ...p, periodEnd: end.toISOString() }];
  });
}

export async function postInChunks(post: Post, rows: IncentiveProgramReading[], exchangeCode: string, source: string) {
  const total = { inserted: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += POST_CHUNK) {
    const result = await post(rows.slice(i, i + POST_CHUNK), exchangeCode, source);
    total.inserted += result.inserted;
    total.unchanged += result.unchanged;
  }
  return total;
}

function asReading(terms: Terms): IncentiveProgramReading {
  return { ...terms, sourceRef: 'registry', raw: null };
}

function snapshotEntry(program: IncentiveProgramReading, keepTerms: boolean): [string, Terms | null] {
  return [termsHash(program), keepTerms ? termsOf(program) : null];
}

// Drops programs ended long enough ago that nothing about them can change.
function pruned(programs: IncentiveSnapshot['programs'], now: Date): IncentiveSnapshot['programs'] {
  const cutoff = now.getTime() - SNAPSHOT_KEEP_MS;
  return Object.fromEntries(Object.entries(programs).filter(([, [, terms]]) =>
    terms === null || terms.periodEnd === null || Date.parse(terms.periodEnd) >= cutoff));
}

export async function reconcile(
  exchangeCode: string, venue: VenueSync, now: Date, post: Post, readOpen: ReadOpen, snapshots: Snapshots<IncentiveSnapshot>,
  variant?: string,
): Promise<Counts> {
  const read = await venue.read(now, variant ?? venue.reconcileVariant);
  const { programs } = read;
  const posted = await postInChunks(post, programs, exchangeCode, 'VENUE_API');
  const keepTerms = venue.closeUnlisted !== undefined;
  const entries: IncentiveSnapshot['programs'] = {};
  for (const program of programs) entries[program.venueProgramId] = snapshotEntry(program, keepTerms);
  let ended = 0;
  const closeUnlisted = venue.closeUnlisted;
  if (closeUnlisted) {
    const open = await readOpen(exchangeCode, now);
    const endings = unlistedEnded(open, programs, p => closeUnlisted(p, now, read));
    const closed = await postInChunks(post, endings, exchangeCode, 'VENUE_API');
    posted.inserted += closed.inserted;
    ended = endings.length;
    for (const program of endings) entries[program.venueProgramId] = snapshotEntry(program, true);
  }
  await snapshots({ venue: exchangeCode }).replace({ programs: pruned(entries, now) });
  return { Read: programs.length, Written: posted.inserted, Unchanged: posted.unchanged, Ended: ended };
}

export async function sweep(
  exchangeCode: string, venue: VenueSync, now: Date, post: Post, readOpen: ReadOpen, snapshots: Snapshots<IncentiveSnapshot>,
  variant?: string,
): Promise<Counts> {
  const store = snapshots({ venue: exchangeCode });
  const stored = await store.load();
  if (!stored) {
    console.warn(`Incentive sweep for ${exchangeCode}: no snapshot; reconciling to make one`);
    return { ...await reconcile(exchangeCode, venue, now, post, readOpen, snapshots, variant), NoSnapshot: 1 };
  }
  const entries = stored.value.programs;
  const read = await venue.read(now, variant);
  const keepTerms = venue.closeUnlisted !== undefined;
  const moved = read.programs.filter(p => entries[p.venueProgramId]?.[0] !== termsHash(p));
  const posted = await postInChunks(post, moved, exchangeCode, 'VENUE_API');
  for (const program of moved) entries[program.venueProgramId] = snapshotEntry(program, keepTerms);
  let ended = 0;
  const closeUnlisted = venue.closeUnlisted;
  if (closeUnlisted) {
    // What the registry holds open, as the snapshot recorded it: no read of the registry's open programs.
    const open = Object.values(entries).flatMap(([, terms]) =>
      terms !== null && (terms.periodEnd === null || Date.parse(terms.periodEnd) > now.getTime()) ? [asReading(terms)] : []);
    const endings = unlistedEnded(open, read.programs, p => closeUnlisted(p, now, read));
    const closed = await postInChunks(post, endings, exchangeCode, 'VENUE_API');
    posted.inserted += closed.inserted;
    ended = endings.length;
    for (const program of endings) entries[program.venueProgramId] = snapshotEntry(program, true);
  }
  const saved = await store.save({ programs: pruned(entries, now) }, stored.version);
  if (!saved) console.warn(`Incentive sweep for ${exchangeCode}: another run saved the snapshot first`);
  return { Read: read.programs.length, Moved: moved.length, Written: posted.inserted, Unchanged: posted.unchanged, Ended: ended };
}

/** Incentive programs as a kind of venue metadata: one unit per venue. */
export function incentivesKind(
  post: Post, readOpen: ReadOpen, venues: Record<string, VenueSync> = VENUES,
): Kind<IncentiveSnapshot> {
  return {
    name: 'incentives',
    venues: Object.keys(venues),
    modes: ['sweep', 'reconcile'],
    variants: ['payouts'],
    async run(mode: Mode, unit, ctx) {
      const venue = venues[unit.venue];
      if (mode === 'reconcile') return reconcile(unit.venue, venue, ctx.now, post, readOpen, ctx.snapshots, ctx.variant);
      return sweep(unit.venue, venue, ctx.now, post, readOpen, ctx.snapshots, ctx.variant);
    },
  };
}

export function registryPost(apiKey: string): Post {
  return (rows, exchangeCode, source) => registryFetch('/incentive-programs', 'POST', apiKey,
    rows.map(r => ({ ...r, exchangeCode, source })));
}

export function registryReadOpen(apiKey: string): ReadOpen {
  return async (exchangeCode, endingAfter) => {
    const open: IncentiveProgramReading[] = [];
    let after: string | null = null;
    do {
      const query: string = `?exchangeCode=${exchangeCode}&endingAfter=${endingAfter.toISOString()}&limit=${OPEN_PAGE}`
        + (after ? `&after=${encodeURIComponent(after)}` : '');
      const page: { programs: (IncentiveProgramReading & { effectiveFrom: string })[]; next: string | null } =
        await registryFetch(`/incentive-programs${query}`, 'GET', apiKey);
      open.push(...page.programs.map(({ effectiveFrom: _, ...p }) => ({ ...p, sourceRef: 'registry', raw: null })));
      after = page.next;
    } while (after);
    return open;
  };
}

export const handler = async (event: RunRequest) => {
  const apiKey = await resolveApiKey();
  const bucket = process.env.CACHE_BUCKET;
  if (!bucket) throw new Error('The incentives sync needs CACHE_BUCKET for its snapshots');
  return runScheduled(incentivesKind(registryPost(apiKey), registryReadOpen(apiKey)), event,
    { now: new Date(), snapshots: s3Snapshots(bucket, 'incentives') });
};
