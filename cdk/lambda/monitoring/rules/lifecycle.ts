import { PoolClient } from 'pg';
import { Finding, finding } from './types';
import { START_STUCK_AFTER_MS, STOP_STUCK_AFTER_MS } from './thresholds';

// Sessions stuck on their way up or down. One that never reports after launch may be hung in its startup (a
// recovery that can't finish, a venue it can't reach) while its gateways stay connected; one that never finishes
// stopping may still have an instance, and orders, on the venue.
export async function lifecycle(client: PoolClient, now: Date): Promise<Finding[]> {
  const rows = (await client.query(`
    SELECT s.session_id, s.strategy_id, st.name AS strategy_name, s.mode, s.status, s.started_at, s.date_modified
    FROM strategy.session s JOIN strategy.strategy st ON st.strategy_id = s.strategy_id
    WHERE (s.status IN ('SUBMITTED', 'STARTING') AND s.last_heartbeat_at IS NULL AND s.started_at < $1)
       OR (s.status = 'STOPPING' AND s.date_modified < $2)`,
  [new Date(now.getTime() - START_STUCK_AFTER_MS), new Date(now.getTime() - STOP_STUCK_AFTER_MS)])).rows;
  return rows.map(s => {
    const fields = { strategyId: s.strategy_id, strategyName: s.strategy_name, sessionId: s.session_id };
    return s.status === 'STOPPING'
      ? finding(s.mode, 'warning', 'STOP_STUCK', [s.session_id], 'Session has not finished stopping', {
        ...fields, since: s.date_modified.toISOString(),
        facts: { stoppingMs: now.getTime() - s.date_modified.getTime() },
      })
      : finding(s.mode, 'warning', 'START_STUCK', [s.session_id], 'Session has not started', {
        ...fields, detail: `Still ${s.status.toLowerCase()} with no heartbeat`, since: s.started_at.toISOString(),
        facts: { startingMs: now.getTime() - s.started_at.getTime() },
      });
  });
}
