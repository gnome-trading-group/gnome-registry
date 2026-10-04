import { APIGatewayProxyEvent } from 'aws-lambda';

const events: string[] = [];
const mockEcsSend = jest.fn();

jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn().mockImplementation(() => ({ send: mockEcsSend })),
  RunTaskCommand: jest.fn(),
  StopTaskCommand: jest.fn().mockImplementation((input) => ({ kind: 'StopTask', input })),
}));
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(),
  DescribeSubnetsCommand: jest.fn(),
  DescribeSecurityGroupsCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-api-gateway', () => ({
  APIGatewayClient: jest.fn().mockImplementation(() => ({ send: async () => ({ value: 'test-key' }) })),
  GetApiKeyCommand: jest.fn(),
}));
// Not installed locally (only provided by the Lambda runtime), so it must be virtual.
jest.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: jest.fn(),
  GetLogEventsCommand: jest.fn(),
}), { virtual: true });

process.env.REGISTRY_API_URL = 'https://registry.test/api/';
process.env.REGISTRY_API_KEY_ID = 'key-id';

const launcher = require('../lambda/endpoints/strategy-session-launcher');

const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/gnome-orchestrator/abc123';
let haltFails = false;
let haltBodies: any[] = [];
let sleeps: number[] = [];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stopEvent(body: unknown, email?: string): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    resource: '/strategy-sessions/stop',
    path: '/strategy-sessions/stop',
    body: JSON.stringify(body),
    requestContext: email ? { authorizer: { claims: { email } } } : {},
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  events.length = 0;
  haltFails = false;
  haltBodies = [];
  sleeps = [];
  mockEcsSend.mockReset();
  mockEcsSend.mockImplementation(async (command: any) => {
    events.push(command.kind);
    return {};
  });
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    const path = url.replace('https://registry.test/api', '').split('?')[0];
    events.push(`${init.method} ${path}`);
    if (path === '/risk/halts') {
      haltBodies.push(JSON.parse(init.body));
      if (haltFails) return jsonResponse({ message: 'db down' }, false, 500);
      return jsonResponse({ policyId: 9, enabled: true });
    }
    if (init.method === 'GET') return jsonResponse([{ session_id: 's1', strategy_id: 7, task_arn: TASK_ARN }]);
    return jsonResponse({ session_id: 's1', status: 'STOPPED' });
  });
  jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
    sleeps.push(ms);
    events.push('sleep');
    fn();
    return 0;
  }) as any);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /strategy-sessions/stop', () => {
  it('kills the strategy, waits the grace period, then stops the task and marks the session stopped', async () => {
    const response = await launcher.handler(stopEvent({ sessionId: 's1' }, 'alice@example.com'));

    expect(response.statusCode).toBe(200);
    expect(events).toEqual([
      'GET /strategy-sessions',
      'POST /risk/halts',
      'sleep',
      'StopTask',
      'PATCH /strategy-sessions',
    ]);
    expect(haltBodies).toEqual([{ strategyId: 7, reason: 'session stop', actor: 'alice@example.com' }]);
    expect(sleeps).toEqual([5000]);
  });

  it('attributes the kill to unknown without Cognito claims', async () => {
    await launcher.handler(stopEvent({ sessionId: 's1' }));
    expect(haltBodies[0].actor).toBe('unknown');
  });

  it.each([
    [0, 0],
    [1500, 1500],
    [-10, 0],
    [60000, 20000],
    ['soon', 5000],
  ])('clamps stopGraceMs %p to %p', async (requested, expected) => {
    await launcher.handler(stopEvent({ sessionId: 's1', stopGraceMs: requested }));
    expect(sleeps).toEqual([expected]);
  });

  it('still stops the task when the kill upsert fails', async () => {
    haltFails = true;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await launcher.handler(stopEvent({ sessionId: 's1' }));

    expect(response.statusCode).toBe(200);
    expect(events).toEqual([
      'GET /strategy-sessions',
      'POST /risk/halts',
      'StopTask',
      'PATCH /strategy-sessions',
    ]);
  });

  it('returns 404 for an unknown session without killing anything', async () => {
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      events.push(`${init.method} ${url}`);
      return jsonResponse([]);
    });
    const response = await launcher.handler(stopEvent({ sessionId: 'missing' }));
    expect(response.statusCode).toBe(404);
    expect(events).toHaveLength(1);
    expect(mockEcsSend).not.toHaveBeenCalled();
  });
});
