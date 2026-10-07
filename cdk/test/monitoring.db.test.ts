import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { attention } from '../lambda/endpoints/monitoring-attention';
import { series } from '../lambda/endpoints/pnl-series';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const CENT = 10_000_000;
const UNIT = 1_000_000;
const now = new Date('2026-10-07T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const HEALTHY = {
  uptimeMs: 600_000,
  agents: [{ name: 'OmsAgent', hotPath: true, stalledMs: 0, exited: false },
    { name: 'RiskSyncAgent', hotPath: false, stalledMs: 30_000, exited: false }],
  listings: [], gateways: [{ name: 'KalshiReader', reconnecting: false }],
  ledger: { lastAcceptedAgoMs: 100, consecutiveFailures: 0, fenced: false },
};

describeDb('monitoring against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE ledger.fill, ledger.position, ledger.order, ledger.mark, strategy.session_listing,
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.listing_spec, sm.listing, sm.security,
      sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'mbp-10', 'KALSHI')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'X', 0)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_symbol)
      VALUES (500, 1, 1, 'KX-A'), (501, 1, 1, 'KX-B')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb'), ('mm')`);
  });

  async function session(id: string, fields: { strategyId?: number; status?: string; startedAt?: Date; stoppedAt?: Date;
    heartbeatAt?: Date | null; health?: unknown; failure?: string } = {}) {
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at, stopped_at,
        last_heartbeat_at, health, failure_reason)
      VALUES ($1, $2, $3, 'paper', '{}', $4, $5, $6, $7, $8)`,
    [id, fields.strategyId ?? 1, fields.status ?? 'RUNNING', fields.startedAt ?? ago(600_000), fields.stoppedAt ?? null,
      fields.heartbeatAt === undefined ? ago(2_000) : fields.heartbeatAt, JSON.stringify(fields.health ?? HEALTHY),
      fields.failure ?? null]);
  }

  async function kill(target: { strategyId?: number; listingId?: number; sessionId?: string }) {
    await client.query(`INSERT INTO risk.policy (policy_type, strategy_id, listing_id, session_id, parameters, enabled)
      VALUES ('KILL_SWITCH', $1, $2, $3, '{}', true)`,
    [target.strategyId ?? null, target.listingId ?? null, target.sessionId ?? null]);
  }

  async function position(strategyId: number, listingId: number, net: number, review = false) {
    await client.query(`INSERT INTO ledger.position (strategy_id, listing_id, mode, net_quantity, total_cost, version,
      needs_review) VALUES ($1, $2, 'paper', $3, $4, 1, $5)`, [strategyId, listingId, net, Math.abs(net) * 40, review]);
  }

  const kinds = async () => (await attention(client, 'paper', now)).map(i => i.kind);

  it('a healthy running session needs no attention, even with a background agent waiting on the network', async () => {
    await session('ok');
    await position(1, 500, 10 * UNIT);
    await client.query(`INSERT INTO ledger.mark VALUES (500, $1, 1, 2, 0)`, [ago(60_000)]);
    expect(await kinds()).toEqual([]);
  });

  it('flags silent, degraded and failed sessions, most serious first', async () => {
    await session('silent', { heartbeatAt: ago(90_000) });
    await session('mute', { heartbeatAt: null, startedAt: ago(300_000) });
    await session('booting', { heartbeatAt: null, startedAt: ago(30_000) });
    await session('stalled', { health: { ...HEALTHY,
      agents: [{ name: 'OmsAgent', hotPath: true, stalledMs: 5_000, exited: false }],
      gateways: [{ name: 'KalshiReader', reconnecting: true }] } });
    await session('fenced', { health: { ...HEALTHY, ledger: { lastAcceptedAgoMs: 9_000, consecutiveFailures: 0, fenced: true } } });
    await session('stopping', { status: 'STOPPING', heartbeatAt: ago(600_000) });
    await session('failed', { status: 'FAILED', stoppedAt: ago(3_600_000), failure: 'instance terminated' });
    await session('old-failure', { status: 'FAILED', stoppedAt: ago(3 * 86_400_000) });

    const items = await attention(client, 'paper', now);
    expect(items.map(i => [i.severity, i.kind, i.sessionId])).toEqual([
      ['critical', 'SILENT', 'mute'],
      ['critical', 'SILENT', 'silent'],
      ['critical', 'LEDGER_FENCED', 'fenced'],
      ['warning', 'FAILED', 'failed'],
      ['warning', 'AGENT_STALLED', 'stalled'],
      ['warning', 'RECONNECTING', 'stalled'],
    ]);
    expect(items[0].strategyName).toBe('arb');
    expect(items.find(i => i.kind === 'FAILED')?.detail).toBe('instance terminated');
  });

  it('lists halts, except a stopping session killing itself', async () => {
    await session('running');
    await session('stopping', { status: 'STOPPING' });
    await kill({});
    await kill({ strategyId: 2 });
    await kill({ strategyId: 1, listingId: 500 });
    await kill({ strategyId: 1, sessionId: 'running' });
    await kill({ strategyId: 1, sessionId: 'stopping' });
    const items = await attention(client, 'paper', now);
    expect(items.map(i => i.kind).sort()).toEqual(['GLOBAL_HALT', 'LISTING_HALT', 'SESSION_HALT', 'STRATEGY_HALT']);
    expect(items[0].kind).toBe('GLOBAL_HALT');
    expect(items.find(i => i.kind === 'LISTING_HALT')?.symbol).toBe('KX-A');
  });

  it('flags positions under review, and held positions with no recent price as information', async () => {
    await position(1, 500, 10 * UNIT, true);
    await position(2, 501, -5 * UNIT);
    await position(2, 500, 0);
    await client.query(`INSERT INTO ledger.mark VALUES (500, $1, 1, 2, 0)`, [ago(60_000)]);
    await client.query(`INSERT INTO ledger.mark VALUES (501, $1, 1, 2, 0)`, [ago(3 * 3_600_000)]);
    const items = await attention(client, 'paper', now);
    expect(items.map(i => [i.severity, i.kind, i.strategyId, i.listingId])).toEqual([
      ['warning', 'NEEDS_REVIEW', 1, 500],
      ['info', 'NO_PRICE', 2, 501],
    ]);
    expect(items[1].title).toBe('No price for 180m');
  });

  it('the firm series is the sum of its strategies, each with its own line', async () => {
    for (const [id, strategyId] of [['a', 1], ['b', 2]] as const) {
      await session(id, { strategyId, startedAt: new Date('2026-10-07T09:00:00Z') });
      await client.query(`INSERT INTO strategy.session_listing VALUES ($1, $2, 'paper', $3, true)`, [id, strategyId, 499 + strategyId]);
    }
    const fill = (sessionId: string, strategyId: number, listingId: number, realized: number) => client.query(`
      INSERT INTO ledger.fill (source, session_id, strategy_id, listing_id, mode, client_oid_counter, cum_qty_after, side,
        fill_qty, fill_price, fee, net_quantity_after, total_cost_after, realized_pnl_after, fees_after, position_version,
        recorded_at)
      VALUES ('VENUE', $1, $2, $3, 'paper', 1, $4, 0, $4, $5, 0, $4, $6, $7, 0, 1, '2026-10-07T10:00:00Z')`,
    [sessionId, strategyId, listingId, 10 * UNIT, 40 * CENT, 400 * CENT, realized * CENT]);
    await fill('a', 1, 500, 5);
    await fill('b', 2, 501, -2);
    await client.query(`INSERT INTO ledger.mark VALUES (500, '2026-10-07T10:30:00Z', $1, $1, 0), (501, '2026-10-07T10:30:00Z', $2, $2, 0)`,
      [45 * CENT, 38 * CENT]);
    const firm = await series(client, { mode: 'paper', start: '2026-10-07T10:00:00Z', resolution: '3600000' }, now) as any;
    // At 11:00: arb 5 + 10 x 5 = 55c; mm -2 + 10 x -2 = -22c.
    expect(firm.strategies.map((s: any) => [s.strategyId, s.total[1]])).toEqual([[1, String(55 * CENT)], [2, String(-22 * CENT)]]);
    expect(firm.total[1]).toBe(String(33 * CENT));
  });
});
