import { APIGatewayProxyEvent } from 'aws-lambda';

const mockQuery = jest.fn();

jest.mock('../lambda/connections', () => ({
  connectDatabase: async () => ({
    connect: async () => ({ query: mockQuery, release: jest.fn() }),
  }),
}));

import { handler } from '../lambda/endpoints/risk-policies';

function event(httpMethod: string, body: unknown, email?: string, query?: Record<string, string>): APIGatewayProxyEvent {
  return {
    httpMethod,
    body: JSON.stringify(body),
    queryStringParameters: query ?? null,
    requestContext: email ? { authorizer: { claims: { email } } } : {},
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async () => ({ rowCount: 1, rows: [{ policy_id: 3 }] }));
});

function statements(): string[] {
  return mockQuery.mock.calls.map(c => String(c[0]).trim().split(/\s+/)[0]);
}

describe('risk policy writes are audited', () => {
  it('PATCH sets the Cognito actor and reason inside the transaction before updating', async () => {
    const response = await handler(event('PATCH', { enabled: true, reason: 'manual kill' }, 'alice@example.com', { policyId: '3' }));
    expect(response.statusCode).toBe(200);
    expect(statements()).toEqual(['BEGIN', 'SELECT', 'SELECT', 'UPDATE', 'COMMIT']);
    expect(mockQuery.mock.calls[1][1]).toEqual(['alice@example.com', 'manual kill']);
  });

  it('POST without a reason or Cognito claims records unknown with an empty reason', async () => {
    await handler(event('POST', { policyType: 'KILL_SWITCH', strategyId: 7, parameters: {} }));
    expect(statements()).toEqual(['BEGIN', 'SELECT', 'INSERT', 'COMMIT']);
    expect(mockQuery.mock.calls[1][1]).toEqual(['unknown', '']);
  });

  it('DELETE rolls back when the delete fails', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM')) throw new Error('boom');
      return { rowCount: null, rows: [] };
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await handler(event('DELETE', { policyId: 3, reason: 'cleanup' }, 'bob@example.com'));
    expect(response.statusCode).toBe(500);
    expect(statements()).toEqual(['BEGIN', 'SELECT', 'DELETE', 'ROLLBACK']);
  });

  it('GET does not open a transaction', async () => {
    mockQuery.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await handler(event('GET', null));
    expect(statements()).toEqual(['SELECT']);
  });
});

describe('risk policy GET filters', () => {
  function selectSql(): string {
    return String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
  }

  beforeEach(() => {
    mockQuery.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
  });

  it.each(['true', 'false'])('filters on enabled=%s and orders by policy_id', async (enabled) => {
    await handler(event('GET', null, undefined, { enabled }));
    expect(selectSql()).toContain(`AND enabled=${enabled} ORDER BY policy_id LIMIT`);
  });

  it('ignores enabled values other than true/false', async () => {
    await handler(event('GET', null, undefined, { enabled: 'yes' }));
    expect(selectSql()).not.toContain('enabled=');
    expect(selectSql()).toContain('ORDER BY policy_id');
  });

  it('orders unfiltered results by policy_id', async () => {
    await handler(event('GET', null));
    expect(selectSql()).toContain('WHERE 1=1 ORDER BY policy_id LIMIT');
  });
});

describe('risk policy targets and validation', () => {
  function insertSql(): string {
    return String(mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO'))?.[0]).replace(/\s+/g, ' ');
  }

  it('stores exactly the ids it is given, as nulls when absent', async () => {
    await handler(event('POST', { policyType: 'MAX_POSITION', listingId: 500, parameters: { maxPosition: 10 } }));
    expect(insertSql()).toContain("VALUES ('MAX_POSITION', null, null, 500, '{\"maxPosition\":10}', true)");
  });

  it('fills a session row\'s strategy from its session', async () => {
    await handler(event('POST', { policyType: 'KILL_SWITCH', sessionId: 'abc', parameters: {} }));
    expect(insertSql()).toContain("'abc', (SELECT strategy_id FROM strategy.session WHERE session_id='abc')");
  });

  it.each([
    [{ policyType: 'NOT_A_POLICY', parameters: {} }],
    [{ policyType: 'MAX_POSITION', parameters: {} }],
    [{ policyType: 'MAX_POSITION', parameters: { maxPositon: 10 } }],
    [{ policyType: 'MAX_POSITION', parameters: { maxPosition: 0 } }],
    [{ policyType: 'MAX_OPEN_ORDERS', parameters: { maxOpenOrders: 2.5 } }],
    [{ policyType: 'KILL_SWITCH', parameters: { maxLoss: 1 } }],
    [{ policyType: 'KILL_SWITCH', strategyId: 0, parameters: {} }],
    [{ policyType: 'KILL_SWITCH', sessionId: "x'y", parameters: {} }],
  ])('rejects %j with a 400 before writing', async (body) => {
    const response = await handler(event('POST', body));
    expect(response.statusCode).toBe(400);
    expect(statements()).not.toContain('INSERT');
  });

  it('maps a constraint violation (e.g. a session running another strategy) to a 400', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO')) throw Object.assign(new Error('violates foreign key'), { code: '23503' });
      return { rowCount: 1, rows: [] };
    });
    const response = await handler(event('POST', { policyType: 'KILL_SWITCH', sessionId: 'abc', strategyId: 9, parameters: {} }));
    expect(response.statusCode).toBe(400);
  });

  it('validates new parameters against the stored policy type', async () => {
    mockQuery.mockImplementation(async () => ({ rowCount: 1, rows: [{ policy_id: 3, policy_type: 'MAX_POSITION' }] }));
    const bad = await handler(event('PATCH', { parameters: { maxLoss: 5 } }, undefined, { policyId: '3' }));
    expect(bad.statusCode).toBe(400);
    const good = await handler(event('PATCH', { parameters: { maxPosition: 5 } }, undefined, { policyId: '3' }));
    expect(good.statusCode).toBe(200);
  });

  it('filters to what one running OMS needs', async () => {
    mockQuery.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await handler(event('GET', null, undefined, { enabled: 'true', forStrategy: '7', forSession: 'abc' }));
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('(strategy_id IS NULL OR strategy_id=7)');
    expect(sql).toContain("(session_id IS NULL OR session_id='abc')");
    mockQuery.mockClear();
    await handler(event('GET', null, undefined, { forSession: 'none' }));
    expect(String(mockQuery.mock.calls[0][0])).toContain('session_id IS NULL');
  });

  it('lists every row, session rows included, by default', async () => {
    mockQuery.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await handler(event('GET', null));
    expect(String(mockQuery.mock.calls[0][0])).not.toContain('session_id');
  });
});
