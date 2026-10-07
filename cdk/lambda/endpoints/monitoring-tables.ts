import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse } from './ledger-common';

// The registry database's largest tables, from Postgres's own statistics, for the controller's System page. Every
// schema's tables are listed, so a new table that grows shows up without a change here. Row counts are the planner's
// estimate, refreshed by autovacuum, not an exact count.
const LIMIT = 25;

export async function tableSizes(client: PoolClient) {
  const database = (await client.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0];
  const tables = (await client.query(`
    SELECT n.nspname AS schema, c.relname AS name, pg_total_relation_size(c.oid) AS total_bytes,
      pg_relation_size(c.oid) AS table_bytes, pg_indexes_size(c.oid) AS index_bytes,
      GREATEST(c.reltuples, 0)::bigint AS rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT $1`, [LIMIT])).rows;
  return {
    databaseBytes: String(database.bytes),
    tables: tables.map(t => ({
      schema: t.schema, name: t.name, totalBytes: String(t.total_bytes), tableBytes: String(t.table_bytes),
      indexBytes: String(t.index_bytes), rows: String(t.rows),
    })),
  };
}

export const handler = async (_event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    return createResponse(200, await tableSizes(client));
  } catch (error) {
    console.error('Table sizes error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
