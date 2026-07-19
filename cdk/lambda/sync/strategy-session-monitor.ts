import { connectDatabase } from '../connections';

interface EcsTaskStateChangeEvent {
  detail: {
    taskArn: string;
    lastStatus: string;
    stoppedReason?: string;
  };
}

function resolveSessionStatus(ecsStatus: string, stoppedReason?: string): string | null {
  if (ecsStatus === 'RUNNING') return 'RUNNING';
  if (ecsStatus !== 'STOPPED') return null;
  if (!stoppedReason || stoppedReason.toLowerCase().includes('user')) return 'STOPPED';
  return 'FAILED';
}

export const handler = async (event: EcsTaskStateChangeEvent) => {
  const { taskArn, lastStatus, stoppedReason } = event.detail;

  const newStatus = resolveSessionStatus(lastStatus, stoppedReason);
  if (!newStatus) {
    console.log(`Ignoring ECS state "${lastStatus}" for task ${taskArn}`);
    return;
  }

  const pool = await connectDatabase();
  const client = await pool.connect();
  try {
    const updates: string[] = [`status='${newStatus}'`, `date_modified=NOW()`];
    if (newStatus === 'STOPPED' || newStatus === 'FAILED') {
      updates.push(`stopped_at=NOW()`);
    }
    if (newStatus === 'FAILED' && stoppedReason) {
      updates.push(`failure_reason='${stoppedReason.replace(/'/g, "''")}'`);
    }

    const result = await client.query(`
      UPDATE strategy.session
      SET ${updates.join(', ')}
      WHERE task_arn = '${taskArn}'
      RETURNING session_id, status
    `);

    if (result.rowCount === 0) {
      console.log(`No session found for task_arn=${taskArn} — may be a non-strategy task`);
    } else {
      const row = result.rows[0];
      console.log(`Session ${row.session_id} updated to ${row.status} (task ${taskArn})`);
    }
  } finally {
    client.release();
  }
};
