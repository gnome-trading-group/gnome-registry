import { Stage } from '@gnome-trading-group/gnome-shared-cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/stacks/api-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };

function synthApi(): Template {
  // Skips esbuild bundling of every endpoint so the test only checks the API wiring.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const db = new DatabaseStack(app, 'Db', { env: ENV });
  const api = new ApiStack(app, 'Api', {
    env: ENV,
    database: db.database,
    vpc: db.vpc,
    rootUserSecret: db.rootUserSecret,
    stage: Stage.DEV,
  });
  return Template.fromStack(api);
}

function resourceId(template: Template, path: string): string {
  const resources = template.findResources('AWS::ApiGateway::Resource');
  const fullPath = (id: string): string => {
    const { PathPart, ParentId } = resources[id].Properties;
    return ParentId.Ref && resources[ParentId.Ref] ? `${fullPath(ParentId.Ref)}/${PathPart}` : PathPart;
  };
  const ids = Object.keys(resources).filter(id => fullPath(id) === path);
  expect(ids).toHaveLength(1);
  return ids[0];
}

function hasResource(template: Template, path: string): boolean {
  const resources = template.findResources('AWS::ApiGateway::Resource');
  const fullPath = (id: string): string => {
    const { PathPart, ParentId } = resources[id].Properties;
    return ParentId.Ref && resources[ParentId.Ref] ? `${fullPath(ParentId.Ref)}/${PathPart}` : PathPart;
  };
  return Object.keys(resources).some(id => fullPath(id) === path);
}

function method(template: Template, resource: string, httpMethod: string) {
  const methods = template.findResources('AWS::ApiGateway::Method', {
    Properties: { HttpMethod: httpMethod, ResourceId: { Ref: resource } },
  });
  const values = Object.values(methods);
  expect(values).toHaveLength(1);
  return values[0].Properties;
}

// The caller kinds a method's authorizer admits, read from the ALLOWED_KINDS of the function behind it.
function kindsOf(template: Template, path: string, httpMethod: string): string[] {
  const props = method(template, resourceId(template, path), httpMethod);
  const authorizer = template.findResources('AWS::ApiGateway::Authorizer')[props.AuthorizerId.Ref];
  const fnId = JSON.stringify(authorizer.Properties.AuthorizerUri).match(/"Fn::GetAtt":\["([^"]+)","Arn"\]/)![1];
  const fn = template.findResources('AWS::Lambda::Function')[fnId];
  return fn.Properties.Environment.Variables.ALLOWED_KINDS.split(',');
}

describe('ApiStack auth', () => {
  const template = synthApi();

  it('checks people against the Cognito pool published in SSM', () => {
    const authorizerFns = Object.values(template.findResources('AWS::Lambda::Function'))
      .filter((f: any) => f.Properties.Environment?.Variables?.ALLOWED_KINDS);
    expect(authorizerFns.length).toBeGreaterThan(0);
    for (const fn of authorizerFns as any[]) {
      expect(JSON.stringify(fn.Properties.Environment.Variables.USER_POOL_ID)).toMatch(/SsmParameterValue.*gnome.*cognito.*user.*pool.*arn/);
    }
  });

  it('puts every method but the preflights behind the shared authorizer, with no API key requirement', () => {
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method')).map(m => m.Properties);
    const routed = methods.filter(p => p.HttpMethod !== 'OPTIONS');
    expect(routed.length).toBeGreaterThan(0);
    for (const props of routed) {
      expect(props.AuthorizationType).toBe('CUSTOM');
      expect(props.AuthorizerId).toBeDefined();
      expect(props.ApiKeyRequired).toBeFalsy();
    }
  });

  it('has a single route tree, with no /cognito copy', () => {
    expect(hasResource(template, 'cognito')).toBe(false);
  });

  it.each([
    // Services alone: sessions and pollers writing what they observe, the OMS halting itself, secret names.
    ['risk/halts', 'POST', ['service']],
    ['ledger/batch', 'POST', ['service']],
    ['ledger/poller-marks', 'POST', ['service']],
    ['strategy-sessions', 'PATCH', ['service']],
    ['strategy-sessions', 'POST', ['service']],
    ['strategy-sessions/heartbeat', 'POST', ['service']],
    ['venue-accounts', 'POST', ['service']],
    ['venue-accounts/secrets', 'GET', ['service']],
    ['venue-accounts/secrets', 'PUT', ['service']],
    ['treasury/poll-targets', 'GET', ['service']],
    // People alone, so the audit log attributes each change to a person.
    ['risk/policies', 'POST', ['person']],
    ['risk/policies', 'PATCH', ['person']],
    ['risk/policies', 'DELETE', ['person']],
    ['ledger/adjustments', 'POST', ['person']],
    ['venue-accounts/status', 'PATCH', ['person']],
    ['venue-accounts/create', 'POST', ['person']],
    ['venue-accounts/credentials', 'POST', ['person']],
    ['venue-accounts/delete-secrets', 'POST', ['person']],
    ['market-data-keys', 'GET', ['person']],
    ['market-data-keys', 'POST', ['person']],
    ['treasury/transfers', 'POST', ['person']],
    ['treasury/account-config', 'PUT', ['person']],
    ['sources', 'POST', ['person']],
    ['sources', 'PATCH', ['person']],
    ['alerts', 'PATCH', ['person']],
    ['listings', 'PATCH', ['person', 'service']],
    ['hedge-keywords', 'DELETE', ['person', 'service']],
    // Services and people.
    ['strategy-sessions/launch', 'POST', ['person', 'service']],
    ['strategy-sessions/stop', 'POST', ['person', 'service']],
    ['treasury/snapshots', 'POST', ['person', 'service']],
    ['fees', 'POST', ['person', 'service']],
    // Reads a bot may make for an operator.
    ['pnl/series', 'GET', ['bot', 'person']],
    ['monitoring/attention', 'GET', ['bot', 'person']],
    ['alerts', 'GET', ['bot', 'person']],
    ['venue-accounts', 'GET', ['bot', 'person']],
    ['treasury/summary', 'GET', ['bot', 'person']],
    ['treasury/recon', 'GET', ['bot', 'person']],
    ['orchestrator/properties', 'GET', ['bot', 'person']],
    ['risk/policies', 'GET', ['bot', 'person', 'service']],
    ['risk/policies/history', 'GET', ['bot', 'person', 'service']],
    ['strategy-sessions', 'GET', ['bot', 'person', 'service']],
    ['strategy-sessions/logs', 'GET', ['bot', 'person', 'service']],
    ['strategy-sessions/accounts', 'GET', ['bot', 'person', 'service']],
    ['ledger/positions', 'GET', ['bot', 'person', 'service']],
    ['ledger/orders', 'GET', ['bot', 'person', 'service']],
    ['sources', 'GET', ['bot', 'person', 'service']],
    ['streams', 'GET', ['bot', 'person', 'service']],
    ['listings', 'GET', ['bot', 'person', 'service']],
  ])('%s %s admits %j', (path, httpMethod, kinds) => {
    expect(kindsOf(template, path, httpMethod)).toEqual(kinds);
  });

  it('only ever lets a bot read', () => {
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method')).map(m => m.Properties)
      .filter(p => p.HttpMethod !== 'OPTIONS');
    const authorizers = template.findResources('AWS::ApiGateway::Authorizer');
    const functions = template.findResources('AWS::Lambda::Function');
    for (const props of methods) {
      const fnId = JSON.stringify(authorizers[props.AuthorizerId.Ref].Properties.AuthorizerUri).match(/"Fn::GetAtt":\["([^"]+)","Arn"\]/)![1];
      if (functions[fnId].Properties.Environment.Variables.ALLOWED_KINDS.split(',').includes('bot')) {
        expect(props.HttpMethod).toBe('GET');
      }
    }
  });

  it('lets the account creator touch only venue account and market data secrets', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => [s.Action].flat().includes('secretsmanager:CreateSecret'));
    expect(statements).toHaveLength(1);
    const resources = JSON.stringify(statements[0].Resource);
    expect(resources).toContain('secret:gnome/accounts/*');
    expect(resources).toContain('secret:gnome/market-data/*');
    expect([statements[0].Resource].flat()).toHaveLength(2);
  });

  it('mirrors the API key into its fixed-name secret without passing the value through the template', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'gnome/api-keys/registry', SecretString: 'pending' });
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      ApiKeyId: { Ref: Match.stringLikeRegexp('^ApiKey') },
    });
  });

  it('stays well under the CloudFormation limit of 500 resources per stack', () => {
    expect(Object.keys(template.toJSON().Resources).length).toBeLessThan(450);
  });

  it.each([
    ['risk/policies'],
    ['strategy-sessions/stop'],
    ['sources'],
  ])('leaves the %s CORS preflight unauthenticated', path => {
    const props = method(template, resourceId(template, path), 'OPTIONS');
    expect(props.AuthorizationType).toBe('NONE');
    expect(props.ApiKeyRequired).toBeFalsy();
  });

  it('returns CORS headers on gateway 4xx so authorizer rejections are readable in the browser', () => {
    template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
      ResponseType: 'DEFAULT_4XX',
      ResponseParameters: { 'gatewayresponse.header.Access-Control-Allow-Origin': "'*'" },
    });
  });
});
