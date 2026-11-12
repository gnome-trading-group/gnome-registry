import { Stage } from '@gnome-trading-group/gnome-shared-cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/stacks/api-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { IncentiveSyncStack } from '../lib/stacks/incentive-sync-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };

describe('IncentiveSyncStack', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const db = new DatabaseStack(app, 'Db', { env: ENV });
  const api = new ApiStack(app, 'Api', {
    env: ENV, database: db.database, vpc: db.vpc, rootUserSecret: db.rootUserSecret, stage: Stage.DEV,
  });
  const template = Template.fromStack(new IncentiveSyncStack(app, 'Incentives', {
    env: ENV, api: api.api, apiKey: api.apiKey,
  }));

  it('runs every 15 minutes, outside the VPC, reaching the registry through its API', () => {
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(15 minutes)' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      VpcConfig: Match.absent(),
      Timeout: 600,
      Environment: { Variables: Match.objectLike({ REGISTRY_API_KEY_ID: Match.anyValue(), VENUES: '' }) },
    });
  });

  it('may read only the API key', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: [Match.objectLike({ Action: 'apigateway:GET' })] },
    });
  });
});
