import { registryFetch, resolveApiKey } from './registry-client';
import { readKalshiIncentivePrograms } from './venues/kalshi';
import { readPolymarketIntlIncentivePrograms } from './venues/polymarket-intl';
import { DAY_MS, IncentiveProgramReading } from './venues/types';

// Records the venues' incentive programs in the registry every 15 minutes: each venue's reader returns what the venue
// publishes now, and the registry keeps what is new or changed. VENUES limits a deployment to some exchange codes. A
// venue that fails doesn't stop the others, but fails the run, so its alarm fires.

const POST_CHUNK = 1000;
const OPEN_PAGE = 5000;
// Kalshi pays around 06:00 ET; the first run after 11:00 UTC sweeps for payouts. Its periods last at most 31 days.
const KALSHI_PAYOUT_HOUR_UTC = 11;
const SCHEDULE_MINUTES = 15;
const KALSHI_PAYOUT_LOOKBACK_MS = 45 * DAY_MS;

export type Post = (rows: IncentiveProgramReading[], exchangeCode: string, source: string) => Promise<{ inserted: number; unchanged: number }>;
export type ReadOpen = (exchangeCode: string, endingAfter: Date) => Promise<IncentiveProgramReading[]>;

interface VenueSync {
  read: (now: Date) => Promise<IncentiveProgramReading[]>;
  // Programs the registry holds as running that a complete read no longer lists, ended as of now.
  closeUnlisted?: (now: Date) => Date;
}

const VENUES: Record<string, VenueSync> = {
  KALSHI: {
    read: (now) => readKalshiIncentivePrograms(isKalshiPayoutRun(now) ? new Date(now.getTime() - KALSHI_PAYOUT_LOOKBACK_MS) : undefined),
  },
  POLYMARKET_INTL: {
    read: () => readPolymarketIntlIncentivePrograms(),
    // Polymarket pays per UTC day and doesn't say whether a part day is paid, so the day it went missing isn't.
    closeUnlisted: (now) => new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS),
  },
};

export function isKalshiPayoutRun(now: Date): boolean {
  return now.getUTCHours() === KALSHI_PAYOUT_HOUR_UTC && now.getUTCMinutes() < SCHEDULE_MINUTES;
}

// The open programs the read didn't list, posted again with their last terms and the given end.
export function unlistedEnded(open: IncentiveProgramReading[], read: IncentiveProgramReading[], end: Date): IncentiveProgramReading[] {
  const listed = new Set(read.map(p => p.venueProgramId));
  return open.filter(p => !listed.has(p.venueProgramId)).map(p => ({ ...p, periodEnd: end.toISOString() }));
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

export async function syncVenue(exchangeCode: string, venue: VenueSync, now: Date, post: Post, readOpen: ReadOpen) {
  const read = await venue.read(now);
  const result = { venue: exchangeCode, read: read.length, ended: 0, ...await postInChunks(post, read, exchangeCode, 'VENUE_API') };
  if (venue.closeUnlisted) {
    const ended = unlistedEnded(await readOpen(exchangeCode, now), read, venue.closeUnlisted(now));
    const closed = await postInChunks(post, ended, exchangeCode, 'VENUE_API');
    result.ended = ended.length;
    result.inserted += closed.inserted;
  }
  return result;
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

export const handler = async () => {
  const apiKey = await resolveApiKey();
  const wanted = (process.env.VENUES ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const now = new Date();
  const results = [];
  const failed: string[] = [];
  for (const [exchangeCode, venue] of Object.entries(VENUES)) {
    if (wanted.length > 0 && !wanted.includes(exchangeCode)) continue;
    try {
      results.push(await syncVenue(exchangeCode, venue, now, registryPost(apiKey), registryReadOpen(apiKey)));
    } catch (error) {
      failed.push(exchangeCode);
      console.error(`Incentive sync for ${exchangeCode} failed:`, error instanceof Error ? error.stack : error);
    }
  }
  console.log('Incentive sync:', JSON.stringify(results));
  if (failed.length) throw new Error(`Incentive sync failed for ${failed.join(', ')}`);
  return results;
};
