import { connectDatabase } from '../connections';

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
export function resolveTransition(ec2State: string): Transition | null {
  if (ec2State === 'running') return { status: 'STARTING', from: ['SUBMITTED'] };
  if (ec2State === 'shutting-down' || ec2State === 'terminated') {
    return { status: 'FAILED', from: ['SUBMITTED', 'STARTING', 'RUNNING'] };
  }
  return null;
}

export const handler = async (event: Ec2StateChangeEvent) => {
  const instanceId = event.detail['instance-id'];
  const state = event.detail.state;

  const transition = resolveTransition(state);
  if (!transition) return;

  const pool = await connectDatabase();
  const client = await pool.connect();
  try {
    const updates = [`status='${transition.status}'`, `date_modified=NOW()`];
    if (transition.status === 'FAILED') {
      updates.push(`stopped_at=NOW()`);
      updates.push(`failure_reason='Instance ${state} without a stop request'`);
    }

    const result = await client.query(`
      UPDATE strategy.session
      SET ${updates.join(', ')}
      WHERE instance_id = '${instanceId}' AND status IN (${transition.from.map(s => `'${s}'`).join(', ')})
      RETURNING session_id, status
    `);

    if (result.rowCount === 0) {
      // Most EC2 events in the account belong to other fleets (Batch, classifier); this is the normal path.
      console.debug(`No session moved for ${instanceId} (${state})`);
    } else {
      const row = result.rows[0];
      console.log(`Session ${row.session_id} -> ${row.status} (instance ${instanceId} ${state})`);
    }
  } finally {
    client.release();
  }
};
