import { PoolClient } from 'pg';
import { accountTreasury, sweptPartitions } from '../../endpoints/treasury';
import { RebalanceTargets, sameTargets } from '../../sync/venues/types';
import { Finding, finding, money } from './types';

function targetText(allocations: Record<string, number>): string {
  const named = Object.entries(allocations).filter(([, p]) => p > 0)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  return named.length === 0 ? 'no rebalancing' : named.map(([k, p]) => `shard ${k} ${p}%`).join(', ');
}

// The money side, live only: venue accounts whose balances or positions disagree with the ledger, can't be read,
// run low or are over-allocated, and accounts due to be rotated or ready to retire.
export async function treasury(client: PoolClient, now: Date): Promise<Finding[]> {
  const findings: Finding[] = [];
  const accounts = await accountTreasury(client, null, now);
  const config = new Map((await client.query(
    `SELECT a.account_id, a.status, a.activated_at, c.max_active_days, c.dust_threshold,
       (SELECT taken_at FROM treasury.balance_snapshot b WHERE b.account_id = a.account_id
        ORDER BY taken_at DESC LIMIT 1) AS last_poll,
       (SELECT status FROM treasury.balance_snapshot b WHERE b.account_id = a.account_id
        ORDER BY taken_at DESC LIMIT 1) AS last_status,
       (SELECT error FROM treasury.balance_snapshot b WHERE b.account_id = a.account_id
        ORDER BY taken_at DESC LIMIT 1) AS last_error,
       (SELECT COUNT(*) FROM ledger.position p WHERE p.account_id = a.account_id AND p.net_quantity <> 0)::int AS held,
       (SELECT COUNT(*) FROM ledger.order o WHERE o.account_id = a.account_id AND o.status = 'OPEN')::int AS orders
     FROM account_master.venue_account a JOIN treasury.account_config c USING (account_id)
     WHERE a.status <> 'RETIRED'`)).rows.map(r => [r.account_id as number, r]));
  const recon = (await client.query(
    `SELECT DISTINCT ON (account_id) account_id, cash_status, cash_diff, ran_at FROM treasury.recon_run
     ORDER BY account_id, ran_at DESC, run_id DESC`)).rows;
  const breaks = (await client.query(
    `SELECT account_id, venue_key, venue_qty, ledger_qty, status, first_mismatch_at, listing_ids
     FROM treasury.position_check WHERE status IN ('BREAK', 'UNKNOWN_VENUE_POSITION')`)).rows;

  for (const a of accounts) {
    const fields = {
      exchangeId: a.exchangeId, exchangeName: a.exchangeCode, accountId: a.accountId, accountLabel: a.label,
    };
    const on = (severity: 'critical' | 'warning' | 'info', kind: string, subject: string | null, title: string,
      extra: Partial<Finding> = {}) =>
      findings.push(finding('live', severity, kind, [a.accountId, subject], title, { ...fields, subject, ...extra }));

    const c = config.get(a.accountId);
    const cash = recon.find(r => r.account_id === a.accountId);
    if (cash?.cash_status === 'BREAK') {
      on('critical', 'RECON_MISMATCH', 'cash', `${a.label} cash differs from the ledger`, {
        detail: `The venue holds ${money(cash.cash_diff)} more than the ledger and transfers explain`,
        since: cash.ran_at.toISOString(),
      });
    }
    for (const b of breaks.filter(x => x.account_id === a.accountId)) {
      on('critical', 'RECON_MISMATCH', b.venue_key, b.status === 'UNKNOWN_VENUE_POSITION'
        ? `${a.label} holds a position the ledger doesn't know` : `${a.label} position differs from the ledger`, {
        listingId: b.listing_ids?.[0] ?? null,
        detail: `${b.venue_key}: venue ${b.venue_qty}, ledger ${b.ledger_qty}`,
        since: b.first_mismatch_at?.toISOString() ?? null,
      });
    }
    if (c?.last_status === 'ERROR' || !a.snapshotFresh) {
      on('warning', 'RECON_STALE', null, `${a.label} balances can't be read`, {
        detail: c?.last_status === 'ERROR' ? c.last_error : 'No recent balance snapshot; check the venue poller',
        since: c?.last_poll?.toISOString() ?? null,
      });
    }
    if (a.snapshotFresh && a.lowBalanceThreshold > 0n && a.cashAvailable < a.lowBalanceThreshold) {
      on('warning', 'BALANCE_LOW', null, `${a.label} is low on cash`, { detail: `${money(a.cashAvailable)} available` });
    }
    // Kalshi's cash is split by exchange shard and only backs orders on that shard's markets, so a shard can run dry
    // while the account's total looks healthy: one below its threshold, or one live sessions trade with less behind
    // it than their budgets.
    const shards = new Set([...Object.keys(a.partitionLowThresholds), ...Object.keys(a.partitions ?? {})]);
    for (const partition of a.snapshotFresh ? [...shards].sort() : []) {
      const shardCash = a.cashByPartition?.[partition] ?? 0n;
      const threshold = a.partitionLowThresholds[partition];
      const shard = a.partitions?.[partition];
      const reasons = [
        threshold !== undefined && shardCash < threshold && `below ${money(threshold)}`,
        shard && shard.allocated > 0n && shard.allocated > shard.base
          && `behind ${money(shard.allocated)} of live budgets (${money(shard.base)} with positions at cost)`,
      ].filter(Boolean);
      if (reasons.length > 0) {
        on('warning', 'SHARD_BALANCE_LOW', partition, `${a.label} shard ${partition} is low on cash`, {
          detail: `${money(shardCash)} on shard ${partition}, ${reasons.join(' and ')}; move cash onto it`,
        });
      }
    }
    // The poller keeps Kalshi's rebalancing set to the account's targets; still different after a poll means it
    // couldn't (usually a read key without the write::transfer scope).
    const found = a.rebalanceTargets;
    if (a.snapshotFresh && a.partitions !== null && a.partitionTargets !== null && (found?.allocations === undefined
      || !sameTargets(found as RebalanceTargets,
        { allocations: a.partitionTargets, restingMarginReservation: a.rebalanceReservation }))) {
      on('warning', 'REBALANCE_DRIFT', null, `${a.label} isn't rebalancing between shards as set`, {
        detail: found?.error ?? `Kalshi is set to ${targetText(found?.allocations ?? {})}, `
          + `not ${targetText(a.partitionTargets)}`,
      });
    }
    const traded = Object.entries(a.partitions ?? {}).filter(([, p]) => p.allocated > 0n).map(([k]) => k);
    for (const partition of a.snapshotFresh ? sweptPartitions(a, traded) : []) {
      const title = `${a.label} rebalances cash off shard ${partition}, which live sessions trade`;
      on('warning', 'SHARD_UNTARGETED', partition, title, {
        detail: `Shard ${partition} has no share of the rebalancing targets, so its free cash is swept to other shards`,
      });
    }
    if (a.snapshotFresh && a.allocated > a.base - a.minBuffer) {
      on('warning', 'ALLOCATION_EXCEEDS_BALANCE', null, `${a.label} is over-allocated`, {
        detail: `${money(a.allocated)} allocated against ${money(a.base - a.minBuffer)} usable`,
      });
    }
    if (c && a.status === 'ACTIVE' && c.max_active_days !== null && c.activated_at
      && now.getTime() - c.activated_at.getTime() > c.max_active_days * 86_400_000) {
      on('info', 'ACCOUNT_DUE_FOR_ROTATION', null, `${a.label} is due to be rotated`, { since: c.activated_at.toISOString() });
    }
    if (c && a.status === 'DRAINING' && c.held === 0 && c.orders === 0 && a.snapshotFresh
      && a.cashTotal + a.redeemable <= BigInt(c.dust_threshold)) {
      on('info', 'ACCOUNT_READY_TO_RETIRE', null, `${a.label} is empty and can be retired`);
    }
  }

  // Orders a venue refused for want of cash on the listing's shard, though the account as a whole may have plenty.
  const refused = (await client.query(
    `SELECT o.account_id, a.label, a.exchange_id, e.exchange_code, l.venue_partition, COUNT(*)::int AS rejects,
       MIN(o.closed_at) AS since, ARRAY_AGG(DISTINCT st.name ORDER BY st.name) AS strategies
     FROM ledger.order o
     JOIN account_master.venue_account a ON a.account_id = o.account_id
     JOIN sm.exchange e ON e.exchange_id = a.exchange_id
     JOIN sm.listing l ON l.listing_id = o.listing_id
     JOIN strategy.strategy st ON st.strategy_id = o.strategy_id
     WHERE o.reject_reason = 'INSUFFICIENT_FUNDS' AND o.close_state = 'REJECTED' AND o.mode = 'live'
       AND o.closed_at >= $1::timestamptz - INTERVAL '15 minutes' AND l.venue_partition IS NOT NULL
     GROUP BY o.account_id, a.label, a.exchange_id, e.exchange_code, l.venue_partition`, [now])).rows;
  for (const r of refused) {
    const partition: string = r.venue_partition;
    findings.push(finding('live', 'critical', 'SHARD_FUNDS_REJECTED', [r.account_id, partition],
      `${r.label} shard ${partition} is refusing orders for want of cash`, {
        exchangeId: r.exchange_id, exchangeName: r.exchange_code, accountId: r.account_id, accountLabel: r.label,
        subject: partition, since: r.since.toISOString(),
        detail: `${r.rejects} order(s) refused for insufficient funds in 15 minutes (${r.strategies.join(', ')});`
          + ` move cash onto shard ${partition}`,
      }));
  }

  // A strategy holding a listing on a draining account while trading it again on another: its limits only see the
  // new account's position.
  const exposed = (await client.query(
    `SELECT DISTINCT p.strategy_id, st.name AS strategy_name, p.listing_id, l.exchange_security_symbol AS symbol,
       a.account_id, a.label
     FROM ledger.position p
     JOIN account_master.venue_account a ON a.account_id = p.account_id AND a.status = 'DRAINING'
     JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
     JOIN sm.listing l ON l.listing_id = p.listing_id
     JOIN strategy.session_listing sl ON sl.strategy_id = p.strategy_id AND sl.listing_id = p.listing_id
       AND sl.mode = 'live' AND sl.active
     WHERE p.mode = 'live' AND p.net_quantity <> 0`)).rows;
  for (const e of exposed) {
    findings.push(finding('live', 'info', 'DRAINING_EXPOSURE', [e.strategy_id, e.listing_id, e.account_id],
      'Also holds this listing on a draining account', {
        strategyId: e.strategy_id, strategyName: e.strategy_name, listingId: e.listing_id, symbol: e.symbol,
        accountId: e.account_id, accountLabel: e.label,
        detail: 'Its limits only count the position on the account it trades now',
      }));
  }
  return findings;
}
