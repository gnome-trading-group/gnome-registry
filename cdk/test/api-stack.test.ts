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
  });
  return Template.fromStack(api);
}

function resourceId(template: Template, pathPart: string, parentPathPart?: string): string {
  const resources = template.findResources('AWS::ApiGateway::Resource', {
    Properties: { PathPart: pathPart },
  });
  const ids = Object.keys(resources).filter(id => {
    if (!parentPathPart) return true;
    const parentRef = resources[id].Properties.ParentId.Ref;
    return parentRef !== undefined && parentRef.includes(parentPathPart.replace(/[^A-Za-z0-9]/g, ''));
  });
  expect(ids).toHaveLength(1);
  return ids[0];
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
  const policies = resourceId(template, 'policies');
  const history = resourceId(template, 'history');
  const halts = resourceId(template, 'halts');
  const stop = resourceId(template, 'stop');
  const launch = resourceId(template, 'launch');

  it('creates a Cognito authorizer from the SSM user pool ARN', () => {
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
      ProviderARNs: [{ Ref: Match.stringLikeRegexp('SsmParameterValue.*gnome.*cognito.*user.*pool.*arn') }],
    });
  });

  it.each([
    ['POST policies', () => policies, 'POST'],
    ['PATCH policies', () => policies, 'PATCH'],
    ['DELETE policies', () => policies, 'DELETE'],
    ['POST stop', () => stop, 'POST'],
  ])('%s requires Cognito instead of the API key', (_name, resource, httpMethod) => {
    const props = method(template, resource(), httpMethod);
    expect(props.AuthorizationType).toBe('COGNITO_USER_POOLS');
    expect(props.AuthorizerId).toBeDefined();
    expect(props.ApiKeyRequired).toBeFalsy();
  });

  it.each([
    ['GET policies', () => policies, 'GET'],
    ['GET history', () => history, 'GET'],
    ['POST halts', () => halts, 'POST'],
    ['POST launch', () => launch, 'POST'],
  ])('%s stays on the API key', (_name, resource, httpMethod) => {
    const props = method(template, resource(), httpMethod);
    expect(props.ApiKeyRequired).toBe(true);
    expect(props.AuthorizationType).toBe('NONE');
  });

  it.each([
    ['policies', () => policies],
    ['stop', () => stop],
    ['halts', () => halts],
  ])('leaves the %s CORS preflight unauthenticated', (_name, resource) => {
    const props = method(template, resource(), 'OPTIONS');
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
