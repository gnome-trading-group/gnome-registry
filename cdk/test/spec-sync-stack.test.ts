import { Stage } from '@gnome-trading-group/gnome-shared-cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/stacks/api-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { SPEC_SYNC_EXCHANGES } from '../lambda/endpoints/spec-refresh-queue';
import { SpecSyncStack } from '../lib/stacks/spec-sync-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };

describe('SpecSyncStack', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const db = new DatabaseStack(app, 'Db', { env: ENV });
  const api = new ApiStack(app, 'Api', {
    env: ENV, database: db.database, vpc: db.vpc, rootUserSecret: db.rootUserSecret, stage: Stage.DEV,
  });
  const template = Template.fromStack(new SpecSyncStack(app, 'Specs', { env: ENV, api: api.api, apiKey: api.apiKey }));
  const apiTemplate = Template.fromStack(api);

  it('runs a full pass per venue every 15 minutes and a missing-spec pass every minute, outside the VPC', () => {
    for (const venue of SPEC_SYNC_EXCHANGES) {
      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: 'rate(15 minutes)',
        Targets: [Match.objectLike({ Input: JSON.stringify({ mode: 'full', venue }) })],
      });
    }
    template.resourcePropertiesCountIs('AWS::Events::Rule', { ScheduleExpression: 'rate(15 minutes)' },
      SPEC_SYNC_EXCHANGES.length);
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)', Targets: [Match.objectLike({ Input: '{"mode":"missing"}' })],
    });
    template.hasResourceProperties('AWS::Lambda::Function', { VpcConfig: Match.absent(), Timeout: 900 });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0 });
  });

  it('reads refreshes from the FIFO queue the API names, retrying a few times before the dead-letter queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'listing-spec-refresh.fifo', FifoQueue: true, VisibilityTimeout: 90,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'listing-spec-refresh-dlq.fifo', FifoQueue: true });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10, FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('lets the refresh route send only to that queue', () => {
    apiTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: 'sqs:SendMessage',
        Resource: 'arn:aws:sqs:us-east-1:123456789012:listing-spec-refresh.fifo',
      })]) },
    });
  });
});
