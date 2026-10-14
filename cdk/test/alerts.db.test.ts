import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { detect, markDelivered, MASS_SILENCE, record } from '../lambda/alerts/alert-store';
import { AlertEvent, RecordResult } from '../lambda/alerts/model';
import { recordHeartbeat } from '../lambda/endpoints/strategy-session-heartbeat';
import { StrategySessionHandler } from '../lambda/endpoints/strategy-sessions';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const t0 = new Date('2026-10-14T12:00:00Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const HEALTHY = {
  uptimeMs: 600_000, agents: [{ name: 'OmsAgent', hotPath: true, stalledMs: 0, exited: false }], listings: [],
  gateways: [{ name: 'KalshiReader', reconnecting: false }],
  ledger: { lastAcceptedAgoMs: 100, consecutiveFailures: 0, fenced: false },
};

describeDb('alerts against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    process.env.STAGE = 'prod';
    await client.query(`TRUNCATE alert.alert, ledger.fill, ledger.position, ledger.order, ledger.mark,
      strategy.session_listing, risk.policy, risk.policy_history, strategy.session, strategy.strategy,
      sm.listing_spec, sm.listing, sm.security, sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'mbp-10', 'KALSHI')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'X', 0)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_symbol)
      VALUES (500, 1, 1, 'KX-A')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb'), ('mm')`);
  });

  // A session as of t0; its heartbeat is `heard` minutes before the moment a test looks.
  async function session(id: string, f: { mode?: string; status?: string; strategyId?: number; heartbeatAt?: Date | null;
    health?: unknown; instance?: string | null; startedAt?: Date } = {}) {
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at,
        last_heartbeat_at, health, instance_id)
      VALUES ($1, $2, $3, $4, '{}', $5, $6, $7, $8)`,
    [id, f.strategyId ?? 1, f.status ?? 'RUNNING', f.mode ?? 'live', f.startedAt ?? at(-60),
      f.heartbeatAt === undefined ? t0 : f.heartbeatAt, JSON.stringify(f.health ?? HEALTHY),
      f.instance === undefined ? 'i-1' : f.instance]);
  }

  async function setStatus(id: string, status: string, when: Date) {
    await client.query(`UPDATE strategy.session SET status = $2, date_modified = $3 WHERE session_id = $1`, [id, status, when]);
  }

  async function kill(target: { strategyId?: number; sessionId?: string; exchangeId?: number }, actor: string | null,
    reason = 'market risk limit breached (policy 4)') {
    await client.query('BEGIN');
    if (actor !== null) {
      await client.query("SELECT set_config('gnome.actor', $1, true), set_config('gnome.reason', $2, true)", [actor, reason]);
    }
    await client.query(`INSERT INTO risk.policy (policy_type, strategy_id, session_id, exchange_id, parameters, enabled)
      VALUES ('KILL_SWITCH', $1, $2, $3, '{}', true)`,
    [target.strategyId ?? null, target.sessionId ?? null, target.exchangeId ?? null]);
    await client.query('COMMIT');
  }

  // One tick: detect, then record what it found, as the router does. Returns the notifications sent.
  async function tick(now: Date): Promise<{ type: string; status: string; severity: string; sinks: string[] }[]> {
    const sent = [];
    for (const event of await detect(client, now)) {
      const result = await record(client, event, now);
      if (result.notify) {
        sent.push({ type: result.delivery.type, status: result.delivery.status, severity: result.delivery.severity,
          sinks: result.delivery.sinks });
        for (const sink of result.delivery.sinks) await markDelivered(client, result.delivery.alertId!, sink, 'ts-1');
      }
    }
    return sent;
  }

  const ingest = (e: Partial<AlertEvent> & { type: string }, stateAt = t0): AlertEvent => ({
    action: 'FIRING', key: `${e.type}:${e.sessionId ?? '-'}`, source: 'ingest', title: e.type, stateAt: stateAt.toISOString(), ...e,
  });

  it('a normal stop sends nothing: STOPPING, its own kill, agents exiting, STOPPED, the kill released', async () => {
    await session('s1');
    expect(await tick(at(0))).toEqual([]);

    await setStatus('s1', 'STOPPING', at(1));
    await kill({ strategyId: 1, sessionId: 's1' }, 'ops@gnome.group', 'session stop');
    await client.query(`UPDATE strategy.session SET health = $2 WHERE session_id = $1`,
      ['s1', JSON.stringify({ ...HEALTHY, agents: [{ name: 'OmsAgent', hotPath: true, stalledMs: 0, exited: true }] })]);
    expect(await tick(at(1))).toEqual([]);
    // What the session reports while it shuts down is recorded, not sent.
    const shutdownError = await record(client, ingest({ type: 'FATAL_ERROR', sessionId: 's1' }, at(1)), at(1));
    expect(shutdownError.notify).toBe(false);

    await setStatus('s1', 'STOPPED', at(2));
    await client.query('BEGIN');
    await client.query("SELECT set_config('gnome.actor', 'system', true), set_config('gnome.reason', 'instance terminated', true)");
    await client.query(`UPDATE risk.policy SET enabled = false WHERE session_id = 's1'`);
    await client.query('COMMIT');
    // Silent for long after it's gone: it ended on purpose.
    expect(await tick(at(30))).toEqual([]);
  });

  it('the launcher stopping a session announces it, and nothing else', async () => {
    await session('s1');
    await setStatus('s1', 'STOPPING', at(1));
    await kill({ strategyId: 1, sessionId: 's1' }, 'launcher:cs2-prematch', 'session stop');
    const notice = await record(client, ingest({ type: 'SESSION_STOPPED_AUTO', sessionId: 's1' }, at(1)), at(1));
    expect(notice.notify && notice.delivery.severity).toBe('INFO');
    expect(await tick(at(2))).toEqual([]);
  });

  it('a session stopped before it got an instance releases its kill as it stops', async () => {
    await session('s1', { status: 'SUBMITTED', instance: null, heartbeatAt: null });
    await setStatus('s1', 'STOPPING', at(0));
    await kill({ strategyId: 1, sessionId: 's1' }, 'ops@gnome.group', 'session stop');
    const handler = new StrategySessionHandler();
    handler.client = client;
    const res = await handler.modifyOne({ sessionId: 's1' }, JSON.stringify({ status: 'STOPPED', expectedStatus: ['STOPPING'] }));
    expect(res.statusCode).toBe(200);
    const policy = (await client.query(`SELECT enabled FROM risk.policy WHERE session_id = 's1'`)).rows[0];
    expect(policy.enabled).toBe(false);
    const history = (await client.query(`SELECT actor, reason FROM risk.policy_history ORDER BY history_id DESC LIMIT 1`)).rows[0];
    expect(history).toEqual({ actor: 'system', reason: 'stopped before launch' });
    expect(await tick(at(1))).toEqual([]);
  });

  it('a crash pages and stays paged: silent, then failed, never resolved without a person', async () => {
    await session('s1');
    expect(await tick(at(2))).toEqual([
      { type: 'SILENT', status: 'FIRING', severity: 'CRITICAL', sinks: ['incidentio', 'slack'] },
    ]);
    await client.query(`UPDATE strategy.session SET status = 'FAILED', stopped_at = $2, failure_reason = 'boom'
      WHERE session_id = $1`, ['s1', at(3)]);
    expect(await tick(at(3))).toEqual([
      { type: 'FAILED', status: 'FIRING', severity: 'CRITICAL', sinks: ['incidentio', 'slack'] },
      { type: 'SILENT', status: 'RESOLVED', severity: 'CRITICAL', sinks: ['incidentio', 'slack'] },
    ]);
    const open = (await client.query(`SELECT type FROM alert.alert WHERE status = 'FIRING'`)).rows.map(r => r.type);
    expect(open).toEqual(['FAILED']);
  });

  it('a failed launch with no instance is the launcher\'s to report, not the tick\'s', async () => {
    await session('s1', { status: 'FAILED', instance: null, heartbeatAt: null });
    await client.query(`UPDATE strategy.session SET stopped_at = $1 WHERE session_id = 's1'`, [at(0)]);
    expect(await tick(at(1))).toEqual([]);
  });

  it('paper sessions and dev never page', async () => {
    await session('paper', { mode: 'paper' });
    expect(await tick(at(2))).toEqual([{ type: 'SILENT', status: 'FIRING', severity: 'ERROR', sinks: ['slack'] }]);
    process.env.STAGE = 'dev';
    await session('live');
    expect(await tick(at(3))).toEqual([{ type: 'SILENT', status: 'FIRING', severity: 'ERROR', sinks: ['slack'] }]);
  });

  it('kill switches page when automatic and are a record when a person turns them on', async () => {
    await session('s1');
    await kill({ strategyId: 1 }, 'oms');
    await kill({ strategyId: 2 }, 'ops@gnome.group', 'pausing for the event');
    await kill({ exchangeId: 1 }, null);
    const sent = await tick(at(0));
    expect(sent.map(s => [s.type, s.severity]).sort()).toEqual([
      ['EXCHANGE_HALT', 'CRITICAL'], ['STRATEGY_HALT', 'CRITICAL'], ['STRATEGY_HALT', 'INFO'],
    ]);
    const oms = (await client.query(`SELECT body, actor, mode FROM alert.alert WHERE actor = 'oms'`)).rows[0];
    expect(oms).toEqual({ body: 'market risk limit breached (policy 4)', actor: 'oms', mode: 'live' });
    // Strategy 2 has no live session, so its halt matters to paper and is capped.
    const ops = (await client.query(`SELECT mode FROM alert.alert WHERE actor = 'ops@gnome.group'`)).rows[0];
    expect(ops.mode).toBe('paper');
  });

  it('disabling a kill switch resolves its alert', async () => {
    await session('s1');
    await kill({ strategyId: 1 }, 'oms');
    expect(await tick(at(0))).toEqual([
      { type: 'STRATEGY_HALT', status: 'FIRING', severity: 'CRITICAL', sinks: ['incidentio', 'slack'] },
    ]);
    await client.query(`UPDATE risk.policy SET enabled = false`);
    expect(await tick(at(0.5))).toEqual([
      { type: 'STRATEGY_HALT', status: 'RESOLVED', severity: 'CRITICAL', sinks: ['incidentio', 'slack'] },
    ]);
  });

  it('a stall must last two ticks to notify, and a blip never does', async () => {
    const stalled = { ...HEALTHY, agents: [{ name: 'OmsAgent', hotPath: true, stalledMs: 5_000, exited: false }] };
    await session('s1', { health: stalled, heartbeatAt: at(0) });
    expect(await tick(at(0))).toEqual([]);
    await client.query(`UPDATE strategy.session SET health = $1`, [JSON.stringify(HEALTHY)]);
    expect(await tick(at(1))).toEqual([]);
    expect((await client.query('SELECT COUNT(*)::int AS n FROM alert.alert')).rows[0].n).toBe(0);

    await client.query(`UPDATE strategy.session SET health = $1, last_heartbeat_at = $2`, [JSON.stringify(stalled), at(2)]);
    expect(await tick(at(2))).toEqual([]);
    await client.query(`UPDATE strategy.session SET last_heartbeat_at = $1`, [at(3)]);
    expect(await tick(at(3))).toEqual([{ type: 'AGENT_STALLED', status: 'FIRING', severity: 'ERROR', sinks: ['slack'] }]);
  });

  it(`${MASS_SILENCE} sessions going silent at once page once, about the registry`, async () => {
    for (const id of ['a', 'b', 'c']) await session(id);
    const sent = await tick(at(2));
    expect(sent.filter(s => s.sinks.includes('incidentio')).map(s => s.type)).toEqual(['SESSIONS_SILENT_MULTIPLE']);
    expect(sent.filter(s => s.type === 'SILENT').map(s => s.sinks)).toEqual([['slack'], ['slack'], ['slack']]);
  });

  it('repeats of an open alert notify once; concurrent duplicates too', async () => {
    const event = ingest({ type: 'CUSTOM', severity: 'WARNING', title: 'fair value diverged' });
    const results = await Promise.all([1, 2, 3].map(async () => {
      const c = await pool.connect();
      try {
        return await record(c, event, t0);
      } finally {
        c.release();
      }
    }));
    expect(results.filter(r => r.notify)).toHaveLength(1);
    const again = await record(client, { ...event, stateAt: at(1).toISOString() }, at(1));
    expect(again.notify).toBe(false);
    const row = (await client.query('SELECT fire_count FROM alert.alert')).rows[0];
    expect(row.fire_count).toBe(2);
  });

  it('an alarm that resolves before its late ALARM event stays resolved', async () => {
    const alarm = (action: 'FIRING' | 'RESOLVED', when: Date): AlertEvent => ({
      action, key: 'cw:arn:alarm', type: 'CLOUDWATCH_ALARM', source: 'cloudwatch', severity: 'ERROR',
      title: 'Registry-ExchangeSync-FaultCount-Error', labels: { alarmName: 'Registry-ExchangeSync-FaultCount-Error' },
      stateAt: when.toISOString(),
    });
    expect((await record(client, alarm('RESOLVED', at(2)), at(2))).notify).toBe(false);
    expect((await record(client, alarm('FIRING', at(1)), at(3))).notify).toBe(false);
    const fired = await record(client, alarm('FIRING', at(4)), at(4)) as Extract<RecordResult, { notify: true }>;
    expect(fired.notify).toBe(true);
    expect(fired.delivery.runbook?.url).toMatch(/cloudwatch\/Registry\.md$/);
    expect(fired.delivery.severity).toBe('ERROR');
  });

  it('a sink that failed is retried by the next tick', async () => {
    const event = ingest({ type: 'FATAL_ERROR', sessionId: 's1' });
    await session('s1');
    const first = await record(client, event, t0) as Extract<RecordResult, { notify: true }>;
    expect(first.delivery.sinks).toEqual(['incidentio', 'slack']);
    await markDelivered(client, first.delivery.alertId!, 'incidentio', null);
    const events = await detect(client, at(2));
    const redeliver = events.find(e => e.action === 'REDELIVER')!;
    const retried = await record(client, redeliver, at(2)) as Extract<RecordResult, { notify: true }>;
    expect(retried.delivery.sinks).toEqual(['slack']);
  });

  it('reported events close quietly after a day; unknown types are kept as CUSTOM', async () => {
    await record(client, ingest({ type: 'SOMETHING_NEW', severity: 'CRITICAL' }), t0);
    const row = (await client.query('SELECT type, severity, labels FROM alert.alert')).rows[0];
    expect(row).toEqual({ type: 'CUSTOM', severity: 'WARNING', labels: { originalType: 'SOMETHING_NEW' } });
    const expire = (await detect(client, at(25 * 60))).find(e => e.action === 'RESOLVED')!;
    expect(expire.silent).toBe(true);
    expect((await record(client, expire, at(25 * 60))).notify).toBe(false);
    expect((await client.query('SELECT status FROM alert.alert')).rows[0].status).toBe('RESOLVED');
  });

  it('only one tick detects at a time', async () => {
    await session('s1');
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock(4242200)');
      expect(await detect(client, at(2))).toEqual([]);
      await other.query('ROLLBACK');
    } finally {
      other.release();
    }
    expect((await detect(client, at(2))).length).toBeGreaterThan(0);
  });

  it('a heartbeat moves a session that never reported RUNNING into RUNNING', async () => {
    await session('s1', { status: 'STARTING', heartbeatAt: null });
    expect(await recordHeartbeat(client, 's1', JSON.stringify({ sessionId: 's1', ...HEALTHY }))).toBe(200);
    expect((await client.query(`SELECT status FROM strategy.session`)).rows[0].status).toBe('RUNNING');
  });

  it('a session stuck starting or stopping is flagged', async () => {
    await session('booting', { status: 'STARTING', heartbeatAt: null, startedAt: at(-20) });
    await session('ending', { status: 'STOPPING', heartbeatAt: at(-30) });
    await setStatus('ending', 'STOPPING', at(-15));
    const sent = await tick(at(0));
    expect(sent.map(s => [s.type, s.severity]).sort()).toEqual([['START_STUCK', 'ERROR'], ['STOP_STUCK', 'ERROR']]);
  });
});
