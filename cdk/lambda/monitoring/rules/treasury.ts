import { PoolClient } from 'pg';
import { accountTreasury } from '../../endpoints/treasury';
import { Finding, finding, money } from './types';

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
    // while the account's total looks healthy; only shards given a threshold are checked.
    for (const [partition, threshold] of Object.entries(a.partitionLowThresholds)) {
      const shardCash = a.cashByPartition?.[partition] ?? 0n;
      if (a.snapshotFresh && shardCash < threshold) {
        on('warning', 'SHARD_BALANCE_LOW', partition, `${a.label} shard ${partition} is low on cash`, {
          detail: `${money(shardCash)} on shard ${partition}, below ${money(threshold)}; move cash onto it`,
        });
      }
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
