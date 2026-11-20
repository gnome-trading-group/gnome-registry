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

  it('runs new listings every minute, and a full pass hourly and a missing-spec pass daily per venue, outside the VPC', () => {
    const rules = template.findResources('AWS::Events::Rule');
    const schedules = (mode: string) => Object.values(rules)
      .filter((r: any) => r.Properties.Targets.some((t: any) => JSON.parse(t.Input).mode === mode))
      .map((r: any) => ({ schedule: r.Properties.ScheduleExpression, venue: JSON.parse(r.Properties.Targets[0].Input).venue }));
    expect(schedules('new')).toEqual([{ schedule: 'rate(1 minute)', venue: undefined }]);
    const full = schedules('full');
    const missing = schedules('missing');
    expect(full.map(r => r.venue).sort()).toEqual([...SPEC_SYNC_EXCHANGES].sort());
    expect(missing.map(r => r.venue).sort()).toEqual([...SPEC_SYNC_EXCHANGES].sort());
    for (const r of full) expect(r.schedule).toMatch(/^cron\(\d+ \* \* \* \? \*\)$/);
    for (const r of missing) expect(r.schedule).toMatch(/^cron\(\d+ 8 \* \* \? \*\)$/);
    const minutes = [...full, ...missing].map(r => Number(r.schedule.match(/^cron\((\d+)/)![1]));
    expect(new Set(minutes).size).toBe(minutes.length);
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
