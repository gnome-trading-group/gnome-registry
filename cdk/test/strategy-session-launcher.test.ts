import { APIGatewayProxyEvent } from 'aws-lambda';

const events: string[] = [];
const ec2Calls: { kind: string; input: any; region?: string }[] = [];
const ssmParams: Record<string, string> = {};
let runInstancesError: Error | null = null;

jest.mock('@aws-sdk/client-ec2', () => {
  const command = (kind: string) => jest.fn().mockImplementation((input) => ({ kind, input }));
  return {
    EC2Client: jest.fn().mockImplementation((config) => ({
      send: async (cmd: any) => {
        ec2Calls.push({ ...cmd, region: config?.region });
        if (cmd.kind === 'DescribeSubnets') {
          return {
            Subnets: [
              { SubnetId: 'subnet-a', AvailabilityZone: 'us-east-1a' },
              { SubnetId: 'subnet-b', AvailabilityZone: 'us-east-1b' },
            ],
          };
        }
        if (cmd.kind === 'DescribeSecurityGroups') return { SecurityGroups: [{ GroupId: 'sg-1' }] };
        events.push(cmd.kind);
        if (cmd.kind === 'RunInstances') {
          if (runInstancesError) throw runInstancesError;
          return { Instances: [{ InstanceId: 'i-123', Placement: { AvailabilityZone: 'us-east-1b' } }] };
        }
        return {};
      },
    })),
    DescribeSubnetsCommand: command('DescribeSubnets'),
    DescribeSecurityGroupsCommand: command('DescribeSecurityGroups'),
    RunInstancesCommand: command('RunInstances'),
    TerminateInstancesCommand: command('TerminateInstances'),
  };
});
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: async (cmd: any) => {
      events.push(`SSM ${cmd.input.Name}`);
      return { Parameter: { Value: ssmParams[cmd.input.Name] } };
    },
  })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
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
process.env.STAGE = 'dev';

const launcher = require('../lambda/endpoints/strategy-session-launcher');

let haltFails = false;
let haltBodies: any[] = [];
let patchBodies: any[] = [];
let postBodies: any[] = [];
let sessionRow: any;
let patchStatus = 200;
let sleeps: number[] = [];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function apiEvent(resource: string, body: unknown, email?: string): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    resource,
    path: resource,
    body: JSON.stringify(body),
    requestContext: email ? { authorizer: { claims: { email } } } : {},
  } as unknown as APIGatewayProxyEvent;
}

function launchBody(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-0001',
    strategyId: 7,
    mode: 'paper',
    region: 'us-east-1',
    instanceType: 'c7i.4xlarge',
    config: { listings: [1], 'strategy.type': 'java', 'strategy.class': 'com.example.S', ...config },
    ...overrides,
  };
}

function runInstancesInput() {
  return ec2Calls.find(c => c.kind === 'RunInstances')!.input;
}

function sessionEnv(): Record<string, string> {
  const script = Buffer.from(runInstancesInput().UserData, 'base64').toString();
  const payload = /echo '([^']+)' \| base64 -d/.exec(script)![1];
  return JSON.parse(Buffer.from(payload, 'base64').toString());
}

beforeEach(() => {
  events.length = 0;
  ec2Calls.length = 0;
  haltFails = false;
  haltBodies = [];
  patchBodies = [];
  postBodies = [];
  sleeps = [];
  patchStatus = 200;
  runInstancesError = null;
  sessionRow = { session_id: 's1', strategy_id: 7, instance_id: 'i-123', launch_region: 'eu-west-1' };
  Object.assign(ssmParams, {
    '/gnome/orchestrator/latest-version': '1.12.2',
    '/gnome/orchestrator/ami/16core': 'ami-16',
    '/gnome/orchestrator/ami/32core': 'ami-32',
    '/gnome/orchestrator/ami/standard': 'ami-std',
  });
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    if (url.startsWith('https://pypi.org/')) {
      events.push('PyPI');
      return jsonResponse({ info: { version: '2.20.2' } });
    }
    const method = init.method ?? 'GET';
    const path = url.replace('https://registry.test/api', '').split('?')[0];
    events.push(`${method} ${path}`);
    if (path === '/risk/halts') {
      haltBodies.push(JSON.parse(init.body));
      return haltFails ? jsonResponse({ message: 'db down' }, 500) : jsonResponse({ policyId: 9 });
    }
    if (method === 'GET') return jsonResponse([sessionRow]);
    if (method === 'POST') {
      postBodies.push(JSON.parse(init.body));
      return jsonResponse({ session_id: 'session-0001', status: 'SUBMITTED' });
    }
    patchBodies.push(JSON.parse(init.body));
    return jsonResponse({ session_id: 's1', status: 'STOPPED' }, patchStatus);
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

describe('POST /strategy-sessions/launch', () => {
  it('records the session before launching, then attaches the instance', async () => {
    const response = await launcher.handler(apiEvent('/strategy-sessions/launch', launchBody()));

    expect(response.statusCode).toBe(200);
    expect(events).toEqual([
      'SSM /gnome/orchestrator/latest-version',
      'PyPI',
      'SSM /gnome/orchestrator/ami/16core',
      'POST /strategy-sessions',
      'RunInstances',
      'PATCH /strategy-sessions',
    ]);
    expect(postBodies[0]).toMatchObject({
      status: 'SUBMITTED',
      instanceType: 'c7i.4xlarge',
      launchRegion: 'us-east-1',
      orchestratorVersion: '1.12.2',
      gnomepyVersion: '2.20.2',
    });
    expect(patchBodies[0]).toEqual({ instanceId: 'i-123', availabilityZone: 'us-east-1b' });
  });

  it('launches from the launch template with the right AMI, subnet and tags', async () => {
    await launcher.handler(apiEvent('/strategy-sessions/launch', launchBody()));

    const input = runInstancesInput();
    expect(input.LaunchTemplate.LaunchTemplateName).toBe('gnome-orchestrator');
    expect(input.ImageId).toBe('ami-16');
    expect(input.InstanceType).toBe('c7i.4xlarge');
    expect(input.SubnetId).toBe('subnet-a');
    expect(input.Placement).toBeUndefined();
    expect(input.TagSpecifications.map((t: any) => t.ResourceType)).toEqual(['instance', 'volume']);
    expect(input.TagSpecifications[0].Tags).toContainEqual({ Key: 'gnome:purpose', Value: 'orchestrator-ec2' });
  });

  it('passes the session config to the instance as JSON', async () => {
    await launcher.handler(apiEvent('/strategy-sessions/launch', launchBody({}, { 'strategy.args.edge': 0.5 })));

    expect(sessionEnv()).toMatchObject({
      LISTINGS: '[1]',
      STRATEGY_TYPE: 'java',
      STRATEGY_CLASS: 'com.example.S',
      STRATEGY_ARGS_JSON: '{"edge":0.5}',
      STRATEGY_ID: '7',
      MODE: 'paper',
      SESSION_ID: 'session-0001',
      STAGE: 'dev',
      REGISTRY_API_KEY_ID: 'key-id',
      ORCHESTRATOR_VERSION: '1.12.2',
      GNOMEPY_VERSION: '2.20.2',
    });
    const script = Buffer.from(runInstancesInput().UserData, 'base64').toString();
    expect(script).toContain("trap 'shutdown -h now' ERR");
    expect(script).not.toContain('EXIT');
  });

  it('uses a typed orchestrator version verbatim without reading the latest', async () => {
    await launcher.handler(apiEvent('/strategy-sessions/launch', launchBody({ orchestratorVersion: '1.10.8' })));

    expect(events).not.toContain('SSM /gnome/orchestrator/latest-version');
    expect(sessionEnv().ORCHESTRATOR_VERSION).toBe('1.10.8');
    expect(postBodies[0].orchestratorVersion).toBe('1.10.8');
  });

  it('pins the latest gnomepy from PyPI for python strategies', async () => {
    await launcher.handler(apiEvent('/strategy-sessions/launch',
      launchBody({ researchCommit: 'abc123' }, { 'strategy.type': 'python' })));

    expect(events).toContain('PyPI');
    expect(sessionEnv()).toMatchObject({ GNOMEPY_VERSION: '2.20.2', RESEARCH_COMMIT: 'abc123' });
    expect(postBodies[0].gnomepyVersion).toBe('2.20.2');
  });

  it('uses a typed gnomepy version without asking PyPI', async () => {
    await launcher.handler(apiEvent('/strategy-sessions/launch',
      launchBody({ gnomepyVersion: '2.18.1' }, { 'strategy.type': 'python' })));

    expect(events).not.toContain('PyPI');
    expect(sessionEnv().GNOMEPY_VERSION).toBe('2.18.1');
  });

  it('runs the standard profile on the standard AMI and defaults to c7i.xlarge', async () => {
    const body = launchBody({}, { 'latency.profile': 'standard' });
    delete (body as any).instanceType;

    await launcher.handler(apiEvent('/strategy-sessions/launch', body));

    expect(runInstancesInput().ImageId).toBe('ami-std');
    expect(runInstancesInput().InstanceType).toBe('c7i.xlarge');
    expect(sessionEnv().LATENCY_PROFILE).toBe('standard');
  });

  it('runs c7i.large on the standard AMI', async () => {
    await launcher.handler(apiEvent('/strategy-sessions/launch',
      launchBody({ instanceType: 'c7i.large' }, { 'latency.profile': 'standard' })));

    expect(runInstancesInput().ImageId).toBe('ami-std');
    expect(runInstancesInput().InstanceType).toBe('c7i.large');
  });

  it('places the instance in the requested availability zone', async () => {
    await launcher.handler(apiEvent('/strategy-sessions/launch', launchBody({ availabilityZone: 'us-east-1b' })));
    expect(runInstancesInput().SubnetId).toBe('subnet-b');
  });

  it.each([
    [{ instanceType: 'm5.large' }, {}, 'Unsupported instanceType'],
    [{ instanceType: 'c7i.xlarge' }, {}, 'too small to isolate'],
    [{ instanceType: 'c7i.large' }, {}, 'too small to isolate'],
    [{}, { 'latency.profile': 'turbo' }, 'Unknown latency.profile'],
    [{ availabilityZone: 'us-east-1z' }, {}, 'No orchestrator subnet'],
  ])('rejects %p %p before creating anything', async (overrides, config, message) => {
    const response = await launcher.handler(apiEvent('/strategy-sessions/launch', launchBody(overrides, config)));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).message).toContain(message);
    expect(postBodies).toHaveLength(0);
    expect(events).not.toContain('RunInstances');
  });

  it('marks the session FAILED and explains a quota rejection', async () => {
    runInstancesError = Object.assign(new Error('You have requested more vCPU capacity'), { name: 'VcpuLimitExceeded' });

    const response = await launcher.handler(apiEvent('/strategy-sessions/launch', launchBody()));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).message).toContain('vCPU quota');
    expect(patchBodies[0]).toMatchObject({ status: 'FAILED', expectedStatus: ['SUBMITTED'] });
    expect(patchBodies[0].failureReason).toContain('more vCPU capacity');
  });
});

describe('POST /strategy-sessions/stop', () => {
  it('kills the session, waits, marks it STOPPED, then terminates the instance', async () => {
    const response = await launcher.handler(apiEvent('/strategy-sessions/stop', { sessionId: 's1' }, 'alice@example.com'));

    expect(response.statusCode).toBe(200);
    expect(events).toEqual([
      'GET /strategy-sessions',
      'POST /risk/halts',
      'sleep',
      'PATCH /strategy-sessions',
      'TerminateInstances',
    ]);
    expect(haltBodies).toEqual([{ sessionId: 's1', reason: 'session stop', actor: 'alice@example.com' }]);
    expect(patchBodies[0]).toMatchObject({ status: 'STOPPED', expectedStatus: ['SUBMITTED', 'STARTING', 'RUNNING'] });
    const terminate = ec2Calls.find(c => c.kind === 'TerminateInstances')!;
    expect(terminate.input).toEqual({ InstanceIds: ['i-123'] });
    expect(terminate.region).toBe('eu-west-1');
    expect(sleeps).toEqual([5000]);
  });

  it('serves the /cognito-prefixed route that API Gateway actually exposes for stop', async () => {
    const response = await launcher.handler(apiEvent('/cognito/strategy-sessions/stop', { sessionId: 's1' }, 'alice@example.com'));

    expect(response.statusCode).toBe(200);
    expect(haltBodies).toEqual([{ sessionId: 's1', reason: 'session stop', actor: 'alice@example.com' }]);
  });

  it('attributes the kill to unknown without Cognito claims', async () => {
    await launcher.handler(apiEvent('/strategy-sessions/stop', { sessionId: 's1' }));
    expect(haltBodies[0].actor).toBe('unknown');
  });

  it.each([
    [0, 0],
    [1500, 1500],
    [-10, 0],
    [60000, 20000],
    ['soon', 5000],
  ])('clamps stopGraceMs %p to %p', async (requested, expected) => {
    await launcher.handler(apiEvent('/strategy-sessions/stop', { sessionId: 's1', stopGraceMs: requested }));
    expect(sleeps).toEqual([expected]);
  });

  it('still terminates when the kill upsert fails', async () => {
    haltFails = true;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await launcher.handler(apiEvent('/strategy-sessions/stop', { sessionId: 's1' }));

    expect(response.statusCode).toBe(200);
    expect(events).toEqual(['GET /strategy-sessions', 'POST /risk/halts', 'PATCH /strategy-sessions', 'TerminateInstances']);
  });

  it('still terminates a session that had already ended', async () => {
    patchStatus = 409;

    const response = await launcher.handler(apiEvent('/strategy-sessions/stop', { sessionId: 's1' }));

    expect(response.statusCode).toBe(409);
    expect(events).toContain('TerminateInstances');
  });

  it('skips the wait and termination when the instance never launched', async () => {
    sessionRow = { session_id: 's1', strategy_id: 7, instance_id: null, launch_region: 'us-east-1' };

    await launcher.handler(apiEvent('/strategy-sessions/stop', { sessionId: 's1' }));

    expect(sleeps).toEqual([]);
    expect(events).not.toContain('TerminateInstances');
    expect(events).toContain('PATCH /strategy-sessions');
  });

  it('returns 404 for an unknown session without killing anything', async () => {
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      events.push(`${init?.method ?? 'GET'} ${url}`);
      return jsonResponse([]);
    });
    const response = await launcher.handler(apiEvent('/strategy-sessions/stop', { sessionId: 'missing' }));
    expect(response.statusCode).toBe(404);
    expect(events).toHaveLength(1);
    expect(ec2Calls).toHaveLength(0);
  });
});
