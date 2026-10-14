import { PoolClient } from 'pg';
import { Finding, finding } from './types';
import { SETTLEMENT_BOOKING_AFTER_MS, SETTLEMENT_PENDING_AFTER_MS } from './thresholds';

// A market that has finished still leaves positions open until its value is recorded and the sweeper books it.
// Either step stalling leaves a position valued at a stale mark.
export async function settlement(client: PoolClient, now: Date): Promise<Finding[]> {
  const findings: Finding[] = [];
  const unsettled = (await client.query(`
    SELECT p.strategy_id, st.name AS strategy_name, p.listing_id, p.mode, l.exchange_security_symbol AS symbol,
      p.account_id, p.needs_review, ec.settlement_price, ec.settled_at, l.date_modified,
      EXISTS (SELECT 1 FROM strategy.session_listing sl
        LEFT JOIN account_master.session_venue_account sva
          ON sva.session_id = sl.session_id AND sva.exchange_id = l.exchange_id
        WHERE sl.strategy_id = p.strategy_id AND sl.mode = p.mode AND sl.listing_id = p.listing_id AND sl.active
          AND sva.account_id IS NOT DISTINCT FROM p.account_id) AS held
    FROM ledger.position p
    JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
    JOIN sm.listing l ON l.listing_id = p.listing_id
    JOIN LATERAL (
      SELECT settlement_price, settled_at FROM sm.event_contract
      WHERE security_id = l.security_id ORDER BY settlement_price NULLS LAST LIMIT 1
    ) ec ON TRUE
    WHERE p.net_quantity <> 0
      AND (ec.settlement_price IS NOT NULL OR (NOT l.active AND l.date_modified < $1))`,
  [new Date(now.getTime() - SETTLEMENT_PENDING_AFTER_MS)])).rows;
  for (const u of unsettled) {
    const key = [u.strategy_id, u.listing_id, u.account_id];
    const fields = {
      strategyId: u.strategy_id, strategyName: u.strategy_name, listingId: u.listing_id, symbol: u.symbol,
      accountId: u.account_id,
    };
    if (u.settlement_price === null) {
      findings.push(finding(u.mode, 'warning', 'SETTLEMENT_PENDING', key, 'Finished market has no settlement value', {
        ...fields, detail: 'The listing was deactivated but its result was never recorded',
        since: u.date_modified.toISOString(),
      }));
    } else if (u.needs_review || u.held || now.getTime() - u.settled_at.getTime() > SETTLEMENT_BOOKING_AFTER_MS) {
      findings.push(finding(u.mode, 'warning', 'SETTLEMENT_BLOCKED', key, 'Settled market still has an open position', {
        ...fields,
        detail: u.needs_review ? 'Adjust the position to clear its review; the sweeper then settles what remains'
          : u.held ? 'A session still holds the listing; it settles once that session stops'
          : 'The settlement sweeper has not booked it',
        since: u.settled_at.toISOString(),
      }));
    }
  }
  return findings;
}
