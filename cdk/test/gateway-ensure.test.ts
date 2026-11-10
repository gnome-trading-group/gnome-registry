import {
  ADDRESS_TAG, BASE_FAMILY, CAPACITY_PROVIDER, CLUSTER, ensureGateway, EnsureDeps, GatewayRow, serviceName,
} from '../lambda/endpoints/gateway-ensure';

// What ECS and EC2 hold in one region, and every command each was sent, by name.
class FakeRegion {
  services: { serviceName: string; status: string; desiredCount: number; taskDefinition?: string }[] = [];
  addresses: { AllocationId: string; Tags: { Key: string; Value: string }[] }[] = [];
  sent: { command: string; input: any }[] = [];
  revisions = 0;
  createFails = false;

  ecs = {
    send: async (command: any) => {
      const name = command.constructor.name;
      this.sent.push({ command: name, input: command.input });
      if (name === 'DescribeServicesCommand') {
        return { services: this.services.filter((s) => command.input.services.includes(s.serviceName)) };
      }
      if (name === 'DescribeTaskDefinitionCommand') {
        return {
          taskDefinition: {
            family: BASE_FAMILY,
            taskRoleArn: 'arn:task',
            executionRoleArn: 'arn:exec',
            networkMode: 'host',
            volumes: [{ name: 'state', host: { sourcePath: '/var/lib/gnome/gateway' } }],
            requiresCompatibilities: ['EC2'],
            containerDefinitions: [{
              name: 'gateway',
              image: 'image:1',
              environment: [{ name: 'ORCHESTRATOR_ROLE', value: 'gateway' }, { name: 'STAGE', value: 'dev' }],
            }],
          },
        };
      }
      if (name === 'RegisterTaskDefinitionCommand') {
        this.revisions++;
        return { taskDefinition: { taskDefinitionArn: `${command.input.family}:${this.revisions}` } };
      }
      if (name === 'CreateServiceCommand') {
        if (this.createFails) {
          // Another caller created it a moment before.
          this.services.push({ serviceName: command.input.serviceName, status: 'ACTIVE', desiredCount: 1 });
          throw new Error('Creation of service was not idempotent');
        }
        this.services.push({ serviceName: command.input.serviceName, status: 'ACTIVE', desiredCount: 1 });
        return {};
      }
      if (name === 'UpdateServiceCommand') {
        const service = this.services.find((s) => s.serviceName === command.input.service)!;
        service.desiredCount = command.input.desiredCount;
        service.taskDefinition = command.input.taskDefinition;
        return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };

  ec2 = {
    send: async (command: any) => {
      const name = command.constructor.name;
      this.sent.push({ command: name, input: command.input });
      if (name === 'DescribeAddressesCommand') {
        const wanted = command.input.Filters[0].Values[0];
        return { Addresses: this.addresses.filter((a) => a.Tags.some((t) => t.Key === ADDRESS_TAG && t.Value === wanted)) };
      }
      if (name === 'AllocateAddressCommand') {
        this.addresses.push({ AllocationId: `eipalloc-${this.addresses.length + 1}`, Tags: command.input.TagSpecifications[0].Tags });
        return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };

  commands(): string[] {
    return this.sent.map((s) => s.command);
  }
}

function deps(rows: Record<string, GatewayRow>, regions: Record<string, FakeRegion>, wanted: string[] = []): EnsureDeps {
  return {
    markWanted: async (key) => {
      wanted.push(key);
      if (!rows[key]) throw new Error(`no row ${key}`);
      return rows[key];
    },
    latestVersion: async () => '1.31.2',
    ecs: (region) => regions[region].ecs,
    ec2: (region) => regions[region].ec2,
  };
}

const KALSHI: GatewayRow = { gateway_key: 'live:kalshi:main', mode: 'live', region: 'us-east-1', orchestrator_version: null };
const INTL: GatewayRow = {
  gateway_key: 'live:polymarket_intl:main', mode: 'live', region: 'eu-west-1', orchestrator_version: '1.30.0',
};

describe('starting an order gateway when a session wants it', () => {
  it('creates a gateway that never ran, in its exchange\'s region, on the latest release, with an address of its own', async () => {
    const east = new FakeRegion();
    const west = new FakeRegion();
    const wanted: string[] = [];

    const result = await ensureGateway('live:kalshi:main', deps({ 'live:kalshi:main': KALSHI }, { 'us-east-1': east, 'eu-west-1': west }, wanted));

    expect(result).toEqual({ gatewayKey: 'live:kalshi:main', region: 'us-east-1', action: 'created', orchestratorVersion: '1.31.2' });
    expect(wanted).toEqual(['live:kalshi:main']);
    expect(west.sent).toEqual([]);
    const registered = east.sent.find((s) => s.command === 'RegisterTaskDefinitionCommand')!.input;
    expect(registered.family).toBe('order-gateway-live-kalshi-main');
    expect(registered.taskRoleArn).toBe('arn:task');
    expect(registered.containerDefinitions[0].environment).toEqual([
      { name: 'ORCHESTRATOR_ROLE', value: 'gateway' },
      { name: 'STAGE', value: 'dev' },
      { name: 'GATEWAY_KEY', value: 'live:kalshi:main' },
      { name: 'ORCHESTRATOR_VERSION', value: '1.31.2' },
    ]);
    const created = east.sent.find((s) => s.command === 'CreateServiceCommand')!.input;
    expect(created).toMatchObject({
      cluster: CLUSTER,
      serviceName: serviceName('live:kalshi:main'),
      taskDefinition: 'order-gateway-live-kalshi-main:1',
      desiredCount: 1,
      capacityProviderStrategy: [{ capacityProvider: CAPACITY_PROVIDER, weight: 1 }],
    });
    expect(east.addresses).toHaveLength(1);
    expect(east.addresses[0].Tags).toContainEqual({ Key: ADDRESS_TAG, Value: 'live:kalshi:main' });
  });

  it('starts a stopped gateway again on its pinned release, keeping its address', async () => {
    const west = new FakeRegion();
    west.services.push({ serviceName: serviceName(INTL.gateway_key), status: 'ACTIVE', desiredCount: 0 });
    west.addresses.push({ AllocationId: 'eipalloc-9', Tags: [{ Key: ADDRESS_TAG, Value: INTL.gateway_key }] });

    const result = await ensureGateway(INTL.gateway_key, deps({ [INTL.gateway_key]: INTL }, { 'eu-west-1': west }));

    expect(result).toMatchObject({ action: 'started', region: 'eu-west-1', orchestratorVersion: '1.30.0' });
    expect(west.services[0]).toMatchObject({ desiredCount: 1, taskDefinition: 'order-gateway-live-polymarket_intl-main:1' });
    expect(west.commands()).not.toContain('AllocateAddressCommand');
    expect(west.commands()).not.toContain('CreateServiceCommand');
  });

  it('leaves a running gateway as it is, so a waiting session can ask again and again', async () => {
    const east = new FakeRegion();
    east.services.push({ serviceName: serviceName(KALSHI.gateway_key), status: 'ACTIVE', desiredCount: 1 });
    const wanted: string[] = [];

    const result = await ensureGateway(KALSHI.gateway_key, deps({ [KALSHI.gateway_key]: KALSHI }, { 'us-east-1': east }, wanted));

    expect(result).toEqual({ gatewayKey: KALSHI.gateway_key, region: 'us-east-1', action: 'running' });
    expect(wanted).toEqual([KALSHI.gateway_key]);
    expect(east.commands()).toEqual(['DescribeServicesCommand']);
  });

  it('takes another caller having just created it as running', async () => {
    const east = new FakeRegion();
    east.createFails = true;

    const result = await ensureGateway(KALSHI.gateway_key, deps({ [KALSHI.gateway_key]: KALSHI }, { 'us-east-1': east }));

    expect(result.action).toBe('running');
  });

  it('refuses what isn\'t a live gateway it could run', async () => {
    const east = new FakeRegion();
    await expect(ensureGateway('paper', deps({}, { 'us-east-1': east }))).rejects.toThrow(/live gateway's key/);
    await expect(ensureGateway('live:somewhere:main', deps(
      { 'live:somewhere:main': { ...KALSHI, gateway_key: 'live:somewhere:main', region: 'sa-east-1' } },
      { 'us-east-1': east }))).rejects.toThrow(/no gateway can run/);
    expect(east.sent).toEqual([]);
  });
});
