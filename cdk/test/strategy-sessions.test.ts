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

  it('parses statuses from a list or a comma-separated string', () => {
    expect(parseStatuses(['A', 'B'])).toEqual(['A', 'B']);
    expect(parseStatuses(' A, B ,')).toEqual(['A', 'B']);
    expect(parseStatuses(undefined)).toEqual([]);
  });
});
