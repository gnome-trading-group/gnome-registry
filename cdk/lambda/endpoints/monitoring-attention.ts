import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, parseMode } from './ledger-common';

// Everything about trading in one mode that someone should look at, most serious first, for the controller's
// overview. Each item names what it concerns so the page can link to it.
//   critical  trading is halted everywhere, a running session has gone silent, or its ledger is failing
//   warning   a strategy or listing is halted, a position needs review, a session failed, or a part of a running
//             session is stalled or reconnecting
//   info      a held position has had no price for a while (prediction markets can be quiet; worth knowing)

export const SILENT_AFTER_MS = 60_000;
// A session that says it's running but has never sent a heartbeat, this long after starting.
export const NO_HEARTBEAT_AFTER_MS = 120_000;
export const HOT_PATH_STALL_MS = 2_000;
export const FAILED_WITHIN_MS = 24 * 3_600_000;
export const NO_PRICE_AFTER_MS = 3_600_000;

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
  since: string | null;
}

function item(severity: Severity, kind: string, title: string, fields: Partial<AttentionItem> = {}): AttentionItem {
  return {
    severity, kind, title, detail: null, strategyId: null, strategyName: null, sessionId: null, listingId: null,
    symbol: null, since: null, ...fields,
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
    SELECT p.policy_id, p.strategy_id, p.listing_id, p.session_id, p.date_modified, st.name AS strategy_name,
      l.exchange_security_symbol AS symbol
    FROM risk.policy p
    LEFT JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
    LEFT JOIN sm.listing l ON l.listing_id = p.listing_id
    LEFT JOIN strategy.session s ON s.session_id = p.session_id
    WHERE p.policy_type = 'KILL_SWITCH' AND p.enabled
      AND (p.session_id IS NULL OR (s.mode = $1 AND s.status IN ('SUBMITTED', 'STARTING', 'RUNNING')))`,
  [mode])).rows;
  for (const k of kills) {
    const fields = {
      strategyId: k.strategy_id, strategyName: k.strategy_name, sessionId: k.session_id, listingId: k.listing_id,
      symbol: k.symbol, since: k.date_modified?.toISOString() ?? null,
    };
    if (k.strategy_id === null && k.listing_id === null) {
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
    SELECT p.strategy_id, st.name AS strategy_name, p.listing_id, l.exchange_security_symbol AS symbol, p.updated_at
    FROM ledger.position p
    JOIN strategy.strategy st ON st.strategy_id = p.strategy_id
    LEFT JOIN sm.listing l ON l.listing_id = p.listing_id
    WHERE p.mode = $1 AND p.needs_review`, [mode])).rows;
  for (const r of review) {
    items.push(item('warning', 'NEEDS_REVIEW', 'Position needs review', {
      detail: 'Ledger events were lost; recovery refuses it until it is adjusted',
      strategyId: r.strategy_id, strategyName: r.strategy_name, listingId: r.listing_id, symbol: r.symbol,
      since: r.updated_at.toISOString(),
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

  // Within a severity, the longest-standing first; problems that are only a current state (no start time) after.
  return items.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]
    || (a.since === null ? 1 : 0) - (b.since === null ? 1 : 0)
    || (a.since ?? '').localeCompare(b.since ?? ''));
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
