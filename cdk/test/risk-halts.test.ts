import { APIGatewayProxyEvent } from 'aws-lambda';

const mockQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('../lambda/connections', () => ({
  connectDatabase: async () => ({
    connect: async () => ({ query: mockQuery, release: mockRelease }),
  }),
}));

import { handler, generateHaltUpsertQuery } from '../lambda/endpoints/risk-halts';

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent;
}

function upsertReturns(policyId: number) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO risk.policy')) return { rowCount: 1, rows: [{ policy_id: policyId }] };
    return { rowCount: null, rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('POST /risk/halts validation', () => {
  it.each([
    ['missing body', null],
    ['invalid json', '{not json'],
    ['negative strategyId', { strategyId: -4, reason: 'x' }],
    ['fractional strategyId', { strategyId: 1.5, reason: 'x' }],
    ['string strategyId', { strategyId: '7', reason: 'x' }],
    ['strategyId above int range', { strategyId: 2147483648, reason: 'x' }],
    ['missing reason', { strategyId: 7 }],
    ['non-string reason', { strategyId: 7, reason: 12 }],
  ])('rejects %s with 400 and touches no database', async (_name, body) => {
    const event = body === null
      ? ({ httpMethod: 'POST', body: null } as unknown as APIGatewayProxyEvent)
      : postEvent(body);
    const response = await handler(event);
    expect(response.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods', async () => {
    const response = await handler({ httpMethod: 'DELETE', body: '{}' } as unknown as APIGatewayProxyEvent);
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /risk/halts upsert', () => {
  it('upserts inside an audited transaction attributed to the oms', async () => {
    upsertReturns(42);
    const response = await handler(postEvent({ strategyId: 7, reason: 'max loss breached' }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ policyId: 42, enabled: true });

    const calls = mockQuery.mock.calls;
    expect(calls[0][0]).toBe('BEGIN');
    expect(calls[1][0]).toContain("set_config('gnome.actor', $1, true)");
    expect(calls[1][0]).toContain("set_config('gnome.reason', $2, true)");
    expect(calls[1][1]).toEqual(['oms', 'max loss breached']);
    expect(calls[2][0]).toBe(generateHaltUpsertQuery({ strategyId: 7 }));
    expect(calls[3][0]).toBe('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('rejects strategyId 0, which is never a real strategy', async () => {
    const response = await handler(postEvent({ strategyId: 0, reason: 'x' }));
    expect(response.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('halts a single session by sessionId', async () => {
    upsertReturns(9);
    const response = await handler(postEvent({ sessionId: 'abc-123', reason: 'session stop' }));
    expect(response.statusCode).toBe(200);
    expect(mockQuery.mock.calls[2][0]).toBe(generateHaltUpsertQuery({ sessionId: 'abc-123' }));
  });

  it('returns 400 for a session that does not exist', async () => {
    mockQuery.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    const response = await handler(postEvent({ sessionId: 'nope', reason: 'session stop' }));
    expect(response.statusCode).toBe(400);
  });

  it('requires exactly one of strategyId and sessionId', async () => {
    expect((await handler(postEvent({ reason: 'x' }))).statusCode).toBe(400);
    expect((await handler(postEvent({ strategyId: 7, sessionId: 'abc', reason: 'x' }))).statusCode).toBe(400);
    expect((await handler(postEvent({ sessionId: "abc'; --", reason: 'x' }))).statusCode).toBe(400);
  });

  it('attributes the halt to a supplied actor', async () => {
    upsertReturns(42);
    await handler(postEvent({ strategyId: 7, reason: 'session stop', actor: 'alice@example.com' }));
    expect(mockQuery.mock.calls[1][1]).toEqual(['alice@example.com', 'session stop']);
  });

  it('rolls back and returns 500 when the upsert fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO risk.policy')) throw new Error('boom');
      return { rowCount: null, rows: [] };
    });
    const response = await handler(postEvent({ strategyId: 7, reason: 'x' }));
    expect(response.statusCode).toBe(500);
    expect(mockQuery.mock.calls.map(c => c[0])).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('generates an enable-only upsert keyed on the unique index expressions', () => {
    const sql = generateHaltUpsertQuery({ strategyId: 7 }).replace(/\s+/g, ' ');
    expect(sql).toContain("SELECT 'KILL_SWITCH', NULL, 7, NULL::integer, '{}'::jsonb, true");
    expect(sql).toContain(
      "ON CONFLICT (policy_type, COALESCE(session_id, ''), COALESCE(strategy_id, 0), COALESCE(listing_id, 0))",
    );
    expect(sql).toContain('session_id IS NULL AND strategy_id=7 AND listing_id IS NULL');
    expect(sql).toContain('DO UPDATE SET enabled=true, date_modified=NOW() WHERE risk.policy.enabled = false');
    expect(sql).not.toMatch(/enabled\s*=\s*false\s*(,|$)/);
    expect(sql).not.toMatch(/SET[^W]*enabled=false/);
  });
});
