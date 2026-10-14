import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { accountTreasury } from './treasury';
import { connectLedgerDatabase, createResponse, parseMode } from './ledger-common';

// Everything about trading in one mode that someone should look at, most serious first, for the controller's
// overview. Each item names what it concerns so the page can link to it.
//   critical  trading is halted everywhere, a running session has gone silent, or its ledger is failing
//   warning   a strategy or listing is halted, a position needs review, a session failed, a part of a running
//             session is stalled or reconnecting, or a position on a finished market hasn't been settled
//   info      a held position has had no price for a while (prediction markets can be quiet; worth knowing)
// In live mode the venue accounts too: a balance or position that disagrees with the ledger (critical), one that
// can't be read, runs low (in total or on a Kalshi shard) or is over-allocated (warning), and accounts due to be
// rotated or ready to retire (info).

export const SILENT_AFTER_MS = 60_000;
// A session that says it's running but has never sent a heartbeat, this long after starting.
export const NO_HEARTBEAT_AFTER_MS = 120_000;
export const HOT_PATH_STALL_MS = 2_000;
export const FAILED_WITHIN_MS = 24 * 3_600_000;
export const NO_PRICE_AFTER_MS = 3_600_000;
// How long a deactivated prediction listing may hold a position with no settlement value before the classifier is
// suspected of missing it, and how long a settled one may stay open before the sweeper is.
export const SETTLEMENT_PENDING_AFTER_MS = 24 * 3_600_000;
export const SETTLEMENT_BOOKING_AFTER_MS = 15 * 60_000;

type Severity = 'critical' | 'warning' | 'info';
const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export interface AttentionItem {
  severity: Severity;
  kind: string;
  title: string;
  detail: string | null;
  strategyId: number | null;
  strategyName: string | null;
  sessionId: string | null;
  listingId: number | null;
  symbol: string | null;
  exchangeId: number | null;
  exchangeName: string | null;
  accountId: number | null;
  accountLabel: string | null;
  since: string | null;
}

function item(severity: Severity, kind: string, title: string, fields: Partial<AttentionItem> = {}): AttentionItem {
  return {
    severity, kind, title, detail: null, strategyId: null, strategyName: null, sessionId: null, listingId: null,
    symbol: null, exchangeId: null, exchangeName: null, accountId: null, accountLabel: null, since: null, ...fields,
  };
}

function seconds(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

interface Health {
  agents?: { name: string; hotPath: boolean; stalledMs: number; exited: boolean }[];
  gateways?: { name: string; reconnecting: boolean }[];
  ledger?: { consecutiveFailures: number; fenced: boolean } | null;
}

export async function attention(client: PoolClient, mode: string, now: Date): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  // Halts: every enabled kill switch, except those of sessions that have ended or are being stopped (a stop kills
  // its own session, which is routine).
  const kills = (await client.query(`
    SELECT p.policy_id, p.strategy_id, p.listing_id, p.exchange_id, p.session_id, p.date_modified,
      st.name AS strategy_name, l.exchange_security_symbol AS symbol, e.exchange_name
    FROM risk.policy p
    LEFT JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
    LEFT JOIN sm.listing l ON l.listing_id = p.listing_id
    LEFT JOIN sm.exchange e ON e.exchange_id = p.exchange_id
    LEFT JOIN strategy.session s ON s.session_id = p.session_id
    WHERE p.policy_type = 'KILL_SWITCH' AND p.enabled
      AND (p.session_id IS NULL OR (s.mode = $1 AND s.status IN ('SUBMITTED', 'STARTING', 'RUNNING')))`,
  [mode])).rows;
  for (const k of kills) {
    const fields = {
      strategyId: k.strategy_id, strategyName: k.strategy_name, sessionId: k.session_id, listingId: k.listing_id,
      symbol: k.symbol, exchangeId: k.exchange_id, exchangeName: k.exchange_name,
      since: k.date_modified?.toISOString() ?? null,
    };
    if (k.exchange_id !== null && k.strategy_id === null) {
      items.push(item('critical', 'EXCHANGE_HALT', `All trading on ${k.exchange_name} is halted`, fields));
    } else if (k.exchange_id !== null) {
      items.push(item('warning', 'STRATEGY_EXCHANGE_HALT', `Strategy halted on ${k.exchange_name}`, fields));
    } else if (k.strategy_id === null && k.listing_id === null) {
      items.push(item('critical', 'GLOBAL_HALT', 'All trading is halted', fields));
    } else if (k.session_id !== null) {
      items.push(item('warning', 'SESSION_HALT', 'Session killed', fields));
    } else if (k.strategy_id !== null && k.listing_id === null) {
      items.push(item('warning', 'STRATEGY_HALT', 'Strategy killed', fields));
    } else {
      items.push(item('warning', 'LISTING_HALT', k.strategy_id === null ? 'Listing halted for every strategy' : 'Listing halted', fields));
    }
  }

  const review = (await client.query(`
    SELECT p.strategy_id, st.name AS strategy_name, p.listing_id, l.exchange_security_symbol AS symbol, p.updated_at,
      p.account_id, a.label AS account_label
    FROM ledger.position p
    JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
    LEFT JOIN sm.listing l ON l.listing_id = p.listing_id
    LEFT JOIN account_master.venue_account a ON a.account_id = p.account_id
    WHERE p.mode = $1 AND p.needs_review`, [mode])).rows;
  for (const r of review) {
    items.push(item('warning', 'NEEDS_REVIEW', 'Position needs review', {
      detail: 'Ledger events were lost; recovery refuses it until it is adjusted',
      strategyId: r.strategy_id, strategyName: r.strategy_name, listingId: r.listing_id, symbol: r.symbol,
      accountId: r.account_id, accountLabel: r.account_label, since: r.updated_at.toISOString(),
    }));
  }

  // Running sessions: silent ones, then parts of the live ones that are in trouble. A stopping session goes quiet
  // on purpose once its process exits, so only sessions still meant to be trading are checked.
  const running = (await client.query(`
    SELECT s.session_id, s.strategy_id, st.name AS strategy_name, s.status, s.started_at, s.last_heartbeat_at, s.health
    FROM strategy.session s JOIN strategy.strategy st ON st.strategy_id = s.strategy_id
    WHERE s.mode = $1 AND s.status = 'RUNNING'`, [mode])).rows;
  for (const s of running) {
    const fields = { strategyId: s.strategy_id, strategyName: s.strategy_name, sessionId: s.session_id };
    const heardMs = s.last_heartbeat_at ? now.getTime() - s.last_heartbeat_at.getTime() : null;
    if (heardMs === null) {
      if (now.getTime() - s.started_at.getTime() > NO_HEARTBEAT_AFTER_MS) {
        items.push(item('critical', 'SILENT', 'Session has never reported', { ...fields, since: s.started_at.toISOString() }));
      }
      continue;
    }
    if (heardMs > SILENT_AFTER_MS) {
      items.push(item('critical', 'SILENT', `Session silent for ${seconds(heardMs)}`, {
        ...fields, since: s.last_heartbeat_at.toISOString(),
      }));
      continue;
    }
    const health = (s.health ?? {}) as Health;
    if (health.ledger?.fenced) {
      items.push(item('critical', 'LEDGER_FENCED', 'Ledger refuses this session\'s writes', fields));
    } else if (health.ledger && health.ledger.consecutiveFailures > 0) {
      items.push(item('critical', 'LEDGER_FAILING', `Ledger writes failing (${health.ledger.consecutiveFailures} in a row)`, fields));
    }
    for (const agent of health.agents ?? []) {
      if (agent.exited) {
        items.push(item('warning', 'AGENT_EXITED', `${agent.name} exited`, fields));
      } else if (agent.hotPath && agent.stalledMs >= HOT_PATH_STALL_MS) {
        items.push(item('warning', 'AGENT_STALLED', `${agent.name} stalled for ${seconds(agent.stalledMs)}`, fields));
      }
    }
    for (const gateway of health.gateways ?? []) {
      if (gateway.reconnecting) items.push(item('warning', 'RECONNECTING', `${gateway.name} reconnecting`, fields));
    }
  }

  const failed = (await client.query(`
    SELECT s.session_id, s.strategy_id, st.name AS strategy_name, s.failure_reason,
      COALESCE(s.stopped_at, s.date_modified) AS at
    FROM strategy.session s JOIN strategy.strategy st ON st.strategy_id = s.strategy_id
    WHERE s.mode = $1 AND s.status = 'FAILED' AND COALESCE(s.stopped_at, s.date_modified) > $2
    ORDER BY at DESC`, [mode, new Date(now.getTime() - FAILED_WITHIN_MS)])).rows;
  for (const f of failed) {
    items.push(item('warning', 'FAILED', 'Session failed', {
      detail: f.failure_reason, strategyId: f.strategy_id, strategyName: f.strategy_name, sessionId: f.session_id,
      since: new Date(f.at).toISOString(),
    }));
  }

  const quiet = (await client.query(`
    SELECT p.strategy_id, st.name AS strategy_name, p.listing_id, l.exchange_security_symbol AS symbol, mk.ts
    FROM ledger.position p
    JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
    LEFT JOIN sm.listing l ON l.listing_id = p.listing_id
    LEFT JOIN LATERAL (
      SELECT ts FROM ledger.mark m WHERE m.listing_id = p.listing_id ORDER BY ts DESC LIMIT 1
    ) mk ON TRUE
    WHERE p.mode = $1 AND p.net_quantity <> 0 AND (mk.ts IS NULL OR mk.ts < $2)`,
  [mode, new Date(now.getTime() - NO_PRICE_AFTER_MS)])).rows;
  for (const q of quiet) {
    items.push(item('info', 'NO_PRICE', q.ts ? `No price for ${seconds(now.getTime() - q.ts.getTime())}` : 'No price recorded', {
      detail: 'Valued at its last known price', strategyId: q.strategy_id, strategyName: q.strategy_name,
      listingId: q.listing_id, symbol: q.symbol, since: q.ts?.toISOString() ?? null,
    }));
  }

  // Settlement: a market that has finished still leaves positions open until its value is recorded and the
  // sweeper books it. Either step stalling leaves a position valued at a stale mark.
  const unsettled = (await client.query(`
    SELECT p.strategy_id, st.name AS strategy_name, p.listing_id, l.exchange_security_symbol AS symbol,
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
    WHERE p.mode = $1 AND p.net_quantity <> 0
      AND (ec.settlement_price IS NOT NULL OR (NOT l.active AND l.date_modified < $2))`,
  [mode, new Date(now.getTime() - SETTLEMENT_PENDING_AFTER_MS)])).rows;
  for (const u of unsettled) {
    const fields = {
      strategyId: u.strategy_id, strategyName: u.strategy_name, listingId: u.listing_id, symbol: u.symbol,
      accountId: u.account_id,
    };
    if (u.settlement_price === null) {
      items.push(item('warning', 'SETTLEMENT_PENDING', 'Finished market has no settlement value', {
        ...fields, detail: 'The listing was deactivated but its result was never recorded',
        since: u.date_modified.toISOString(),
      }));
    } else if (u.needs_review || u.held || now.getTime() - u.settled_at.getTime() > SETTLEMENT_BOOKING_AFTER_MS) {
      items.push(item('warning', 'SETTLEMENT_BLOCKED', 'Settled market still has an open position', {
        ...fields,
        detail: u.needs_review ? 'Adjust the position to clear its review; the sweeper then settles what remains'
          : u.held ? 'A session still holds the listing; it settles once that session stops'
          : 'The settlement sweeper has not booked it',
        since: u.settled_at.toISOString(),
      }));
    }
  }

  if (mode === 'live') items.push(...await treasuryItems(client, now));

  // Within a severity, the longest-standing first; problems that are only a current state (no start time) after.
  return items.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]
    || (a.since === null ? 1 : 0) - (b.since === null ? 1 : 0)
    || (a.since ?? '').localeCompare(b.since ?? ''));
}

// The money side, live only: venue accounts whose balances or positions disagree with the ledger, can't be read,
// run low or are over-allocated, and accounts due to be rotated or ready to retire.
async function treasuryItems(client: PoolClient, now: Date): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
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
    const c = config.get(a.accountId);
    const cash = recon.find(r => r.account_id === a.accountId);
    if (cash?.cash_status === 'BREAK') {
      items.push(item('critical', 'RECON_MISMATCH', `${a.label} cash differs from the ledger`, {
        ...fields, detail: `The venue holds ${money(cash.cash_diff)} more than the ledger and transfers explain`,
        since: cash.ran_at.toISOString(),
      }));
    }
    for (const b of breaks.filter(x => x.account_id === a.accountId)) {
      items.push(item('critical', 'RECON_MISMATCH', b.status === 'UNKNOWN_VENUE_POSITION'
        ? `${a.label} holds a position the ledger doesn't know` : `${a.label} position differs from the ledger`, {
        ...fields, listingId: b.listing_ids?.[0] ?? null,
        detail: `${b.venue_key}: venue ${b.venue_qty}, ledger ${b.ledger_qty}`,
        since: b.first_mismatch_at?.toISOString() ?? null,
      }));
    }
    if (c?.last_status === 'ERROR' || !a.snapshotFresh) {
      items.push(item('warning', 'RECON_STALE', `${a.label} balances can't be read`, {
        ...fields, detail: c?.last_status === 'ERROR' ? c.last_error : 'No recent balance snapshot; check the venue poller',
        since: c?.last_poll?.toISOString() ?? null,
      }));
    }
    if (a.snapshotFresh && a.lowBalanceThreshold > 0n && a.cashAvailable < a.lowBalanceThreshold) {
      items.push(item('warning', 'BALANCE_LOW', `${a.label} is low on cash`, {
        ...fields, detail: `${money(a.cashAvailable)} available`,
      }));
    }
    // Kalshi's cash is split by exchange shard and only backs orders on that shard's markets, so a shard can run dry
    // while the account's total looks healthy; only shards given a threshold are checked.
    for (const [partition, threshold] of Object.entries(a.partitionLowThresholds)) {
      const cash = a.cashByPartition?.[partition] ?? 0n;
      if (a.snapshotFresh && cash < threshold) {
        items.push(item('warning', 'SHARD_BALANCE_LOW', `${a.label} shard ${partition} is low on cash`, {
          ...fields, detail: `${money(cash)} on shard ${partition}, below ${money(threshold)}; move cash onto it`,
        }));
      }
    }
    if (a.snapshotFresh && a.allocated > a.base - a.minBuffer) {
      items.push(item('warning', 'ALLOCATION_EXCEEDS_BALANCE', `${a.label} is over-allocated`, {
        ...fields, detail: `${money(a.allocated)} allocated against ${money(a.base - a.minBuffer)} usable`,
      }));
    }
    if (c && a.status === 'ACTIVE' && c.max_active_days !== null && c.activated_at
      && now.getTime() - c.activated_at.getTime() > c.max_active_days * 86_400_000) {
      items.push(item('info', 'ACCOUNT_DUE_FOR_ROTATION', `${a.label} is due to be rotated`, {
        ...fields, since: c.activated_at.toISOString(),
      }));
    }
    if (c && a.status === 'DRAINING' && c.held === 0 && c.orders === 0 && a.snapshotFresh
      && a.cashTotal + a.redeemable <= BigInt(c.dust_threshold)) {
      items.push(item('info', 'ACCOUNT_READY_TO_RETIRE', `${a.label} is empty and can be retired`, fields));
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
    items.push(item('info', 'DRAINING_EXPOSURE', 'Also holds this listing on a draining account', {
      strategyId: e.strategy_id, strategyName: e.strategy_name, listingId: e.listing_id, symbol: e.symbol,
      accountId: e.account_id, accountLabel: e.label,
      detail: 'Its limits only count the position on the account it trades now',
    }));
  }
  return items;
}

function money(value: unknown): string {
  const v = typeof value === 'bigint' ? value : BigInt(String(value ?? 0));
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  return `${sign}$${abs / 1_000_000_000n}.${String((abs % 1_000_000_000n) / 10_000_000n).padStart(2, '0')}`;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  let mode;
  try {
    mode = parseMode(event.queryStringParameters?.mode);
    if (!mode) throw new Error('mode is required');
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const now = new Date();
    return createResponse(200, { asOf: now.toISOString(), items: await attention(client, mode, now) });
  } catch (error) {
    console.error('Attention error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
