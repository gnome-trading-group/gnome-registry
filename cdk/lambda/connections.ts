import { Pool } from 'pg';

let pool: Pool | null = null;

// maxConnections only applies to the first call in a container, which creates the pool.
export async function connectDatabase(maxConnections: number = 10) {
  if (pool) {
    return pool;
  }

  const dbSecretJson = process.env.DATABASE_SECRET_JSON;

  if (!dbSecretJson) {
    throw new Error('Missing required environment variables');
  }

  const { password, dbname, port, host, username } = JSON.parse(dbSecretJson);

  pool = new Pool({
    user: username,
    host,
    database: dbname,
    password,
    port: parseInt(port),
    max: maxConnections,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  return pool;
}
