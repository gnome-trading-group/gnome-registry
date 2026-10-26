import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { SimulationParametersHandler } from '../lambda/endpoints/simulation-parameters';
import { validateParameters } from '../lambda/simulation/parameters';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

const MIGRATION = join(__dirname, '..', 'lambda', 'db-init', 'migrations', '044_simulation_parameters.sql');

// Migration 044's seed statement, rerun on this test's own exchanges.
function seedStatement(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('INSERT INTO sm.simulation_parameters');
  return sql.slice(start, sql.indexOf(';', sql.indexOf(') AS s (', start)) + 1);
}

describeDb('Simulation parameters, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  let handler: SimulationParametersHandler;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE sm.simulation_parameters, sm.exchange RESTART IDENTITY CASCADE');
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code) VALUES
      (1, 'K', 'us-east-1', 'KALSHI'), (2, 'P', 'us-east-1', 'POLYMARKET_US'),
      (3, 'PI', 'eu-west-1', 'POLYMARKET_INTL'), (4, 'H', 'ap-northeast-1', 'HYPERLIQUID'),
      (5, 'L', 'ap-northeast-1', 'LIGHTER'), (6, 'B', 'ap-northeast-1', 'BINANCE')`);
    await client.query(seedStatement());
    handler = new SimulationParametersHandler();
    handler.client = client;
  });

  async function inForce(params: Record<string, string> = {}): Promise<any[]> {
    return (await client.query(handler.generateSelectQuery(params))).rows;
  }

  it('seeds every venue we trade, with definitions consumers can read', async () => {
    const rows = await inForce();
    expect(rows.map((r) => r.exchange_id)).toEqual([1, 2, 3, 4, 5]);
    for (const row of rows) expect(() => validateParameters(row.definition)).not.toThrow();
  });

  it('resolves the latest recorded at or before the pinned time', async () => {
    // The database's clock, not this machine's: rows are stamped by it.
    const before = (await client.query('SELECT clock_timestamp() AS t')).rows[0].t.toISOString();
    const changed = { ...(await inForce({ exchangeId: '1' }))[0].definition, queue_model: { type: 'optimistic' } };
    await client.query(handler.generateInsertQuery(JSON.stringify({ exchangeId: 1, definition: changed })));

    expect((await inForce({ exchangeId: '1' }))[0].definition.queue_model.type).toBe('optimistic');
    expect((await inForce({ exchangeId: '1', knownAsOf: before }))[0].definition.queue_model.type).toBe('risk_averse');
    expect(await inForce({ history: 'true', exchangeId: '1' })).toHaveLength(2);
  });
});
