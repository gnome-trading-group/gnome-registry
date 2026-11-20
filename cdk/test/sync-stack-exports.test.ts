import { Stage } from '@gnome-trading-group/gnome-shared-cdk';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/stacks/api-stack';
import { CacheStack } from '../lib/stacks/cache-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { IncentiveSyncStack } from '../lib/stacks/incentive-sync-stack';
import { SpecSyncStack } from '../lib/stacks/spec-sync-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };

// The names CloudFormation knows MonitoringStack's imports by: they must stay until these stacks are deleted.
describe('the sync stacks being retired', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const db = new DatabaseStack(app, 'Db', { env: ENV });
  const api = new ApiStack(app, 'Api', {
    env: ENV, database: db.database, vpc: db.vpc, rootUserSecret: db.rootUserSecret, stage: Stage.DEV,
  });
  const cache = new CacheStack(app, 'Cache', { env: ENV, stage: Stage.DEV });
  const specStack = new SpecSyncStack(app, 'SpecSyncStack', { env: ENV, api: api.api, apiKey: api.apiKey, cache: cache.bucket });
  const incentiveStack = new IncentiveSyncStack(app, 'IncentiveSyncStack', { env: ENV, api: api.api, apiKey: api.apiKey });
  const specs = Template.fromStack(specStack);
  const incentives = Template.fromStack(incentiveStack);
  const exports = (t: Template) => Object.values(t.toJSON().Outputs ?? {}).map((o: any) => o.Export?.Name);

  it('keep exporting what MonitoringStack imported from them', () => {
    expect(exports(specs)).toEqual(expect.arrayContaining([
      'SpecSyncStack:ExportsOutputRefspecsynclambdaDC63FEBE89390263',
      'SpecSyncStack:ExportsOutputRefspecrefreshlambda9DF5F98FAE3B1281',
      'SpecSyncStack:ExportsOutputFnGetAttSpecRefreshDeadLetters3C6F18E4QueueName7C9A5344',
    ]));
    expect(exports(incentives)).toEqual(expect.arrayContaining(['IncentiveSyncStack:ExportsOutputRefincentivesynclambda92E4A7C938870EEA']));
  });
});
