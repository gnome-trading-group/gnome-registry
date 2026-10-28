import { PoolClient } from 'pg';
import { Finding, finding, Mode, seconds } from './types';
import {
  BOOK_RESYNCS_PER_5M, DISK_FREE_MIN_BYTES, DISK_FREE_MIN_SEGMENTS, HOST_CPU_BUSY_PERMILLE, HOST_CPU_STEAL_PERMILLE,
  HOST_MEM_AVAILABLE_MIN_PERCENT, HOT_PATH_STALL_MS, JOURNAL_BACKLOG_AGE_MS, JOURNAL_BACKLOG_SEGMENTS,
  MARKET_DATA_BAD_AFTER_MS, MARKET_DATA_BAD_HELD_AFTER_MS, NO_HEARTBEAT_AFTER_MS, SILENT_AFTER_MS,
} from './thresholds';

// The heartbeat's health (see the orchestrator's SessionHeartbeatAgent). Older sessions omit the newer parts.
interface Health {
  agents?: { name: string; hotPath: boolean; stalledMs: number; exited: boolean }[];
  // marketDataBadMs: how long the listing's book has been flagged bad data, its OMS refusing new orders; 0 trusted.
  listings?: { listingId: number; priceUnchangedMs: number; marketDataBadMs?: number }[];
  gateways?: { name: string; reconnecting: boolean; resyncsLast5m?: number }[];
  ledger?: { consecutiveFailures: number; fenced: boolean } | null;
  risk?: { stale: boolean; unguarded: boolean; unbuildablePolicies: number; droppedLatches: number } | null;
  rateLimit?: { account: string; throttling: boolean }[];
  // A reading the host can't give (no /proc off Linux, no CPU share before the second sample) is -1.
  host?: {
    cpuBusyPermille: number; cpuStealPermille: number; memAvailableBytes: number; memTotalBytes: number;
    processRssBytes: number; heapUsedBytes: number; heapMaxBytes: number; diskFreeBytes: number;
  } | null;
  // Null with the journal off.
  journal?: { pendingSegments: number; oldestPendingMs: number; segmentBytes: number } | null;
}

// Running sessions: silent ones, then the parts of the rest that are in trouble. A stopping session goes quiet on
// purpose once its process exits, so only sessions still meant to be trading are checked.
export async function sessions(client: PoolClient, now: Date): Promise<Finding[]> {
  const findings: Finding[] = [];
  const running = (await client.query(`
    SELECT s.session_id, s.strategy_id, st.name AS strategy_name, s.mode, s.started_at, s.last_heartbeat_at, s.health
    FROM strategy.session s JOIN strategy.strategy st ON st.strategy_id = s.strategy_id
    WHERE s.status = 'RUNNING'`)).rows;
  for (const s of running) {
    const mode: Mode = s.mode;
    const fields = { strategyId: s.strategy_id, strategyName: s.strategy_name, sessionId: s.session_id };
    const on = (severity: 'critical' | 'warning', kind: string, subject: string | null, title: string,
      extra: Partial<Finding> = {}) =>
      findings.push(finding(mode, severity, kind, [s.session_id, subject], title, { ...fields, subject, ...extra }));

    const heardMs = s.last_heartbeat_at ? now.getTime() - s.last_heartbeat_at.getTime() : null;
    if (heardMs === null) {
      const sinceStartMs = now.getTime() - s.started_at.getTime();
      if (sinceStartMs > NO_HEARTBEAT_AFTER_MS) {
        on('critical', 'SILENT', null, 'Session has never reported',
          { since: s.started_at.toISOString(), facts: { heardMs: sinceStartMs } });
      }
      continue;
    }
    if (heardMs > SILENT_AFTER_MS) {
      on('critical', 'SILENT', null, `Session silent for ${seconds(heardMs)}`,
        { since: s.last_heartbeat_at.toISOString(), facts: { heardMs } });
      continue;
    }

    const health = (s.health ?? {}) as Health;
    if (health.ledger?.fenced) {
      on('critical', 'LEDGER_FENCED', null, 'Ledger refuses this session\'s writes');
    } else if (health.ledger && health.ledger.consecutiveFailures > 0) {
      on('critical', 'LEDGER_FAILING', null, `Ledger writes failing (${health.ledger.consecutiveFailures} in a row)`,
        { facts: { consecutiveFailures: health.ledger.consecutiveFailures } });
    }
    const risk = health.risk;
    if (risk?.unguarded) {
      on('critical', 'RISK_UNGUARDED', null, 'Missing required risk policies; every order is refused');
    } else if (risk?.stale) {
      on('critical', 'RISK_STALE', null, 'Risk policies are stale; new orders are refused');
    }
    if (risk && risk.unbuildablePolicies > 0) {
      on('critical', 'POLICY_UNBUILDABLE', null, `${risk.unbuildablePolicies} risk policies can't be applied; their targets are killed`,
        { facts: { unbuildablePolicies: risk.unbuildablePolicies } });
    }
    if (risk && risk.droppedLatches > 0) {
      on('critical', 'LATCHES_DROPPED', null, `${risk.droppedLatches} automatic halts were never recorded`,
        { facts: { droppedLatches: risk.droppedLatches } });
    }
    for (const agent of health.agents ?? []) {
      if (agent.exited) {
        on('warning', 'AGENT_EXITED', agent.name, `${agent.name} exited`);
      } else if (agent.hotPath && agent.stalledMs >= HOT_PATH_STALL_MS) {
        on('warning', 'AGENT_STALLED', agent.name, `${agent.name} stalled for ${seconds(agent.stalledMs)}`,
          { facts: { stalledMs: agent.stalledMs } });
      }
    }
    for (const gateway of health.gateways ?? []) {
      if (gateway.reconnecting) on('warning', 'RECONNECTING', gateway.name, `${gateway.name} reconnecting`);
      const resyncs = gateway.resyncsLast5m ?? 0;
      if (resyncs >= BOOK_RESYNCS_PER_5M) {
        on('warning', 'BOOK_RESYNCS', gateway.name, `${gateway.name} resynced its book ${resyncs} times in 5m`,
          { facts: { resyncsLast5m: resyncs } });
      }
    }
    for (const listing of health.listings ?? []) {
      const badMs = listing.marketDataBadMs ?? 0;
      if (badMs < MARKET_DATA_BAD_AFTER_MS) continue;
      const subject = `listing ${listing.listingId}`;
      const extra = { listingId: listing.listingId, facts: { marketDataBadMs: badMs } };
      on('warning', 'MARKET_DATA_BAD', subject, `Book bad for ${seconds(badMs)}; new orders refused`, extra);
      if (badMs >= MARKET_DATA_BAD_HELD_AFTER_MS
          && await holds(client, s.strategy_id, listing.listingId, mode)) {
        on('critical', 'MARKET_DATA_BAD_HELD', subject,
          `Book bad for ${seconds(badMs)} with a position held; new orders refused`, extra);
      }
    }
    for (const limiter of health.rateLimit ?? []) {
      if (limiter.throttling) on('warning', 'RATE_LIMIT_THROTTLING', limiter.account, `${limiter.account} is rate limited`);
    }
    hostFindings(health, on);
  }
  return findings;
}

async function holds(client: PoolClient, strategyId: number, listingId: number, mode: Mode): Promise<boolean> {
  const rows = (await client.query(`
    SELECT 1 FROM ledger.position
    WHERE strategy_id = $1 AND listing_id = $2 AND mode = $3 AND net_quantity <> 0 LIMIT 1`,
  [strategyId, listingId, mode])).rows;
  return rows.length > 0;
}

type On = (severity: 'critical' | 'warning', kind: string, subject: string | null, title: string,
  extra?: Partial<Finding>) => void;

function hostFindings(health: Health, on: On): void {
  const host = health.host;
  const journal = health.journal;
  if (host && (host.cpuBusyPermille >= HOST_CPU_BUSY_PERMILLE || host.cpuStealPermille >= HOST_CPU_STEAL_PERMILLE)) {
    const steal = host.cpuStealPermille > 0 ? ` (steal ${percent(host.cpuStealPermille)})` : '';
    on('warning', 'HOST_CPU_HIGH', null, `CPU ${percent(host.cpuBusyPermille)} busy${steal}`,
      { facts: { cpuBusyPermille: host.cpuBusyPermille, cpuStealPermille: host.cpuStealPermille } });
  }
  if (host && host.memAvailableBytes >= 0 && host.memTotalBytes > 0
      && host.memAvailableBytes * 100 < host.memTotalBytes * HOST_MEM_AVAILABLE_MIN_PERCENT) {
    const rss = host.processRssBytes >= 0 ? `; process RSS ${bytes(host.processRssBytes)}` : '';
    on('warning', 'HOST_MEMORY_LOW', null, `Memory ${Math.floor(host.memAvailableBytes * 100 / host.memTotalBytes)}% `
      + `available (${bytes(host.memAvailableBytes)} of ${bytes(host.memTotalBytes)})${rss}`,
    { facts: { memAvailableBytes: host.memAvailableBytes, memTotalBytes: host.memTotalBytes,
      processRssBytes: host.processRssBytes, heapUsedBytes: host.heapUsedBytes, heapMaxBytes: host.heapMaxBytes } });
  }
  const diskMin = Math.max(DISK_FREE_MIN_BYTES, (journal?.segmentBytes ?? 0) * DISK_FREE_MIN_SEGMENTS);
  if (host && host.diskFreeBytes >= 0 && host.diskFreeBytes < diskMin) {
    on('critical', 'DISK_LOW', null, `Disk ${bytes(host.diskFreeBytes)} free`,
      { facts: { diskFreeBytes: host.diskFreeBytes, diskMinBytes: diskMin } });
  }
  if (journal && (journal.pendingSegments >= JOURNAL_BACKLOG_SEGMENTS || journal.oldestPendingMs >= JOURNAL_BACKLOG_AGE_MS)) {
    const segments = journal.pendingSegments === 1 ? 'segment' : 'segments';
    on('warning', 'JOURNAL_BACKLOG', null,
      `${journal.pendingSegments} journal ${segments} not shipped, oldest ${seconds(journal.oldestPendingMs)}`,
      { facts: { pendingSegments: journal.pendingSegments, oldestPendingMs: journal.oldestPendingMs } });
  }
}

function percent(permille: number): string {
  return `${Math.round(permille / 10)}%`;
}

function bytes(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}
