import { PoolClient } from 'pg';
import { SPEC_MISSING_AFTER_MS, SPEC_MISSING_WITHIN_MS } from './thresholds';
import { Finding, finding } from './types';

const EXAMPLES = 5;

/**
 * Active listings with no spec past the spec sync's first minutes, one finding per exchange: the OMS refuses every
 * order on them. The spec sync failing for the venue, or the venue not answering for these markets, leaves them so.
 * Only recent listings are looked at: this runs every minute, and checking every active listing would read most of the
 * spec index each time. The spec sync's daily pass gives older ones their first.
 */
export async function listingSpecs(client: PoolClient, now: Date): Promise<Finding[]> {
  const rows = (await client.query(`
    SELECT e.exchange_id, e.exchange_code, count(*)::int AS missing,
      (array_agg(l.exchange_security_symbol ORDER BY l.listing_id))[1:${EXAMPLES}] AS examples,
      min(l.date_created) AT TIME ZONE 'UTC' AS oldest
    FROM sm.listing l
    JOIN sm.exchange e ON e.exchange_id = l.exchange_id
    WHERE l.active
      AND l.date_created >= ($2::timestamptz AT TIME ZONE 'UTC') AND l.date_created < ($1::timestamptz AT TIME ZONE 'UTC')
      AND NOT EXISTS (SELECT 1 FROM sm.listing_spec s WHERE s.listing_id = l.listing_id)
    GROUP BY e.exchange_id, e.exchange_code`,
    [new Date(now.getTime() - SPEC_MISSING_AFTER_MS), new Date(now.getTime() - SPEC_MISSING_WITHIN_MS)])).rows;
  return rows.map(r => finding('live', 'warning', 'LISTING_SPEC_MISSING', [r.exchange_code],
    `${r.missing} active ${r.exchange_code} listing${r.missing === 1 ? ' has' : 's have'} no spec`, {
      visibleIn: ['live', 'paper'],
      exchangeId: r.exchange_id,
      exchangeName: r.exchange_code,
      detail: `e.g. ${(r.examples as (string | null)[]).filter(Boolean).join(', ')}`,
      since: new Date(r.oldest).toISOString(),
      facts: { missing: r.missing },
    }));
}
