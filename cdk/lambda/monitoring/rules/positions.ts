import { PoolClient } from 'pg';
import { Finding, finding, seconds } from './types';
import { NO_PRICE_AFTER_MS } from './thresholds';

// Positions the ledger can't vouch for, and held positions with no recent price (prediction markets can be quiet, so
// that one is only worth knowing).
export async function positions(client: PoolClient, now: Date): Promise<Finding[]> {
  const findings: Finding[] = [];
  const review = (await client.query(`
    SELECT p.strategy_id, st.name AS strategy_name, p.listing_id, p.mode, l.exchange_security_symbol AS symbol,
      p.updated_at, p.account_id, a.label AS account_label
    FROM ledger.position p
    JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
    LEFT JOIN sm.listing l ON l.listing_id = p.listing_id
    LEFT JOIN account_master.venue_account a ON a.account_id = p.account_id
    WHERE p.needs_review`)).rows;
  for (const r of review) {
    findings.push(finding(r.mode, 'warning', 'NEEDS_REVIEW', [r.strategy_id, r.listing_id, r.account_id], 'Position needs review', {
      detail: 'Ledger events were lost; recovery refuses it until it is adjusted',
      strategyId: r.strategy_id, strategyName: r.strategy_name, listingId: r.listing_id, symbol: r.symbol,
      accountId: r.account_id, accountLabel: r.account_label, since: r.updated_at.toISOString(),
    }));
  }

  const quiet = (await client.query(`
    SELECT p.strategy_id, st.name AS strategy_name, p.listing_id, p.mode, p.account_id,
      l.exchange_security_symbol AS symbol, mk.ts
    FROM ledger.position p
    JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
    LEFT JOIN sm.listing l ON l.listing_id = p.listing_id
    LEFT JOIN LATERAL (
      SELECT ts FROM ledger.mark m WHERE m.listing_id = p.listing_id ORDER BY ts DESC LIMIT 1
    ) mk ON TRUE
    WHERE p.net_quantity <> 0 AND (mk.ts IS NULL OR mk.ts < $1)`,
  [new Date(now.getTime() - NO_PRICE_AFTER_MS)])).rows;
  for (const q of quiet) {
    const quietMs = q.ts ? now.getTime() - q.ts.getTime() : null;
    findings.push(finding(q.mode, 'info', 'NO_PRICE', [q.strategy_id, q.listing_id, q.account_id],
      quietMs !== null ? `No price for ${seconds(quietMs)}` : 'No price recorded', {
        detail: 'Valued at its last known price', strategyId: q.strategy_id, strategyName: q.strategy_name,
        listingId: q.listing_id, symbol: q.symbol, since: q.ts?.toISOString() ?? null,
        facts: quietMs !== null ? { quietMs } : {},
      }));
  }
  return findings;
}
