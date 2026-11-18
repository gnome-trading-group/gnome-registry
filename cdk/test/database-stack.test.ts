import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/stacks/database-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };

describe('DatabaseStack migrations', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const template = Template.fromStack(new DatabaseStack(app, 'Db', { env: ENV }));

  function initFunctionId(): string {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { Timeout: 900 },
    });
    const ids = Object.keys(functions).filter((id) => id.includes('DatabaseInitLambdaLambda'));
    expect(ids).toHaveLength(1);
    return ids[0];
  }

  it('gives the migration runner the longest Lambda timeout', () => {
    initFunctionId();
  });

  it('runs the migrations on deploy, waiting for them, against the runner version so a new migration runs it again', () => {
    const triggers = template.findResources('Custom::Trigger');
    expect(Object.keys(triggers)).toHaveLength(1);
    const trigger = Object.values(triggers)[0];
    expect(trigger.Properties).toMatchObject({ InvocationType: 'RequestResponse', Timeout: '900000' });
    const handlerArn = JSON.stringify(trigger.Properties.HandlerArn);
    const versionId = handlerArn.match(/"Ref":"([^"]+)"/)![1];
    template.hasResource('AWS::Lambda::Version', {
      Properties: { FunctionName: { Ref: initFunctionId() } },
    });
    expect(template.findResources('AWS::Lambda::Version')[versionId]).toBeDefined();
  });

  it('runs them only after the database exists: trigger -> runner version -> runner -> database', () => {
    const instance = Object.keys(template.findResources('AWS::RDS::DBInstance'))[0];
    const runner = template.findResources('AWS::Lambda::Function')[initFunctionId()];
    expect(runner.DependsOn).toEqual(expect.arrayContaining([instance]));
    template.hasResource('AWS::Lambda::Version', Match.objectLike({
      Properties: { FunctionName: { Ref: initFunctionId() } },
    }));
  });
});
