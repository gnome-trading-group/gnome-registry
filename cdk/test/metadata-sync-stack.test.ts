import { Stage } from '@gnome-trading-group/gnome-shared-cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/stacks/api-stack';
import { CacheStack } from '../lib/stacks/cache-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { MetadataSyncStack } from '../lib/stacks/metadata-sync-stack';
import { SPEC_SYNC_EXCHANGES } from '../lambda/endpoints/spec-refresh-queue';
import { FEE_VENUES, heartbeatGaps, INCENTIVE_VENUES, schedule, scheduleOverlaps } from '../lambda/sync/metadata/schedule';
import { VENUES as FEE_READERS } from '../lambda/sync/metadata/fees';
import { VENUES as INCENTIVE_READERS } from '../lambda/sync/metadata/incentives';
import { READERS as SPEC_READERS } from '../lambda/sync/metadata/specs';

const ENV = { account: '123456789012', region: 'us-east-1' };

describe('the metadata sync schedule', () => {
  it('never runs two reads of one venue, or two passes over a whole population, at once', () => {
    expect(scheduleOverlaps(schedule())).toEqual([]);
  });

  it("never sets off a heartbeat by itself, the hours the specs reconcile skips included", () => {
    expect(heartbeatGaps(schedule())).toEqual([]);
    // An hourly run that skips three hours in a row would: at 11:05 the 11:00 period hasn't had its run either.
    const hours = [...Array(24).keys()].filter(h => ![8, 9, 10].includes(h));
    expect(heartbeatGaps([{ kind: 'specs', mode: 'reconcile', venue: 'KALSHI', minutes: [30], hours, budgetMinutes: 5 }]))
      .toEqual([expect.stringContaining('3 60-minute periods with no run, for a heartbeat over 4')]);
  });

  it('runs every mode each kind needs on every venue it reads', () => {
    const modes = (kind: string, venue: string) => schedule().filter(e => e.kind === kind && e.venue === venue).map(e => e.mode + (e.variant ? `:${e.variant}` : ''));
    for (const venue of SPEC_SYNC_EXCHANGES) expect(modes('specs', venue).sort()).toEqual(['missing', 'reconcile', 'sweep']);
    for (const venue of INCENTIVE_VENUES) expect(modes('incentives', venue)).toEqual(expect.arrayContaining(['reconcile', 'sweep']));
    expect(modes('incentives', 'KALSHI')).toContain('sweep:payouts');
    for (const venue of FEE_VENUES) expect(modes('fees', venue).sort()).toEqual(['reconcile', 'sweep']);
    expect(schedule().filter(e => e.kind === 'specs' && e.mode === 'new')).toEqual([expect.objectContaining({ everyMinute: true })]);
  });

  it('covers exactly the venues each kind has readers for', () => {
    expect([...SPEC_SYNC_EXCHANGES].sort()).toEqual(Object.keys(SPEC_READERS).sort());
    expect([...INCENTIVE_VENUES].sort()).toEqual(Object.keys(INCENTIVE_READERS).sort());
    expect([...FEE_VENUES].sort()).toEqual(Object.keys(FEE_READERS).sort());
  });
});

describe('MetadataSyncStack', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const db = new DatabaseStack(app, 'Db', { env: ENV });
  const api = new ApiStack(app, 'Api', {
    env: ENV, database: db.database, vpc: db.vpc, rootUserSecret: db.rootUserSecret, stage: Stage.DEV,
  });
  const cache = new CacheStack(app, 'Cache', { env: ENV, stage: Stage.DEV });
  const stack = new MetadataSyncStack(app, 'Metadata', { env: ENV, api: api.api, apiKey: api.apiKey, cache: cache.bucket });
  const template = Template.fromStack(stack);
  const apiTemplate = Template.fromStack(api);

  it('makes one rule per scheduled run, each naming its mode, venue and read', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule'));
    expect(rules).toHaveLength(schedule().length);
    const inputs = rules.map((r: any) => JSON.parse(r.Properties.Targets[0].Input));
    expect(inputs).toContainEqual({ mode: 'new' });
    expect(inputs).toContainEqual({ mode: 'sweep', venue: 'KALSHI', variant: 'payouts' });
    expect(inputs).toContainEqual({ mode: 'reconcile', venue: 'POLYMARKET_INTL' });
  });

  it('runs each kind in its own function outside the VPC, never retried, with its own part of the cache', () => {
    template.resourcePropertiesCountIs('AWS::Lambda::Function', { Timeout: 900, VpcConfig: Match.absent() }, 3);
    template.resourcePropertiesCountIs('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0 }, 3);
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('/specs/*');
    expect(policies).toContain('/incentives/*');
    expect(policies).toContain('/fees/*');
  });

  it('reads refreshes from the FIFO queue the API sends to, retrying a few times before the dead-letter queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'listing-spec-refresh.fifo', FifoQueue: true, VisibilityTimeout: 90,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'listing-spec-refresh-dlq.fifo', FifoQueue: true });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 10, FunctionResponseTypes: ['ReportBatchItemFailures'] });
    apiTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: 'sqs:SendMessage', Resource: 'arn:aws:sqs:us-east-1:123456789012:listing-spec-refresh.fifo',
      })]) },
    });
  });

  it('alarms on faults, on a missing or failing heartbeat per kind, venue and mode, and on a missing snapshot', () => {
    const names = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((a: any) => a.Properties.AlarmName as string);
    for (const name of names) expect(name).toMatch(/^Registry--MetadataSync-.+-(Error|Warning)$/);
    expect(names).toEqual(expect.arrayContaining([
      'Registry--MetadataSync-specs-Fault-Error', 'Registry--MetadataSync-incentives-Fault-Error',
      'Registry--MetadataSync-fees-Fault-Error', 'Registry--MetadataSync-fees-POLYMARKET_INTL-sweep-Heartbeat-Error',
      'Registry--MetadataSync-fees-KALSHI-reconcile-Heartbeat-Error', 'Registry--MetadataSync-fees-KALSHI-NoSnapshot-Warning',
      'Registry--MetadataSync-fees-POLYMARKET_INTL-Unreadable-Warning',
      'Registry--MetadataSync-specs-refresh-Fault-Error', 'Registry--MetadataSync-specs-Refresh-Dlq-Warning',
      'Registry--MetadataSync-specs-KALSHI-sweep-Heartbeat-Error', 'Registry--MetadataSync-incentives-POLYMARKET_US-reconcile-Heartbeat-Error',
      'Registry--MetadataSync-specs-KALSHI-NoSnapshot-Warning', 'Registry--MetadataSync-specs-KALSHI-ChangedMissed-Warning',
    ]));
    const heartbeats = names.filter(n => n.endsWith('Heartbeat-Error'));
    expect(heartbeats).toHaveLength(2 * (SPEC_SYNC_EXCHANGES.length + INCENTIVE_VENUES.length + FEE_VENUES.length));
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'Registry--MetadataSync-specs-KALSHI-sweep-Heartbeat-Error', TreatMissingData: 'breaching', MetricName: 'Ok',
    });
  });

  it('exports nothing, so no other stack can come to depend on it', () => {
    expect(JSON.stringify(Template.fromStack(stack).toJSON().Outputs ?? {})).toBe('{}');
  });
});
