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
    await handler(event('POST', { policyType: 'KILL_SWITCH', scope: 1, strategyId: 7, parameters: {} }));
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
