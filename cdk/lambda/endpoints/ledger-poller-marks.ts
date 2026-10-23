import { PoolClient } from 'pg';
import { isPositiveInt, watchedListing } from './ledger-common';

// The mark poller's route (API key, served by treasury-api.ts). A listing still held once every session on it has
// stopped (a contract held to settlement) gets no marks from an OMS, so the poller reads its book from the venue every
// minute and posts it here. One POST does both halves, as the API stack has no room for a second method:
//   { marks: [{ listingId, bid, ask, lastTrade }] } in price units, possibly none; answers how many were recorded and
//   the listings to price, those held by some strategy, on no running session, and not yet settled

// A quiet book still gets a row this often, so a priced listing never looks stale to the NO_PRICE rule.
export const MARK_HEARTBEAT_MS = 300_000;

export class PollerMarksError extends Error {}

export async function unwatchedListings(client: PoolClient) {
  return (await client.query(`
    SELECT l.listing_id, e.exchange_code, l.exchange_security_id
    FROM sm.listing l
    JOIN sm.exchange e ON e.exchange_id = l.exchange_id
    WHERE l.listing_id IN (SELECT listing_id FROM ledger.position WHERE net_quantity <> 0)
      AND NOT EXISTS (SELECT 1 FROM sm.event_contract ec
        WHERE ec.security_id = l.security_id AND ec.settlement_price IS NOT NULL)
      AND NOT ${watchedListing('l.listing_id')}
    ORDER BY l.listing_id`)).rows;
}

const PRICE = /^\d{1,18}$/;

export function parseMarks(body: string): { listingId: number; bid: string; ask: string; lastTrade: string }[] {
  const marks = (JSON.parse(body) as { marks?: unknown }).marks;
  if (!Array.isArray(marks)) throw new PollerMarksError('marks must be a list');
  return marks.map((m) => {
    const { listingId, bid, ask, lastTrade } = (m ?? {}) as Record<string, unknown>;
    if (!isPositiveInt(listingId)) throw new PollerMarksError('listingId must be a positive integer');
    for (const price of [bid, ask, lastTrade]) {
      if (typeof price !== 'string' || !PRICE.test(price)) throw new PollerMarksError('bid, ask and lastTrade must be price units');
    }
    return { listingId, bid: bid as string, ask: ask as string, lastTrade: lastTrade as string };
  });
}

// A listing a session started on since the poller asked is skipped, so only one writer prices it. A venue that reports
// no trade keeps the last one known, and a reading with no price at all is dropped rather than recorded as unknown,
// which would value the position at its entry.
export async function recordPollerMarks(client: PoolClient, body: string, now: Date) {
  const marks = parseMarks(body);
  const written = (await client.query(`
    WITH incoming AS (
      SELECT DISTINCT ON (m."listingId") m."listingId" AS listing_id, m.bid, m.ask, m."lastTrade" AS last_trade
      FROM jsonb_to_recordset($1::jsonb) AS m("listingId" int, bid bigint, ask bigint, "lastTrade" bigint)
      ORDER BY m."listingId"
    ), priced AS (
      SELECT i.listing_id, i.bid, i.ask,
        CASE WHEN i.last_trade > 0 THEN i.last_trade ELSE COALESCE(prev.last_trade, 0) END AS last_trade,
        prev.ts AS prev_ts, prev.bid AS prev_bid, prev.ask AS prev_ask, prev.last_trade AS prev_last
      FROM incoming i
      JOIN sm.listing l ON l.listing_id = i.listing_id
      LEFT JOIN LATERAL (
        SELECT ts, bid, ask, last_trade FROM ledger.mark m WHERE m.listing_id = i.listing_id ORDER BY ts DESC LIMIT 1
      ) prev ON TRUE
      WHERE NOT ${watchedListing('i.listing_id')}
    )
    INSERT INTO ledger.mark (listing_id, ts, bid, ask, last_trade, source)
    SELECT listing_id, $2, bid, ask, last_trade, 'POLLER' FROM priced
    WHERE (bid > 0 OR ask > 0 OR last_trade > 0)
      AND (prev_ts IS NULL OR (prev_ts < $2 AND (prev_bid <> bid OR prev_ask <> ask OR prev_last <> last_trade
        OR prev_ts <= $2::timestamptz - $3::interval)))
    ON CONFLICT DO NOTHING
    RETURNING listing_id`,
  [JSON.stringify(marks), now, `${MARK_HEARTBEAT_MS} milliseconds`])).rowCount ?? 0;
  return { received: marks.length, written, listings: await unwatchedListings(client) };
}
