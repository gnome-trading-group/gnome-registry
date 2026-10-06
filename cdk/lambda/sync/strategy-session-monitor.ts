import { connectDatabase } from '../connections';
import { withTransaction } from '../endpoints/base';

interface Ec2StateChangeEvent {
  detail: {
    'instance-id': string;
    state: string;
  };
}

interface Transition {
  status: string;
  from: string[];
}

// The instance booting only means bootstrap has started; the orchestrator reports RUNNING itself once its
// agents are live. Each transition is guarded so a delayed or retried event can never move a session backwards.
// An instance that goes away mid-stop finishes that stop (STOPPED) rather than failing: a stop was requested.
export function resolveTransitions(ec2State: string): Transition[] {
  if (ec2State === 'running') return [{ status: 'STARTING', from: ['SUBMITTED'] }];
  if (ec2State === 'shutting-down' || ec2State === 'terminated') {
    return [
      { status: 'FAILED', from: ['SUBMITTED', 'STARTING', 'RUNNING'] },
      { status: 'STOPPED', from: ['STOPPING'] },
    ];
  }
  return [];
}

export const KILL_RELEASE_AUDIT = { actor: 'system', reason: 'instance terminated' };

// A stop kills the session before shutting it down, and a crash may have been killed too; either way the kill must
// hold until the OMS can no longer act on it. Only 'terminated' guarantees that ('shutting-down' can still be
// running the OMS), and only ended sessions qualify, so a kill on a live session is never touched.
export function generateKillReleaseQuery(instanceId: string): string {
  return `
    UPDATE risk.policy
    SET enabled=false, date_modified=NOW()
    WHERE policy_type='KILL_SWITCH' AND enabled
      AND session_id IN (
        SELECT session_id FROM strategy.session
        WHERE instance_id='${instanceId}' AND status IN ('STOPPED', 'FAILED')
      )
    RETURNING policy_id, session_id
  `;
}

export const handler = async (event: Ec2StateChangeEvent) => {
  const instanceId = event.detail['instance-id'];
  const state = event.detail.state;

  const transitions = resolveTransitions(state);
  if (transitions.length === 0) return;

  const pool = await connectDatabase();
  const client = await pool.connect();
  try {
    let moved = false;
    for (const transition of transitions) {
      const updates = [`status='${transition.status}'`, `date_modified=NOW()`];
      if (transition.status === 'FAILED') {
        updates.push(`stopped_at=NOW()`);
        updates.push(`failure_reason='Instance ${state} without a stop request'`);
      } else if (transition.status === 'STOPPED') {
        updates.push(`stopped_at=NOW()`);
      }

      const result = await client.query(`
        UPDATE strategy.session
        SET ${updates.join(', ')}
        WHERE instance_id = '${instanceId}' AND status IN (${transition.from.map(s => `'${s}'`).join(', ')})
        RETURNING session_id, status
      `);
      for (const row of result.rows) {
        moved = true;
        console.log(`Session ${row.session_id} -> ${row.status} (instance ${instanceId} ${state})`);
      }
    }

    if (!moved) {
      // Most EC2 events in the account belong to other fleets (Batch, classifier); this is the normal path.
      console.debug(`No session moved for ${instanceId} (${state})`);
    }

    if (state === 'terminated') {
      const released = await withTransaction(client, (c) => c.query(generateKillReleaseQuery(instanceId)), KILL_RELEASE_AUDIT);
      for (const row of released.rows) {
        console.log(`Released kill switch ${row.policy_id} for ended session ${row.session_id} (instance ${instanceId} terminated)`);
      }
    }
  } finally {
    client.release();
  }
};
