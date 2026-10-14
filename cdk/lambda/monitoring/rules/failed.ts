import { PoolClient } from 'pg';
import { Finding, finding } from './types';
import { FAILED_WITHIN_MS } from './thresholds';

// Sessions that failed in the last day. One that never got an instance failed to launch: whoever launched it saw the
// error (the controller synchronously, the launcher as its own alert), so it's shown but not alerted on.
export async function failed(client: PoolClient, now: Date): Promise<Finding[]> {
  const rows = (await client.query(`
    SELECT s.session_id, s.strategy_id, st.name AS strategy_name, s.mode, s.failure_reason, s.instance_id,
      COALESCE(s.stopped_at, s.date_modified) AS at
    FROM strategy.session s JOIN strategy.strategy st ON st.strategy_id = s.strategy_id
    WHERE s.status = 'FAILED' AND COALESCE(s.stopped_at, s.date_modified) > $1
    ORDER BY at DESC`, [new Date(now.getTime() - FAILED_WITHIN_MS)])).rows;
  return rows.map(f => finding(f.mode, 'warning', 'FAILED', [f.session_id], 'Session failed', {
    detail: f.failure_reason, strategyId: f.strategy_id, strategyName: f.strategy_name, sessionId: f.session_id,
    since: new Date(f.at).toISOString(), alertable: f.instance_id !== null,
  }));
}
