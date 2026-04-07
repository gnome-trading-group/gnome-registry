import { Pool } from 'pg';

let pool: Pool | null = null;

export async function connectDatabase() {
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
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  return pool;
}
