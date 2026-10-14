import { PoolClient } from 'pg';
import { Finding, finding, Mode, seconds } from './types';
import { BOOK_RESYNCS_PER_5M, HOT_PATH_STALL_MS, NO_HEARTBEAT_AFTER_MS, SILENT_AFTER_MS } from './thresholds';

// The heartbeat's health (see the orchestrator's SessionHeartbeatAgent). Older sessions omit the newer parts.
interface Health {
  agents?: { name: string; hotPath: boolean; stalledMs: number; exited: boolean }[];
  gateways?: { name: string; reconnecting: boolean; resyncsLast5m?: number }[];
  ledger?: { consecutiveFailures: number; fenced: boolean } | null;
  risk?: { stale: boolean; unguarded: boolean; unbuildablePolicies: number; droppedLatches: number } | null;
  rateLimit?: { account: string; throttling: boolean }[];
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
    for (const limiter of health.rateLimit ?? []) {
      if (limiter.throttling) on('warning', 'RATE_LIMIT_THROTTLING', limiter.account, `${limiter.account} is rate limited`);
    }
  }
  return findings;
}
