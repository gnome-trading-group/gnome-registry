import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { listSubjects, patchKeyAliases, upsertSubjects } from '../lambda/endpoints/proposition-subjects';
import { listMerges, mergeSubjects, unmergeSubject } from '../lambda/endpoints/proposition-subject-merges';
import { PropositionError } from '../lambda/endpoints/propositions-common';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

describeDb('subject key aliases, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE sm.security, sm.proposition_subject, sm.exchange RESTART IDENTITY CASCADE');
  });

  async function subject(key: string): Promise<number> {
    return (await upsertSubjects(client, [{ key }]))[0].subject_id;
  }

  async function aliases(subjectId: number) {
    return (await listSubjects(client, { subjectIds: String(subjectId), keyAliases: 'true' }))
      .map((a: any) => [a.kind, a.key, a.canonical_key, a.flags, a.origin]);
  }

  async function markDerived(subjectId: number) {
    await client.query("UPDATE sm.proposition_subject SET derived_at = date_modified WHERE subject_id = $1", [subjectId]);
  }

  async function isDirty(subjectId: number): Promise<boolean> {
    return (await client.query(
      'SELECT derived_at IS NULL OR date_modified > derived_at AS dirty FROM sm.proposition_subject WHERE subject_id = $1',
      [subjectId])).rows[0].dirty;
  }

  const reconcile = (key: string, canonicalKey: string, flags: string[] = []) =>
    ({ kind: 'ENTITY', key, canonicalKey, flags, origin: 'RECONCILE', reason: 'judged the same team' });

  it('stores aliases on the subject, lists them, and marks the subject for a fresh derivation', async () => {
    const game = await subject('game:nba:2026-11-11:bos-tor');
    await markDerived(game);
    expect(await isDirty(game)).toBe(false);

    await patchKeyAliases(client, { subjectId: game, set: [reconcile('bos', 'celtics'), reconcile('tor', 'raptors')] },
      'classifier:key-reconcile');

    expect(await aliases(game)).toEqual([
      ['ENTITY', 'bos', 'celtics', [], 'RECONCILE'],
      ['ENTITY', 'tor', 'raptors', [], 'RECONCILE'],
    ]);
    expect((await listSubjects(client, { subjectIds: String(game), keyAliases: 'true' }))[0].actor)
      .toBe('classifier:key-reconcile');
    expect(await isDirty(game)).toBe(true);
  });

  it('marks every reading on the subject as changed, so derivation re-derives all of it', async () => {
    const game = await subject('game:nba:2026-11-11:bos-tor');
    const [a, b] = [1, 2];
    for (const n of [a, b]) {
      await client.query("INSERT INTO sm.security (symbol, description, type) VALUES ($1, $1, 1)", [`s${n}`]);
    }
    await client.query(`INSERT INTO sm.contract_proposition (security_id, subject_id, extracted_subject_id, fields, method,
        extractor_version, source_hash, date_modified)
      VALUES (1, $1, $1, '{"kind":"WINNER"}', 'VENUE', 'v1', 'h1', now() - interval '1 day'),
             (2, $1, $1, '{"kind":"WINNER"}', 'VENUE', 'v1', 'h2', now() - interval '1 day')`, [game]);
    await client.query("UPDATE sm.proposition_subject SET derived_at = now() - interval '1 hour' WHERE subject_id = $1", [game]);
    await patchKeyAliases(client, { subjectId: game, set: [reconcile('bos', 'celtics')] }, 'me');
    const changed = (await client.query(`SELECT count(*)::int AS n FROM sm.contract_proposition p
      JOIN sm.proposition_subject s ON s.subject_id = p.subject_id
      WHERE p.subject_id = $1 AND p.date_modified > s.derived_at`, [game])).rows[0].n;
    expect(changed).toBe(2);
  });

  it('carries the flags it knows and refuses others', async () => {
    const race = await subject('us-senate-2026-texas');
    await patchKeyAliases(client, { subjectId: race, set: [reconcile('james-talarico', 'democratic', ['PARTY_NOMINEE'])] }, 'me');
    expect(await aliases(race)).toEqual([['ENTITY', 'james-talarico', 'democratic', ['PARTY_NOMINEE'], 'RECONCILE']]);
    await expect(patchKeyAliases(client, { subjectId: race, set: [reconcile('a', 'b', ['WHATEVER'])] }, 'me'))
      .rejects.toThrow('flag must be one of');
    await expect(patchKeyAliases(client, { subjectId: race, set: [reconcile('a', 'a')] }, 'me'))
      .rejects.toThrow('cannot be an alias of itself');
  });

  it('refuses a chain, and leaves the subject as it was', async () => {
    const game = await subject('game:nfl:2026-11-15:jax-ten');
    await patchKeyAliases(client, { subjectId: game, set: [reconcile('jac', 'jax')] }, 'me');
    const error = await patchKeyAliases(client, { subjectId: game, set: [reconcile('jaguars', 'jac')] }, 'me')
      .catch(e => e);
    expect(error).toBeInstanceOf(PropositionError);
    expect(error.statusCode).toBe(409);
    expect(await aliases(game)).toEqual([['ENTITY', 'jac', 'jax', [], 'RECONCILE']]);
  });

  it('removes an alias', async () => {
    const game = await subject('game:nfl:2026-11-15:jax-ten');
    await patchKeyAliases(client, { subjectId: game, set: [reconcile('jac', 'jax')] }, 'me');
    await patchKeyAliases(client, { subjectId: game, remove: [{ kind: 'ENTITY', key: 'jac' }] }, 'me');
    expect(await aliases(game)).toEqual([]);
  });

  it('keeps a merged subject\'s aliases on the subject it was merged into, and drops a merge\'s with its unmerge', async () => {
    const kept = await subject('game:cs2:2026-11-10:isg-reda');
    const merged = await subject('game:cs2:2026-11-10:redaisg-1400');
    const { merge_log_id: mergeLogId } = await mergeSubjects(client, merged, kept, 'classifier:subject-merger');
    expect(mergeLogId).toBe((await listMerges(client, { history: 'true' }))[0].merge_log_id);

    await patchKeyAliases(client, { subjectId: merged, set: [
      { kind: 'ENTITY', key: 'reda', canonicalKey: 'red-canids-academy', origin: 'MERGE', mergeLogId },
      reconcile('isg', 'isurus'),
    ] }, 'classifier:subject-merger');
    const stored = (await listSubjects(client, { subjectIds: String(merged), keyAliases: 'true' }));
    expect(stored.map((a: any) => a.subject_id)).toEqual([kept, kept]);
    expect(await aliases(kept)).toEqual(await aliases(merged));

    const result = await unmergeSubject(client, merged, 'me@example.com');
    expect(result.key_aliases_removed).toBe(1);
    expect(await aliases(kept)).toEqual([['ENTITY', 'isg', 'isurus', [], 'RECONCILE']]);
  });

  it('only takes a MERGE alias for a merge into this subject', async () => {
    const one = await subject('a');
    const other = await subject('b');
    const third = await subject('c');
    await mergeSubjects(client, third, other, 'me');
    const mergeLogId = (await listMerges(client, { history: 'true' }))[0].merge_log_id;
    await expect(patchKeyAliases(client, { subjectId: one, set: [
      { kind: 'ENTITY', key: 'x', canonicalKey: 'y', origin: 'MERGE', mergeLogId },
    ] }, 'me')).rejects.toThrow('is not a merge into this subject');
    await expect(patchKeyAliases(client, { subjectId: one, set: [
      { kind: 'ENTITY', key: 'x', canonicalKey: 'y', origin: 'MERGE' },
    ] }, 'me')).rejects.toThrow('names its mergeLogId');
  });

  it('pages the listing like every other read', async () => {
    const game = await subject('game:nfl:2026-11-15:jax-ten');
    await patchKeyAliases(client, { subjectId: game, set: [reconcile('a1', 'x'), reconcile('a2', 'x'), reconcile('a3', 'x')] }, 'me');
    const page = (limit: number, offset: number) => listSubjects(client,
      { subjectIds: String(game), keyAliases: 'true', limit: String(limit), offset: String(offset) });
    expect((await page(2, 0)).map((a: any) => a.key)).toEqual(['a1', 'a2']);
    expect((await page(2, 2)).map((a: any) => a.key)).toEqual(['a3']);
  });

  it('lists the latest aliases across subjects, each on the subject it is read on', async () => {
    const kept = await subject('game:cs2:2026-11-12:nordic-rgg');
    const merged = await subject('game:cs2:2026-11-12:rggnor-1300');
    const other = await subject('game:nba:2026-11-11:bos-tor');
    await patchKeyAliases(client, { subjectId: merged, set: [reconcile('rounds', 'rgg')] }, 'classifier:key-reconcile');
    await mergeSubjects(client, merged, kept, 'classifier:subject-merger');
    await patchKeyAliases(client, { subjectId: other, set: [{ ...reconcile('bos', 'celtics'), origin: 'MANUAL' }] }, 'me');

    const rows = await listSubjects(client, { keyAliases: 'true' });
    expect(rows.map((a: any) => [a.key, a.subject_id, a.canonical_subject_id, a.canonical_subject_key, a.origin])).toEqual([
      ['bos', other, other, 'game:nba:2026-11-11:bos-tor', 'MANUAL'],
      ['rounds', merged, kept, 'game:cs2:2026-11-12:nordic-rgg', 'RECONCILE'],
    ]);
    expect((await listSubjects(client, { keyAliases: 'true', origin: 'RECONCILE' })).map((a: any) => a.key)).toEqual(['rounds']);
    expect(await listSubjects(client, { keyAliases: 'true', since: '2999-01-01T00:00:00Z' })).toEqual([]);
    expect((await listSubjects(client, { keyAliases: 'true', limit: '1', offset: '1' })).map((a: any) => a.key)).toEqual(['rounds']);
  });

  it('refuses an unknown origin or a since that is not a time', async () => {
    await expect(listSubjects(client, { keyAliases: 'true', origin: 'JUDGE' })).rejects.toThrow('origin must be one of');
    await expect(listSubjects(client, { keyAliases: 'true', since: 'yesterday' })).rejects.toThrow('since must be an ISO');
  });
});
