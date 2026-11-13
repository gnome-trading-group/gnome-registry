import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { recordHeartbeat, samplesOf } from '../lambda/endpoints/strategy-session-heartbeat';
import { BadRequest, ingest, readSamples, Sample } from '../lambda/endpoints/samples';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

describeDb('Samples, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  const now = Date.now();
  const minute = now - (now % 60_000);

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await client.query('SELECT ops.ensure_sample_partitions(3, 7)');
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query('SELECT ops.ensure_sample_partitions(3, 7)');
    await client.query(`TRUNCATE ops.sample, strategy.session, strategy.strategy RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb')`);
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at)
      VALUES ('s1', 1, 'RUNNING', 'paper', '{}', NOW()), ('s2', 1, 'STOPPED', 'paper', '{}', NOW())`);
  });

  async function heartbeat(sessionId: string, samples: unknown): Promise<{ status: number; stored: number }> {
    const body = JSON.stringify({ sessionId, uptimeMs: 1, samples });
    const status = await recordHeartbeat(client, sessionId, body);
    return { status, stored: status === 200 ? await samplesOf(client, sessionId, samples) : 0 };
  }

  const runtime = (offsetMs: number, cpu: number) => ({ kind: 'runtime', tsMs: minute + offsetMs, data: { cpu } });

  it('stores samples apart from the health, which keeps none', async () => {
    const result = await heartbeat('s1', [runtime(0, 1), runtime(10_000, 2)]);

    expect(result).toEqual({ status: 200, stored: 2 });
    const health = (await client.query(`SELECT health FROM strategy.session WHERE session_id = 's1'`)).rows[0].health;
    expect(health).toEqual({ uptimeMs: 1 });
    const rows = (await client.query(`SELECT subject_kind, subject_id, kind, data FROM ops.sample ORDER BY ts`)).rows;
    expect(rows).toEqual([
      { subject_kind: 'session', subject_id: 's1', kind: 'runtime', data: { cpu: 1 } },
      { subject_kind: 'session', subject_id: 's1', kind: 'runtime', data: { cpu: 2 } },
    ]);
  });

  it('ignores a sample sent again after its answer was lost', async () => {
    await heartbeat('s1', [runtime(0, 1)]);
    const again = await heartbeat('s1', [runtime(0, 1), runtime(10_000, 2)]);

    expect(again.stored).toBe(1);
    expect((await client.query('SELECT COUNT(*)::int AS n FROM ops.sample')).rows[0].n).toBe(2);
  });

  it('stores nothing for a session that has ended', async () => {
    expect(await heartbeat('s2', [runtime(0, 1)])).toEqual({ status: 409, stored: 0 });
    expect((await client.query('SELECT COUNT(*)::int AS n FROM ops.sample')).rows[0].n).toBe(0);
  });

  it('still records the heartbeat when the samples cannot be stored', async () => {
    const today = new Date(minute).toISOString().slice(0, 10).replace(/-/g, '');
    await client.query(`DROP TABLE ops.sample_${today}`);

    const result = await heartbeat('s1', [runtime(0, 1)]);

    expect(result).toEqual({ status: 200, stored: 0 });
    const session = (await client.query(`SELECT last_heartbeat_at FROM strategy.session WHERE session_id = 's1'`)).rows[0];
    expect(session.last_heartbeat_at).not.toBeNull();
  });

  it('pages a kind, or every kind under a prefix, oldest first', async () => {
    await heartbeat('s1', [
      runtime(0, 1), runtime(10_000, 2), runtime(20_000, 3),
      { kind: 'latency.oms', tsMs: minute, data: { keys: [] } },
      { kind: 'latency.strategy', tsMs: minute, data: { keys: [] } },
    ]);

    const first = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kind: 'runtime', limit: '2' });
    expect(first.samples.map((s: Sample) => s.data)).toEqual([{ cpu: 1 }, { cpu: 2 }]);
    expect(first.next).toBe(`${minute + 10_000}:runtime`);
    const rest = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kind: 'runtime', after: first.next! });
    expect(rest).toEqual({ samples: [{ kind: 'runtime', tsMs: minute + 20_000, data: { cpu: 3 } }], next: null });

    const latency = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kindPrefix: 'latency.' });
    expect(latency.samples.map((s: Sample) => s.kind)).toEqual(['latency.oms', 'latency.strategy']);
    const window = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kind: 'runtime', from: String(minute + 5_000),
      to: new Date(minute + 20_000).toISOString() });
    expect(window.samples.map((s: Sample) => s.tsMs)).toEqual([minute + 10_000]);
  });

  it('thins a long range to the first sample of each kind in each bucket, paging by whole buckets', async () => {
    const samples = [];
    for (let i = 0; i < 12; i++) samples.push(runtime(i * 10_000, i));
    samples.push({ kind: 'latency.oms', tsMs: minute, data: { keys: [] } });
    samples.push({ kind: 'latency.oms', tsMs: minute + 60_000, data: { keys: [] } });
    await heartbeat('s1', samples);

    const thinned = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kindPrefix: 'runtime',
      everyMs: '60000' });
    expect(thinned.samples.map((s: Sample) => s.data)).toEqual([{ cpu: 0 }, { cpu: 6 }]);
    expect(thinned.next).toBeNull();

    const both = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kindPrefix: 'r',
      everyMs: '60000', limit: '1' });
    expect(both.samples.map((s: Sample) => s.data)).toEqual([{ cpu: 0 }]);
    expect(both.next).toBe(`${minute}:runtime`);
    const rest = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kindPrefix: 'r',
      everyMs: '60000', after: both.next! });
    expect(rest.samples.map((s: Sample) => s.data)).toEqual([{ cpu: 6 }]);

    const everyKind = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kindPrefix: 'l',
      everyMs: '120000' });
    expect(everyKind.samples).toHaveLength(minute % 120_000 === 0 ? 1 : 2);
    await expect(readSamples(client, { subjectKind: 'session', subjectId: 's1', kind: 'runtime', everyMs: '10' }))
      .rejects.toThrow(/everyMs/);
  });

  it('pages a thinned read of several kinds without losing a kind at a page boundary', async () => {
    await heartbeat('s1', [
      { kind: 'latency.oms', tsMs: minute + 10_000, data: { n: 1 } },
      { kind: 'latency.strategy', tsMs: minute + 20_000, data: { n: 2 } },
      { kind: 'latency.oms', tsMs: minute + 70_000, data: { n: 3 } },
      { kind: 'latency.strategy', tsMs: minute + 80_000, data: { n: 4 } },
    ]);
    const seen: unknown[] = [];
    let after: string | undefined;
    do {
      const page = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kindPrefix: 'latency.',
        everyMs: '60000', limit: '1', after });
      seen.push(...page.samples.map((s: Sample) => s.data));
      after = page.next ?? undefined;
    } while (after);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  });

  it('reads a list of kinds', async () => {
    await heartbeat('s1', [runtime(0, 1), { kind: 'session.ledger', tsMs: minute, data: { lag: 0 } },
      { kind: 'session.positions', tsMs: minute, data: { listings: [] } }]);
    const page = await readSamples(client, { subjectKind: 'session', subjectId: 's1', kinds: 'runtime,session.ledger' });
    expect(page.samples.map((s: Sample) => s.kind)).toEqual(['runtime', 'session.ledger']);
    await expect(readSamples(client, { subjectKind: 'session', subjectId: 's1', kinds: 'runtime,Bad' }))
      .rejects.toThrow(/kinds/);
  });

  it('refuses a read that names no single kind or prefix', async () => {
    await expect(readSamples(client, { subjectKind: 'session', subjectId: 's1' })).rejects.toThrow(/exactly one/);
    await expect(readSamples(client, { subjectKind: 'session', subjectId: 's1', kind: 'runtime', kindPrefix: 'r' })).rejects.toThrow(/exactly one/);
    await expect(readSamples(client, { subjectKind: 'session', subjectId: 's1', kind: "runtime' OR 1=1" })).rejects.toThrow(/sample kinds/);
  });

  it('takes a gateway\'s and a shard\'s posted samples, under their own subjects', async () => {
    const post = (subjectKind: string, subjectId: string) =>
      ingest(client, JSON.stringify({ subjectKind, subjectId, samples: [runtime(0, 1), { kind: 'Bad', tsMs: minute, data: {} }] }), now);

    expect(await post('gateway', 'live:kalshi:main')).toEqual({ stored: 1, dropped: 1 });
    expect(await post('shard', 'use1-1b7a9c')).toEqual({ stored: 1, dropped: 1 });
    expect(await post('gateway', 'live:kalshi:main')).toEqual({ stored: 0, dropped: 1 });

    const rows = (await client.query(`SELECT subject_kind, subject_id FROM ops.sample ORDER BY 1`)).rows;
    expect(rows).toEqual([
      { subject_kind: 'gateway', subject_id: 'live:kalshi:main' },
      { subject_kind: 'shard', subject_id: 'use1-1b7a9c' },
    ]);
    const shard = await readSamples(client, { subjectKind: 'shard', subjectId: 'use1-1b7a9c', kind: 'runtime' });
    expect(shard.samples).toEqual([runtime(0, 1)]);
  });

  it('refuses posts for sessions (their heartbeat carries them) and for ids not of their kind', async () => {
    const body = (subjectKind: string, subjectId: string) => JSON.stringify({ subjectKind, subjectId, samples: [] });
    await expect(ingest(client, body('session', 's1'), now)).rejects.toThrow(BadRequest);
    await expect(ingest(client, body('gateway', 'use1-1b7a9c'), now)).rejects.toThrow(/not a gateway id/);
    await expect(ingest(client, body('shard', 'x'.repeat(70)), now)).rejects.toThrow(/not a shard id/);
    await expect(ingest(client, 'not json', now)).rejects.toThrow(/JSON/);
    await expect(ingest(client, JSON.stringify({ subjectKind: 'shard', subjectId: 'a', samples: 'x'.repeat(200_000) }), now))
      .rejects.toThrow(/at most/);
  });

  it('keeps partitions ahead and drops days past retention, whole', async () => {
    const old = new Date(Date.now() - 10 * 86_400_000);
    const oldName = `sample_${old.toISOString().slice(0, 10).replace(/-/g, '')}`;
    const oldDay = old.toISOString().slice(0, 10);
    await client.query(`CREATE TABLE ops.${oldName} PARTITION OF ops.sample
      FOR VALUES FROM ('${oldDay}T00:00:00Z') TO ('${oldDay}T00:00:00Z'::timestamptz + INTERVAL '1 day')`);

    await client.query('SELECT ops.ensure_sample_partitions(3, 7)');

    const names = (await client.query(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'sample' ORDER BY 1`)).rows.map(r => r.relname);
    expect(names).not.toContain(oldName);
    const ahead = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
    expect(names).toContain(`sample_${ahead}`);
  });
});
