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

describe('ApiStack auth', () => {
  const template = synthApi();

  it('creates a Cognito authorizer from the SSM user pool ARN', () => {
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
      ProviderARNs: [{ Ref: Match.stringLikeRegexp('SsmParameterValue.*gnome.*cognito.*user.*pool.*arn') }],
    });
  });

  it('never mixes the API key and Cognito: root methods take the key, /cognito methods take a token', () => {
    const resources = template.findResources('AWS::ApiGateway::Resource');
    const cognitoRoot = resourceId(template, 'cognito');
    const underCognito = (id: string): boolean => {
      if (id === cognitoRoot) return true;
      const parent = resources[id]?.Properties.ParentId.Ref;
      return parent !== undefined && resources[parent] !== undefined && underCognito(parent);
    };
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method'))
      .map(m => m.Properties)
      .filter(p => p.HttpMethod !== 'OPTIONS' && p.ResourceId.Ref);
    expect(methods.length).toBeGreaterThan(0);
    for (const props of methods) {
      if (underCognito(props.ResourceId.Ref)) {
        expect(props.AuthorizationType).toBe('COGNITO_USER_POOLS');
        expect(props.ApiKeyRequired).toBeFalsy();
      } else {
        expect(props.ApiKeyRequired).toBe(true);
        expect(props.AuthorizationType).toBe('NONE');
      }
    }
  });

  it.each([
    ['cognito/risk/policies', 'GET'],
    ['cognito/risk/policies', 'POST'],
    ['cognito/risk/policies', 'PATCH'],
    ['cognito/risk/policies', 'DELETE'],
    ['cognito/risk/policies/history', 'GET'],
    ['cognito/strategy-sessions', 'GET'],
    ['cognito/strategy-sessions/launch', 'POST'],
    ['cognito/strategy-sessions/stop', 'POST'],
    ['cognito/strategy-sessions/logs', 'GET'],
    ['cognito/listings', 'PATCH'],
    ['cognito/hedge-keywords', 'DELETE'],
  ])('%s %s is reachable with a Cognito token', (path, httpMethod) => {
    const props = method(template, resourceId(template, path), httpMethod);
    expect(props.AuthorizerId).toBeDefined();
  });

  it.each([
    ['risk/policies', 'GET'],
    ['risk/policies/history', 'GET'],
    ['risk/halts', 'POST'],
    ['strategy-sessions/launch', 'POST'],
    ['pnl/snapshots', 'POST'],
    ['strategy-sessions/stop', 'POST'],
  ])('%s %s stays on the API key for services', (path, httpMethod) => {
    method(template, resourceId(template, path), httpMethod);
  });

  it.each([
    ['risk/policies', 'POST'],
    ['risk/policies', 'PATCH'],
    ['risk/policies', 'DELETE'],
  ])('%s %s is not exposed to the API key', (path, httpMethod) => {
    const methods = template.findResources('AWS::ApiGateway::Method', {
      Properties: { HttpMethod: httpMethod, ResourceId: { Ref: resourceId(template, path) } },
    });
    expect(Object.keys(methods)).toHaveLength(0);
  });

  it.each([
    ['cognito/risk/halts', 'POST'],
    ['cognito/pnl/snapshots', 'POST'],
    ['cognito/strategy-sessions', 'PATCH'],
    ['cognito/strategy-sessions', 'POST'],
  ])('keeps service-only %s %s off /cognito', (path, httpMethod) => {
    if (!hasResource(template, path)) return;
    const methods = template.findResources('AWS::ApiGateway::Method', {
      Properties: { HttpMethod: httpMethod, ResourceId: { Ref: resourceId(template, path) } },
    });
    expect(Object.keys(methods)).toHaveLength(0);
  });

  it.each([
    ['risk/policies'],
    ['cognito/risk/policies'],
    ['cognito/strategy-sessions/stop'],
    ['risk/halts'],
  ])('leaves the %s CORS preflight unauthenticated', path => {
    const props = method(template, resourceId(template, path), 'OPTIONS');
    expect(props.AuthorizationType).toBe('NONE');
    expect(props.ApiKeyRequired).toBeFalsy();
  });

  it('returns CORS headers on gateway 4xx so Cognito rejections are readable in the browser', () => {
    template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
      ResponseType: 'DEFAULT_4XX',
      ResponseParameters: { 'gatewayresponse.header.Access-Control-Allow-Origin': "'*'" },
    });
  });
});
