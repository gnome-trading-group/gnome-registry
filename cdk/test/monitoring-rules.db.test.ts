import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { runRules } from '../lambda/monitoring/rules';
import { attention } from '../lambda/endpoints/monitoring-attention';
import { ALERT_TYPES } from '../lambda/alerts/alert-types';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const now = new Date('2026-10-14T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const HEALTHY = {
  uptimeMs: 600_000, agents: [{ name: 'OmsAgent', hotPath: true, stalledMs: 0, exited: false }], listings: [],
  gateways: [{ name: 'KalshiReader', reconnecting: false, resyncsLast5m: 0 }],
  ledger: { lastAcceptedAgoMs: 100, consecutiveFailures: 0, fenced: false },
  risk: { stale: false, unguarded: false, unbuildablePolicies: 0, droppedLatches: 0 },
  rateLimit: [{ account: 'steady-heron-01', throttling: false }],
};

describeDb('monitoring rules against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE alert.alert, ledger.fill, ledger.position, ledger.order, ledger.mark, strategy.session_listing,
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.listing_spec, sm.listing, sm.security,
      sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'mbp-10', 'KALSHI')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb'), ('mm')`);
  });

  async function session(id: string, f: { mode?: string; status?: string; strategyId?: number; health?: unknown } = {}) {
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at,
        last_heartbeat_at, health)
      VALUES ($1, $2, $3, $4, '{}', $5, $6, $7)`,
    [id, f.strategyId ?? 1, f.status ?? 'RUNNING', f.mode ?? 'paper', ago(600_000), ago(2_000),
      JSON.stringify(f.health ?? HEALTHY)]);
  }

  async function kill(target: { strategyId?: number; sessionId?: string; exchangeId?: number }, actor?: string) {
    await client.query('BEGIN');
    if (actor) await client.query("SELECT set_config('gnome.actor', $1, true), set_config('gnome.reason', 'why', true)", [actor]);
    await client.query(`INSERT INTO risk.policy (policy_type, strategy_id, session_id, exchange_id, parameters, enabled)
      VALUES ('KILL_SWITCH', $1, $2, $3, '{}', true)`, [target.strategyId ?? null, target.sessionId ?? null, target.exchangeId ?? null]);
    await client.query('COMMIT');
  }

  it('reads the new health: risk it can\'t trust, policies it can\'t apply, dropped halts, throttling and resyncs', async () => {
    await session('s1', { health: {
      ...HEALTHY,
      gateways: [{ name: 'KalshiReader', reconnecting: false, resyncsLast5m: 4 }],
      risk: { stale: true, unguarded: false, unbuildablePolicies: 2, droppedLatches: 1 },
      rateLimit: [{ account: 'steady-heron-01', throttling: true }],
    } });
    const findings = await runRules(client, now);
    expect(findings.map(f => [f.kind, f.key]).sort()).toEqual([
      ['BOOK_RESYNCS', 'BOOK_RESYNCS:s1:KalshiReader'],
      ['LATCHES_DROPPED', 'LATCHES_DROPPED:s1:-'],
      ['POLICY_UNBUILDABLE', 'POLICY_UNBUILDABLE:s1:-'],
      ['RATE_LIMIT_THROTTLING', 'RATE_LIMIT_THROTTLING:s1:steady-heron-01'],
      ['RISK_STALE', 'RISK_STALE:s1:-'],
    ]);
  });

  it('unguarded outranks stale: either way nothing trades, and unguarded says why', async () => {
    await session('s1', { health: { ...HEALTHY, risk: { stale: true, unguarded: true, unbuildablePolicies: 0, droppedLatches: 0 } } });
    expect((await runRules(client, now)).map(f => f.kind)).toEqual(['RISK_UNGUARDED']);
  });

  it('keys a finding by what it concerns, never by its title', async () => {
    const stalled = (ms: number) => ({ ...HEALTHY, agents: [{ name: 'OmsAgent', hotPath: true, stalledMs: ms, exited: false },
      { name: 'StrategyAgent', hotPath: true, stalledMs: ms, exited: false }] });
    await session('s1', { health: stalled(5_000) });
    const first = (await runRules(client, now)).map(f => f.key);
    await client.query(`UPDATE strategy.session SET health = $1`, [JSON.stringify(stalled(9_000))]);
    const second = await runRules(client, now);
    expect(second.map(f => f.key)).toEqual(first);
    expect(first).toEqual(['AGENT_STALLED:s1:OmsAgent', 'AGENT_STALLED:s1:StrategyAgent']);
    expect(second[0].title).toBe('OmsAgent stalled for 9s');
    expect(second[0].facts.stalledMs).toBe(9_000);
  });

  it('gives each halt the mode it matters to, and who turned it on', async () => {
    await session('live', { mode: 'live', strategyId: 1 });
    await kill({ strategyId: 1 }, 'oms');
    await kill({ strategyId: 2 }, 'ops@gnome.group');
    await kill({ exchangeId: 1 });
    await kill({ strategyId: 1, sessionId: 'live' }, 'oms');
    const halts = (await runRules(client, now)).filter(f => f.kind.endsWith('HALT'));
    expect(halts.map(f => [f.kind, f.strategyId, f.mode, f.visibleIn, f.actor])).toEqual([
      ['STRATEGY_HALT', 1, 'live', ['live', 'paper'], 'oms'],
      ['STRATEGY_HALT', 2, 'paper', ['live', 'paper'], 'ops@gnome.group'],
      ['EXCHANGE_HALT', null, 'live', ['live', 'paper'], null],
      ['SESSION_HALT', 1, 'live', ['live'], 'oms'],
    ]);
    // The overview still shows a strategy's halt on both pages, and a session's only on its own.
    expect((await attention(client, 'paper', now)).map(i => i.kind).sort()).toEqual(['EXCHANGE_HALT', 'STRATEGY_HALT', 'STRATEGY_HALT']);
    expect((await attention(client, 'live', now)).find(i => i.kind === 'SESSION_HALT')?.actor).toBe('oms');
  });

  it('every kind a rule can produce has an alert type', async () => {
    const kinds = ['GLOBAL_HALT', 'EXCHANGE_HALT', 'STRATEGY_HALT', 'STRATEGY_EXCHANGE_HALT', 'LISTING_HALT',
      'SESSION_HALT', 'SILENT', 'LEDGER_FENCED', 'LEDGER_FAILING', 'RISK_STALE', 'RISK_UNGUARDED', 'POLICY_UNBUILDABLE',
      'LATCHES_DROPPED', 'AGENT_EXITED', 'AGENT_STALLED', 'RECONNECTING', 'BOOK_RESYNCS', 'RATE_LIMIT_THROTTLING',
      'FAILED', 'START_STUCK', 'STOP_STUCK', 'NEEDS_REVIEW', 'NO_PRICE', 'SETTLEMENT_PENDING', 'SETTLEMENT_BLOCKED',
      'RECON_MISMATCH', 'RECON_STALE', 'BALANCE_LOW', 'SHARD_BALANCE_LOW', 'ALLOCATION_EXCEEDS_BALANCE',
      'DRAINING_EXPOSURE', 'ACCOUNT_DUE_FOR_ROTATION', 'ACCOUNT_READY_TO_RETIRE', 'FEE_MISMATCH',
      'FEE_SCHEDULE_MISSING'];
    const rulesDir = path.join(__dirname, '..', 'lambda', 'monitoring', 'rules');
    const source = fs.readdirSync(rulesDir).filter(f => f.endsWith('.ts'))
      .map(f => fs.readFileSync(path.join(rulesDir, f), 'utf8')).join('\n');
    const produced = new Set([...source.matchAll(/'([A-Z][A-Z_]+[A-Z])'/g)].map(m => m[1])
      .filter(k => !['SUBMITTED', 'STARTING', 'RUNNING', 'STOPPING', 'FAILED_', 'KILL_SWITCH', 'DRAINING', 'ACTIVE',
        'RETIRED', 'BREAK', 'UNKNOWN_VENUE_POSITION', 'ERROR', 'OPEN', 'KALSHI', 'POLYMARKET_US', 'VENUE', 'MAKER',
        'TAKER'].includes(k)));
    for (const kind of produced) expect(kinds).toContain(kind);
    for (const kind of kinds) expect(ALERT_TYPES[kind]).toBeDefined();
  });
});
