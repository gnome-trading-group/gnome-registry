import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { AssignmentError, assignAccount, GatewayHandler } from '../lambda/endpoints/gateways';
import { gatewayAccounts, registerAccount } from '../lambda/endpoints/venue-accounts';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

// Kalshi (1) has one live gateway, Polymarket Intl (2) two instances, Hyperliquid (3) none; plus the paper gateway.
describeDb('gateways and the accounts they hold, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE sm.exchange, account_master.venue_account, account_master.venue_account_history,
      account_master.gateway, account_master.gateway_account RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'Kalshi', 'us-east-1', 'KALSHI'), (2, 'Polymarket', 'eu-west-1', 'POLYMARKET_INTL'),
             (3, 'Hyperliquid', 'ap-northeast-1', 'HYPERLIQUID')`);
    await client.query(`INSERT INTO account_master.gateway (gateway_key, mode, exchange_id, region, profile)
      VALUES ('live:kalshi:main', 'live', 1, 'us-east-1', 'standard'),
             ('live:polymarket_intl:main', 'live', 2, 'eu-west-1', 'standard'),
             ('live:polymarket_intl:b', 'live', 2, 'eu-west-1', 'standard'),
             ('paper', 'paper', NULL, 'us-east-1', 'paper')`);
  });

  async function register(exchangeId: number, label: string): Promise<number> {
    const row = await registerAccount(client, {
      exchangeId, label, tradingSecretName: `gnome/accounts/${label}/trading`, actor: 'ops@example.com',
    });
    return row.account_id;
  }

  async function holder(accountId: number): Promise<string | undefined> {
    return (await client.query(
      'SELECT gateway_key FROM account_master.gateway_account WHERE account_id = $1', [accountId])).rows[0]?.gateway_key;
  }

  it('assigns a new account to its venue\'s only live gateway, and leaves the choice to a person otherwise', async () => {
    expect(await holder(await register(1, 'steady-heron-01'))).toBe('live:kalshi:main');
    expect(await holder(await register(2, 'brisk-badger-02'))).toBeUndefined();
    expect(await holder(await register(3, 'quiet-otter-03'))).toBeUndefined();
  });

  it('assigns an unheld account once, and refuses a move, another venue\'s gateway or the paper one', async () => {
    const wallet = await register(2, 'brisk-badger-02');
    const kalshi = await register(1, 'steady-heron-01');

    expect((await assignAccount(client, wallet, 'live:polymarket_intl:b', 'ops@example.com')).gateway_key)
      .toBe('live:polymarket_intl:b');
    expect((await assignAccount(client, wallet, 'live:polymarket_intl:b', 'ops@example.com')).gateway_key)
      .toBe('live:polymarket_intl:b');

    await expect(assignAccount(client, wallet, 'live:polymarket_intl:main', 'ops@example.com'))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(assignAccount(client, kalshi, 'live:polymarket_intl:main', 'ops@example.com'))
      .rejects.toMatchObject({ statusCode: 409 });

    const other = await register(2, 'swift-crane-04');
    await expect(assignAccount(client, other, 'paper', 'ops@example.com')).rejects.toBeInstanceOf(AssignmentError);
    await client.query('DELETE FROM account_master.gateway_account WHERE account_id = $1', [kalshi]);
    await expect(assignAccount(client, kalshi, 'live:polymarket_intl:main', 'ops@example.com'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(assignAccount(client, other, 'live:nowhere:main', 'ops@example.com'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('gives a gateway its active and draining accounts, with their trading secrets', async () => {
    const active = await register(1, 'steady-heron-01');
    const draining = await register(1, 'calm-finch-05');
    const provisioning = await register(1, 'bold-lynx-06');
    await client.query(`UPDATE account_master.venue_account SET status = 'ACTIVE' WHERE account_id = $1`, [active]);
    await client.query(`UPDATE account_master.venue_account SET status = 'DRAINING' WHERE account_id = $1`, [draining]);

    const held = await gatewayAccounts(client, 'live:kalshi:main');
    expect(held.map((a) => a.account_id)).toEqual([active, draining]);
    expect(held[0]).toMatchObject({ exchange_code: 'KALSHI', trading_secret_name: 'gnome/accounts/steady-heron-01/trading' });
    expect(held.map((a) => a.account_id)).not.toContain(provisioning);
    expect(await gatewayAccounts(client, 'paper')).toEqual([]);

    const handler = new GatewayHandler();
    const rows = (await client.query(handler.generateSelectQuery({ mode: 'live' }))).rows;
    expect(rows.find((g) => g.gateway_key === 'live:kalshi:main')).toMatchObject({ accounts: 2, exchange_code: 'KALSHI' });
  });
});
