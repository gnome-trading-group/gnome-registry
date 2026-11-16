import { PoolClient } from 'pg';
import { hasTopLevelOrderBy, ResourceHandler } from '../lambda/endpoints/base';
import { EventHandler } from '../lambda/endpoints/events';
import { RiskPolicyHandler } from '../lambda/endpoints/risk-policies';
import { StrategySessionHandler, parseStatuses } from '../lambda/endpoints/strategy-sessions';

const handler = new StrategySessionHandler();

describe('strategy session queries', () => {
  it('filters by several statuses at once', () => {
    const query = handler.generateSelectQuery({ strategyId: '7', status: 'SUBMITTED,STARTING,RUNNING' });
    expect(query.text).toContain('strategy_id = $1 AND status = ANY($2::text[])');
    expect(query.values).toEqual(['7', ['SUBMITTED', 'STARTING', 'RUNNING']]);
  });

  it('still filters by a single status', () => {
    expect(handler.generateSelectQuery({ status: 'RUNNING' }).values).toEqual([['RUNNING']]);
  });

  it('filters by mode, ignoring anything but paper or live', () => {
    const query = handler.generateSelectQuery({ mode: 'live' });
    expect(query.text).toContain('mode = $1');
    expect(query.values).toEqual(['live']);
    expect(handler.generateSelectQuery({ mode: "x' OR 1=1" }).text).not.toContain('mode');
  });

  it('filters to sessions that traded a listing', () => {
    const query = handler.generateSelectQuery({ listingId: '42' });
    expect(query.text).toContain(
      'session_id IN (SELECT session_id FROM strategy.session_listing WHERE listing_id = ANY($1::int[]))');
    expect(query.values).toEqual([[42]]);
  });

  it('filters to sessions that traded any listing of an event', () => {
    const query = handler.generateSelectQuery({ eventId: '9', status: 'RUNNING' });
    expect(query.text).toContain('status = ANY($1::text[])');
    expect(query.text).toContain('WHERE ec.event_id = ANY($2::int[])');
    expect(query.values).toEqual([['RUNNING'], [9]]);
  });

  it('matches nothing rather than everything for an invalid listing or event id', () => {
    expect(handler.generateSelectQuery({ listingId: "1' OR 1=1" }).text).toContain('WHERE FALSE');
    expect(handler.generateSelectQuery({ eventId: 'abc' }).text).toContain('WHERE FALSE');
  });

  it('finds a session by its session_seq, and nothing for one that is not a number', () => {
    const query = handler.generateSelectQuery({ sessionSeq: '540' });
    expect(query.text).toContain('session_seq = $1::bigint');
    expect(query.values).toEqual(['540']);
    expect(handler.generateSelectQuery({ sessionSeq: "540' OR 1=1" }).text).toContain('WHERE FALSE');
  });

  it('guards an update on the expected statuses', () => {
    const query = handler.generateModifyQuery(
      { session_id: 's1' },
      JSON.stringify({ status: 'RUNNING', expectedStatus: ['SUBMITTED', 'STARTING'] }),
    );
    expect(query.text).toContain('SET status = $1');
    expect(query.text).toContain('WHERE session_id = $2 AND status = ANY($3::text[])');
    expect(query.values).toEqual(['RUNNING', 's1', ['SUBMITTED', 'STARTING']]);
  });

  it('updates unconditionally without an expected status', () => {
    const query = handler.generateModifyQuery({ session_id: 's1' }, JSON.stringify({ instanceId: 'i-1' }));
    expect(query.text).toContain('instance_id = $1');
    expect(query.text).not.toContain('status');
  });

  it('keeps the first stop reason and stopper', () => {
    const query = handler.generateModifyQuery(
      { session_id: 's1' },
      JSON.stringify({ status: 'STOPPING', stopReason: "match's live", stoppedBy: 'strategy' }),
    );
    expect(query.text).toContain('stop_reason = COALESCE(stop_reason, $2)');
    expect(query.text).toContain('stopped_by = COALESCE(stopped_by, $3)');
    expect(query.values).toEqual(['STOPPING', "match's live", 'strategy', 's1']);
  });

  it('parses statuses from a list or a comma-separated string', () => {
    expect(parseStatuses(['A', 'B'])).toEqual(['A', 'B']);
    expect(parseStatuses(' A, B ,')).toEqual(['A', 'B']);
    expect(parseStatuses(undefined)).toEqual([]);
  });
});

// The query a handler's GET would run, read from a client that only records it.
async function listQuery(resource: ResourceHandler, params: Record<string, string>): Promise<string> {
  const queries: string[] = [];
  resource.client = { query: async (q: { text: string }) => { queries.push(q.text); return { rows: [] }; } } as unknown as PoolClient;
  await resource.get(params);
  return queries[0];
}

describe('strategy session list ordering', () => {
  it('orders by creation time, then session id, despite the ORDER BYs in its subqueries', async () => {
    const text = await listQuery(new StrategySessionHandler(), { sortBy: 'date_created', sortOrder: 'desc', limit: '50' });
    expect(text).toMatch(/ORDER BY date_created DESC, session_id DESC LIMIT/);
  });

  it('sorts by strategy and session id', async () => {
    expect(await listQuery(new StrategySessionHandler(), { sortBy: 'strategy_id', sortOrder: 'asc' }))
      .toMatch(/ORDER BY strategy_id ASC, session_id ASC LIMIT/);
    expect(await listQuery(new StrategySessionHandler(), { sortBy: 'session_id', sortOrder: 'desc' }))
      .toMatch(/ORDER BY session_id DESC LIMIT/);
  });

  it('ignores a column it does not sort by', async () => {
    expect(await listQuery(new StrategySessionHandler(), { sortBy: 'config' })).toMatch(/ORDER BY 1 LIMIT/);
  });

  it('leaves the order of a handler that orders its own rows', async () => {
    const events = await listQuery(new EventHandler(), { sortBy: 'volume_24h', sortOrder: 'desc' });
    expect(events.match(/ORDER BY/g)).toHaveLength(1);
    const policies = await listQuery(new RiskPolicyHandler(), { sortBy: 'policy_id' });
    expect(policies.match(/ORDER BY/g)).toHaveLength(1);
  });
});

describe('hasTopLevelOrderBy', () => {
  it('sees only an ORDER BY outside parentheses and string literals', () => {
    expect(hasTopLevelOrderBy('SELECT * FROM t ORDER BY a')).toBe(true);
    expect(hasTopLevelOrderBy('SELECT * FROM t\n      ORDER BY a')).toBe(true);
    expect(hasTopLevelOrderBy('SELECT array_agg(x ORDER BY x) FROM t')).toBe(false);
    expect(hasTopLevelOrderBy('WITH v AS (SELECT * FROM t ORDER BY a) SELECT * FROM v')).toBe(false);
    expect(hasTopLevelOrderBy("SELECT ')' AS p, 'x ORDER BY y' FROM t")).toBe(false);
    expect(hasTopLevelOrderBy('SELECT recorder_by FROM t')).toBe(false);
  });
});
