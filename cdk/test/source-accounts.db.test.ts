import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { listAccounts, modifyAccount, registerAccount, SourceAccountError } from '../lambda/endpoints/source-accounts';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

// Kalshi (exchange 1) and Polymarket US (exchange 6); their venue sources come from the exchange trigger.
describeDb('market-data source accounts, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE sm.listing, sm.security, sm.exchange, md.source, md.stream, md.source_account RESTART IDENTITY CASCADE');
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'Kalshi', 'us-east-1', 'KALSHI'), (6, 'Polymarket US', 'us-east-1', 'POLYMARKET_US')`);
  });

  const kalshi = (label: string, extra: Record<string, unknown> = {}) => ({
    sourceCode: 'KALSHI', label, secretName: `gnome/market-data/kalshi/${label}`, actor: 'ops@example.com', ...extra,
  });

  it('records an account against its source, active, by the secret it lives in', async () => {
    const row = await registerAccount(client, kalshi('md-1', { connectionBudget: 150, note: 'collection' }));
    expect(row).toMatchObject({
      label: 'md-1', secret_name: 'gnome/market-data/kalshi/md-1', connection_budget: 150, status: 'ACTIVE',
      note: 'collection', created_by: 'ops@example.com',
    });
  });

  it('touches an account already recorded rather than adding another, keeping what wasn\'t given', async () => {
    const first = await registerAccount(client, kalshi('md-1', { connectionBudget: 150, note: 'first' }));
    await modifyAccount(client, { accountId: first.account_id, status: 'RETIRED' });
    const again = await registerAccount(client, kalshi('md-1'));

    expect(again.account_id).toBe(first.account_id);
    expect(again).toMatchObject({ connection_budget: 150, note: 'first', status: 'RETIRED' });
    expect((await client.query('SELECT count(*)::int AS n FROM md.source_account')).rows[0].n).toBe(1);
  });

  it('lists accounts with their source\'s code, filtered by source or label', async () => {
    await registerAccount(client, kalshi('md-1'));
    await registerAccount(client, kalshi('md-2'));
    await registerAccount(client, {
      sourceCode: 'POLYMARKET_US', label: 'md-1', secretName: 'gnome/market-data/polymarket-us/md-1', actor: 'ops',
    });

    expect((await listAccounts(client, {})).map(a => `${a.source_code}/${a.label}`))
      .toEqual(['KALSHI/md-1', 'KALSHI/md-2', 'POLYMARKET_US/md-1']);
    expect((await listAccounts(client, { sourceCode: 'KALSHI', label: 'md-2' })).map(a => a.label)).toEqual(['md-2']);
    const polymarketUs = (await client.query("SELECT source_id FROM md.source WHERE code = 'POLYMARKET_US'")).rows[0];
    expect((await listAccounts(client, { sourceId: String(polymarketUs.source_id) })).length).toBe(1);
  });

  it('retires an account, changes its budget and note, and refuses anything else', async () => {
    const { account_id } = await registerAccount(client, kalshi('md-1', { connectionBudget: 150 }));

    expect(await modifyAccount(client, { accountId: account_id, status: 'RETIRED', connectionBudget: null, note: 'moved' }))
      .toMatchObject({ status: 'RETIRED', connection_budget: null, note: 'moved' });
    await expect(modifyAccount(client, { accountId: account_id, status: 'DRAINING' })).rejects.toThrow(SourceAccountError);
    await expect(modifyAccount(client, { accountId: account_id })).rejects.toThrow(/Nothing to change/);
    await expect(modifyAccount(client, { accountId: 999, status: 'ACTIVE' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses an account for a source that doesn\'t exist', async () => {
    await expect(registerAccount(client, { ...kalshi('md-1'), sourceCode: 'NOPE' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps labels to what a secret name and an environment variable can carry', async () => {
    const source = (await client.query("SELECT source_id FROM md.source WHERE code = 'KALSHI'")).rows[0];
    await expect(client.query(
      `INSERT INTO md.source_account (source_id, label, secret_name, created_by) VALUES ($1, 'MD 1', 'x', 'ops')`,
      [source.source_id])).rejects.toThrow(/check/);
  });
});
