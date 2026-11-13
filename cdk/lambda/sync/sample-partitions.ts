import { connectDatabase } from '../connections';

// Keeps ops.sample's daily partitions: creates the next few days' ahead of their first sample (an insert with no
// partition is lost, though the heartbeat carrying it still counts) and drops days past retention, whole, which is
// how samples expire. Hourly, so a failed run is retried long before the days ahead run out; the Lambda's fault alarm
// says when it keeps failing.
export const DAYS_AHEAD = 3;
export const KEEP_DAYS = 7;

export const handler = async () => {
  const pool = await connectDatabase(1);
  const client = await pool.connect();
  try {
    // Creating or dropping a partition locks the whole table; waiting behind a long read would hold every insert behind
    // this. Give up quickly instead: the next hour retries, with days ahead to spare.
    await client.query("SET lock_timeout = '2s'");
    await client.query('SELECT ops.ensure_sample_partitions($1, $2)', [DAYS_AHEAD, KEEP_DAYS]);
  } finally {
    await client.query('RESET lock_timeout');
    client.release();
  }
  const partitions = await pool.query(`
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace WHERE n.nspname = 'ops' AND p.relname = 'sample' ORDER BY 1`);
  const result = { partitions: partitions.rows.map(r => r.relname) };
  console.log('Sample partitions:', JSON.stringify(result));
  return result;
};
