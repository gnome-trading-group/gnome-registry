import { Stage } from '@gnome-trading-group/gnome-shared-cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/stacks/api-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { SAMPLES_API_URL_PARAMETER, SamplesApiStack } from '../lib/stacks/samples-api-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };

function synthSamples(): Template {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const db = new DatabaseStack(app, 'Db', { env: ENV });
  const api = new ApiStack(app, 'Api', {
    env: ENV, database: db.database, vpc: db.vpc, rootUserSecret: db.rootUserSecret, stage: Stage.DEV,
  });
  return Template.fromStack(new SamplesApiStack(app, 'Samples', {
    env: ENV, database: db.database, vpc: db.vpc, rootUserSecret: db.rootUserSecret, apiKey: api.apiKey,
  }));
}

// The caller kinds a method's authorizer admits, read from the ALLOWED_KINDS of the function behind it.
function kindsOf(template: Template, httpMethod: string): string[] {
  const methods = Object.values(template.findResources('AWS::ApiGateway::Method', {
    Properties: { HttpMethod: httpMethod },
  }));
  expect(methods).toHaveLength(1);
  const authorizer = template.findResources('AWS::ApiGateway::Authorizer')[methods[0].Properties.AuthorizerId.Ref];
  const fnId = JSON.stringify(authorizer.Properties.AuthorizerUri).match(/"Fn::GetAtt":\["([^"]+)","Arn"\]/)![1];
  return template.findResources('AWS::Lambda::Function')[fnId].Properties.Environment.Variables.ALLOWED_KINDS.split(',');
}

describe('SamplesApiStack', () => {
  const template = synthSamples();

  it('serves one samples resource: services post, and services, people and bots read', () => {
    template.resourceCountIs('AWS::ApiGateway::Resource', 1);
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'samples' });
    expect(kindsOf(template, 'POST').sort()).toEqual(['service']);
    expect(kindsOf(template, 'GET').sort()).toEqual(['bot', 'person', 'service']);
  });

  it('publishes its URL for gateways, shards and readers', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: SAMPLES_API_URL_PARAMETER });
  });

  it('keeps the partitions every hour', () => {
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 hour)' });
  });

  it('runs its Lambdas in the VPC, able to reach the database', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function', {
      Properties: { Environment: { Variables: { DATABASE_SECRET_JSON: Match.anyValue() } } },
    }));
    expect(fns).toHaveLength(2);
    for (const fn of fns as any[]) expect(fn.Properties.VpcConfig).toBeDefined();
  });
});
