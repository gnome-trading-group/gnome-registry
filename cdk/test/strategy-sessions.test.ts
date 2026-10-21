import { StrategySessionHandler, parseStatuses } from '../lambda/endpoints/strategy-sessions';

const handler = new StrategySessionHandler();

describe('strategy session queries', () => {
  it('filters by several statuses at once', () => {
    const query = handler.generateSelectQuery({ strategyId: '7', status: 'SUBMITTED,STARTING,RUNNING' });
    expect(query).toContain("AND status IN ('SUBMITTED', 'STARTING', 'RUNNING')");
    expect(query).toContain('AND strategy_id=7');
  });

  it('still filters by a single status', () => {
    expect(handler.generateSelectQuery({ status: 'RUNNING' })).toContain("AND status IN ('RUNNING')");
  });

  it('filters by mode, ignoring anything but paper or live', () => {
    expect(handler.generateSelectQuery({ mode: 'live' })).toContain("AND mode='live'");
    expect(handler.generateSelectQuery({ mode: "x' OR 1=1" })).not.toContain('mode=');
  });

  it('filters to sessions that traded a listing', () => {
    expect(handler.generateSelectQuery({ listingId: '42' }))
      .toContain('AND session_id IN (SELECT session_id FROM strategy.session_listing WHERE listing_id IN (42))');
  });

  it('filters to sessions that traded any listing of an event', () => {
    const query = handler.generateSelectQuery({ eventId: '9', status: 'RUNNING' });
    expect(query).toContain('WHERE ec.event_id IN (9)');
    expect(query).toContain("AND status IN ('RUNNING')");
  });

  it('matches nothing rather than everything for an invalid listing or event id', () => {
    expect(handler.generateSelectQuery({ listingId: "1' OR 1=1" })).toContain('AND FALSE');
    expect(handler.generateSelectQuery({ eventId: 'abc' })).toContain('AND FALSE');
  });

  it('guards an update on the expected statuses', () => {
    const query = handler.generateModifyQuery(
      { session_id: 's1' },
      JSON.stringify({ status: 'RUNNING', expectedStatus: ['SUBMITTED', 'STARTING'] }),
    );
    expect(query).toContain("SET status='RUNNING'");
    expect(query).toContain("WHERE session_id='s1' AND status IN ('SUBMITTED', 'STARTING')");
  });

  it('updates unconditionally without an expected status', () => {
    const query = handler.generateModifyQuery({ session_id: 's1' }, JSON.stringify({ instanceId: 'i-1' }));
    expect(query).toContain("instance_id='i-1'");
    expect(query).not.toContain('status IN');
  });

  it('escapes quotes in failure reasons, which come from AWS error messages', () => {
    const query = handler.generateModifyQuery({ session_id: 's1' }, JSON.stringify({ failureReason: "can't launch" }));
    expect(query).toContain("failure_reason='can''t launch'");
  });

  it('keeps the first stop reason and stopper, escaping quotes', () => {
    const query = handler.generateModifyQuery(
      { session_id: 's1' },
      JSON.stringify({ status: 'STOPPING', stopReason: "match's live", stoppedBy: 'strategy' }),
    );
    expect(query).toContain("stop_reason=COALESCE(stop_reason, 'match''s live')");
    expect(query).toContain("stopped_by=COALESCE(stopped_by, 'strategy')");
  });

  it('parses statuses from a list or a comma-separated string', () => {
    expect(parseStatuses(['A', 'B'])).toEqual(['A', 'B']);
    expect(parseStatuses(' A, B ,')).toEqual(['A', 'B']);
    expect(parseStatuses(undefined)).toEqual([]);
  });
});
