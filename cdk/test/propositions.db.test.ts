import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { listSubjects, upsertSubjects } from '../lambda/endpoints/proposition-subjects';
import { listMerges, mergeSubjects, unmergeSubject } from '../lambda/endpoints/proposition-subject-merges';
import { IUpsertProposition, listPropositions, upsertPropositions } from '../lambda/endpoints/contract-propositions';
import { parseReconcile, reconcileRelationships } from '../lambda/endpoints/contract-relationship-reconcile';
import { PropositionError } from '../lambda/endpoints/propositions-common';
import { listSources, upsertSources } from '../lambda/endpoints/contract-sources';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

describeDb('propositions, subjects and derived relationships, against Postgres', () => {
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

  async function securities(n: number): Promise<number[]> {
    const ids = [];
    for (let i = 0; i < n; i++) {
      ids.push((await client.query(
        "INSERT INTO sm.security (symbol, description, type) VALUES ($1, $1, 1) RETURNING security_id", [`s${i}`],
      )).rows[0].security_id);
    }
    return ids;
  }

  async function subject(key: string): Promise<number> {
    return (await upsertSubjects(client, [{ key }]))[0].subject_id;
  }

  function proposition(securityId: number, extractedSubjectId: number, value = 1): IUpsertProposition {
    return {
      securityId, extractedSubjectId, fields: { kind: 'THRESHOLD', comparator: 'GT', value },
      method: 'VENUE', extractorVersion: 'v1', sourceHash: `h${value}`,
    };
  }

  async function subjectRow(subjectId: number) {
    return (await listSubjects(client, { subjectIds: String(subjectId) }))[0];
  }

  async function markDerived(subjectId: number) {
    await client.query('UPDATE sm.proposition_subject SET derived_at = now() WHERE subject_id = $1', [subjectId]);
  }

  async function isDirty(subjectId: number): Promise<boolean> {
    return (await listSubjects(client, { dirty: 'true' })).some((s) => s.subject_id === subjectId);
  }

  describe('subjects', () => {
    it('upserts by key and keeps a description an empty one would erase', async () => {
      const [first] = await upsertSubjects(client, [{ key: 'btc-usd', description: 'Bitcoin in US dollars' }]);
      const [again] = await upsertSubjects(client, [{ key: 'btc-usd' }]);
      expect(again.subject_id).toBe(first.subject_id);
      expect(again.description).toBe('Bitcoin in US dollars');
      expect(await subjectRow(first.subject_id)).toMatchObject({ key: 'btc-usd', proposition_count: 0, has_embedding: false });
    });

    it('suggests the nearest subjects by embedding, leaving out aliases', async () => {
      const [a, b, c] = [await subject('btc-usd'), await subject('bitcoin'), await subject('eth-usd')];
      const vec = (x: number) => `[${[x, 1 - x, ...Array(1022).fill(0)].join(',')}]`;
      for (const [id, x] of [[a, 1], [b, 0.95], [c, 0]] as const) {
        await client.query('UPDATE sm.proposition_subject SET embedding = $1 WHERE subject_id = $2', [vec(x), id]);
      }
      expect((await listSubjects(client, { similarTo: String(a) })).map((s) => s.key)).toEqual(['bitcoin', 'eth-usd']);
      await mergeSubjects(client, b, a, 'me@example.com');
      expect((await listSubjects(client, { similarTo: String(a) })).map((s) => s.key)).toEqual(['eth-usd']);
    });
  });

  describe('propositions', () => {
    it('resolves the subject through merges and marks the subject it joins', async () => {
      const [s1] = await securities(1);
      const [btc, bitcoin] = [await subject('btc-usd'), await subject('bitcoin')];
      await mergeSubjects(client, bitcoin, btc, 'me@example.com');
      await markDerived(btc);

      expect(await upsertPropositions(client, [proposition(s1, bitcoin)]))
        .toEqual([{ security_id: s1, subject_id: btc, changed: true }]);
      expect(await isDirty(btc)).toBe(true);
      expect((await listPropositions(client, { subjectId: String(btc), denormalize: 'true' }))[0])
        .toMatchObject({ security_id: s1, extracted_subject_id: bitcoin, symbol: 's0', fields: { value: 1 } });
    });

    it('touches nothing when a proposition is rewritten unchanged', async () => {
      const [s1] = await securities(1);
      const btc = await subject('btc-usd');
      await upsertPropositions(client, [proposition(s1, btc)]);
      await markDerived(btc);
      expect(await upsertPropositions(client, [proposition(s1, btc)])).toEqual([{ security_id: s1, subject_id: btc, changed: false }]);
      expect(await isDirty(btc)).toBe(false);
    });

    it('marks both subjects when a proposition moves between them', async () => {
      const [s1] = await securities(1);
      const [btc, eth] = [await subject('btc-usd'), await subject('eth-usd')];
      await upsertPropositions(client, [proposition(s1, btc)]);
      await markDerived(btc);
      await markDerived(eth);
      await upsertPropositions(client, [proposition(s1, eth)]);
      expect(await isDirty(btc)).toBe(true);
      expect(await isDirty(eth)).toBe(true);
    });

    it('refuses an unknown subject', async () => {
      const [s1] = await securities(1);
      await expect(upsertPropositions(client, [proposition(s1, 999)])).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('sources', () => {
    it('stores a venue source and leaves an unchanged rewrite alone', async () => {
      const [s1] = await securities(1);
      const exchangeId = (await client.query(
        "INSERT INTO sm.exchange (exchange_name, exchange_code, region) VALUES ('Kalshi', 'KALSHI', 'us-east-1') RETURNING exchange_id",
      )).rows[0].exchange_id;
      const source = { market: { ticker: 'KXBTCD-26OCT2915-T79899.99', strike_type: 'greater', floor_strike: 79899.99 } };
      expect(await upsertSources(client, [{ securityId: s1, exchangeId, source, sourceHash: 'a' }])).toEqual([{ security_id: s1, changed: true }]);
      expect(await upsertSources(client, [{ securityId: s1, exchangeId, source, sourceHash: 'a' }])).toEqual([{ security_id: s1, changed: false }]);
      expect((await listSources(client, { securityIds: String(s1) }))[0]).toMatchObject({ exchange_id: exchangeId, source });
    });
  });

  describe('merges', () => {
    it('moves propositions on merge and back on unmerge, through chains', async () => {
      const [s1, s2, s3] = await securities(3);
      const [a, b, c] = [await subject('a'), await subject('b'), await subject('c')];
      await upsertPropositions(client, [proposition(s1, a), proposition(s2, b), proposition(s3, c)]);

      await mergeSubjects(client, c, b, 'me@example.com');
      await mergeSubjects(client, b, a, 'me@example.com');
      const subjectOf = async (sid: number) => (await listPropositions(client, { securityIds: String(sid) }))[0].subject_id;
      expect([await subjectOf(s2), await subjectOf(s3)]).toEqual([a, a]);
      expect((await listMerges(client, { subjectId: String(a) })).map((m) => m.alias_key)).toEqual(['b']);

      await markDerived(a);
      await unmergeSubject(client, b, 'me@example.com');
      expect([await subjectOf(s1), await subjectOf(s2), await subjectOf(s3)]).toEqual([a, b, b]);
      expect(await isDirty(a)).toBe(true);
      expect(await isDirty(b)).toBe(true);
    });

    it('refuses a cycle, a second merge of the same subject and an unmerge of a canonical subject', async () => {
      const [a, b, c] = [await subject('a'), await subject('b'), await subject('c')];
      await mergeSubjects(client, b, a, 'me@example.com');
      await expect(mergeSubjects(client, a, b, 'me@example.com')).rejects.toMatchObject({ statusCode: 409 });
      await expect(mergeSubjects(client, b, c, 'me@example.com')).rejects.toMatchObject({ statusCode: 409 });
      await expect(unmergeSubject(client, a, 'me@example.com')).rejects.toMatchObject({ statusCode: 404 });
      expect(await listMerges(client, {})).toHaveLength(1);
    });

    it('records who merged', async () => {
      const [a, b] = [await subject('a'), await subject('b')];
      expect(await mergeSubjects(client, b, a, 'me@example.com'))
        .toMatchObject({ alias_subject_id: b, canonical_subject_id: a, actor: 'me@example.com' });
    });
  });

  describe('relationship reconcile', () => {
    async function rows() {
      return (await client.query(
        'SELECT security_id_a, security_id_b, relationship_type, method, flags FROM sm.contract_relationship ORDER BY 1, 2',
      )).rows;
    }

    it('inserts, updates, deletes and leaves unchanged rows, then marks the subject derived', async () => {
      const [s1, s2, s3] = await securities(3);
      const btc = await subject('btc-usd');
      const base = { subjectId: btc, securityIds: [s1, s2, s3], method: 'derived', derivationVersion: 'd1' };

      expect(await reconcileRelationships(client, parseReconcile({ ...base, relationships: [
        { securityIdA: s1, securityIdB: s2, relationshipType: 'IMPLIES' },
        { securityIdA: s3, securityIdB: s2, relationshipType: 'EQUIVALENT' },
      ] }))).toEqual({ inserted: 2, updated: 0, deleted: 0, unchanged: 0, kept_manual: 0 });
      expect(await rows()).toEqual([
        { security_id_a: s1, security_id_b: s2, relationship_type: 'IMPLIES', method: 'derived', flags: [] },
        { security_id_a: s2, security_id_b: s3, relationship_type: 'EQUIVALENT', method: 'derived', flags: [] },
      ]);
      expect(await isDirty(btc)).toBe(false);

      expect(await reconcileRelationships(client, parseReconcile({ ...base, relationships: [
        { securityIdA: s1, securityIdB: s2, relationshipType: 'IMPLIES' },
        { securityIdA: s2, securityIdB: s3, relationshipType: 'EQUIVALENT', flags: ['RESOLUTION_SOURCE_DIFFERS'] },
      ] }))).toEqual({ inserted: 0, updated: 1, deleted: 0, unchanged: 1, kept_manual: 0 });

      expect(await reconcileRelationships(client, parseReconcile({ ...base, relationships: [] })))
        .toEqual({ inserted: 0, updated: 0, deleted: 2, unchanged: 0, kept_manual: 0 });
      expect(await rows()).toEqual([]);
    });

    it('never touches a manual row and skips a derived row on its pair', async () => {
      const [s1, s2, s3] = await securities(3);
      await client.query(
        "INSERT INTO sm.contract_relationship (security_id_a, security_id_b, relationship_type, method) VALUES ($1, $2, 'EQUIVALENT', 'manual')",
        [s2, s1],
      );
      const result = await reconcileRelationships(client, parseReconcile({
        securityIds: [s1, s2, s3], method: 'derived', derivationVersion: 'd1', relationships: [
          { securityIdA: s1, securityIdB: s2, relationshipType: 'IMPLIES' },
          { securityIdA: s1, securityIdB: s3, relationshipType: 'IMPLIES' },
        ],
      }));
      expect(result).toEqual({ inserted: 1, updated: 0, deleted: 0, unchanged: 0, kept_manual: 1 });
      expect((await rows()).map((r) => r.method)).toEqual(['derived', 'manual']);
    });

    it('deletes a stale row that pairs one of the securities with a security outside the set', async () => {
      const [s1, s2, outside] = await securities(3);
      await client.query(
        "INSERT INTO sm.contract_relationship (security_id_a, security_id_b, relationship_type, method) VALUES ($1, $2, 'IMPLIES', 'embedding')",
        [s1, outside],
      );
      expect((await reconcileRelationships(client, parseReconcile({
        securityIds: [s1, s2], method: 'derived', derivationVersion: 'd1', relationships: [],
      }))).deleted).toBe(1);
    });

    it('stays due a derivation when the subject changed after the classifier read it', async () => {
      const btc = await subject('btc-usd');
      await reconcileRelationships(client, parseReconcile({
        subjectId: btc, securityIds: [], relationships: [], method: 'derived', derivationVersion: 'd1',
        derivedAt: new Date(Date.now() - 60_000).toISOString(),
      }));
      expect(await isDirty(btc)).toBe(true);
    });
  });
});

describe('parseReconcile', () => {
  const base = { securityIds: [1, 2], method: 'derived', derivationVersion: 'd1' };

  it('stores an equivalence once, lower security first', () => {
    expect(parseReconcile({ ...base, relationships: [{ securityIdA: 2, securityIdB: 1, relationshipType: 'EQUIVALENT' }] })
      .relationships[0]).toMatchObject({ securityIdA: 1, securityIdB: 2, flags: [] });
  });

  it.each([
    ['an old type', [{ securityIdA: 1, securityIdB: 2, relationshipType: 'MUTUALLY_EXCLUSIVE' }]],
    ['a pair related twice', [{ securityIdA: 1, securityIdB: 2, relationshipType: 'IMPLIES' },
      { securityIdA: 2, securityIdB: 1, relationshipType: 'IMPLIES' }]],
    ['a security outside the set', [{ securityIdA: 1, securityIdB: 3, relationshipType: 'IMPLIES' }]],
    ['a self relationship', [{ securityIdA: 1, securityIdB: 1, relationshipType: 'IMPLIES' }]],
  ])('refuses %s', (_, relationships) => {
    expect(() => parseReconcile({ ...base, relationships })).toThrow(PropositionError);
  });

  it('refuses the manual method', () => {
    expect(() => parseReconcile({ ...base, method: 'manual', relationships: [] })).toThrow('method manual is for people');
  });
});
