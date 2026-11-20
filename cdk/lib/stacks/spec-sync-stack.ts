import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { join } from 'path';
import { SPEC_REFRESH_QUEUE, SPEC_SYNC_EXCHANGES } from '../../lambda/endpoints/spec-refresh-queue';
import { ApiStack } from './api-stack';

interface Props extends cdk.StackProps {
  api: apigw.RestApi;
  apiKey: apigw.ApiKey;
  cache: s3.IBucket;
}

// The spec sync, the only writer of listing specs: every minute it gives new listings their first spec, every 15 minutes
// it sweeps each venue for specs that moved, hourly it checks every active listing's spec against its venue, daily it
// looks for older listings still without one, and it checks a listing a shard saw change as soon as the refresh queue
// has it. Outside the VPC, like the other venue readers; it needs no venue credentials.
export class SpecSyncStack extends cdk.Stack {
  public readonly syncLambda: lambda.NodejsFunction;
  public readonly refreshLambda: lambda.NodejsFunction;
  public readonly refreshQueue: sqs.Queue;
  public readonly refreshDeadLetters: sqs.Queue;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const shared: lambda.NodejsFunctionProps = {
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'spec-sync.ts'),
      runtime: Runtime.NODEJS_20_X,
      memorySize: 1024,
      environment: {
        REGISTRY_API_URL: `https://${props.api.restApiId}.execute-api.${this.region}.${this.urlSuffix}/${ApiStack.STAGE_NAME}/`,
        REGISTRY_API_KEY_ID: props.apiKey.keyId,
      },
      bundling: {
        externalModules: ['pg-native', '@aws-sdk/*'],
      },
    };
    const readApiKey = new iam.PolicyStatement({ actions: ['apigateway:GET'], resources: [props.apiKey.keyArn] });

    // A venue's full pass reads every listing it trades: Kalshi's ~90k take about two minutes, Polymarket Intl's ~600
    // Gamma pages about as long. One rule per venue, so one slow venue can't hold up or time out the rest, each at its
    // own minute of the hour so no two read every active listing from the database at once.
    // A failed pass isn't retried: the next one is due anyway, and a retry of a timed-out pass could run into it,
    // reading the same venue twice at once.
    this.syncLambda = new lambda.NodejsFunction(this, 'spec-sync-lambda', {
      ...shared,
      environment: { ...shared.environment, CACHE_BUCKET: props.cache.bucketName },
      timeout: cdk.Duration.minutes(15),
      retryAttempts: 0,
    });
    this.syncLambda.addToRolePolicy(readApiKey);
    props.cache.grantReadWrite(this.syncLambda, 'specs/*');
    const minutesApart = Math.floor(60 / SPEC_SYNC_EXCHANGES.length);
    SPEC_SYNC_EXCHANGES.forEach((venue, i) => {
      const minute = String(i * minutesApart);
      new events.Rule(this, `SpecSyncFullRule${venue}`, {
        description: `Spec sync: checks every active ${venue} listing spec against the venue`,
        schedule: events.Schedule.cron({ minute }),
        targets: [new targets.LambdaFunction(this.syncLambda, {
          event: events.RuleTargetInput.fromObject({ mode: 'full', venue }),
        })],
      });
      // Halfway between full passes, so a sweep never reads the venue while its full pass does.
      const sweepMinutes = [0, 15, 30, 45].map(m => (i * minutesApart + Math.floor(minutesApart / 2) + m) % 60);
      new events.Rule(this, `SpecSyncSweepRule${venue}`, {
        description: `Spec sync: sweeps ${venue} for listing specs that moved`,
        schedule: events.Schedule.cron({ minute: sweepMinutes.sort((a, b) => a - b).join(',') }),
        targets: [new targets.LambdaFunction(this.syncLambda, {
          event: events.RuleTargetInput.fromObject({ mode: 'sweep', venue }),
        })],
      });
      // Off the full passes' and the venue's sweeps' minutes, at night in the US.
      new events.Rule(this, `SpecSyncMissingRule${venue}`, {
        description: `Spec sync: gives older active ${venue} listings still without a spec their first`,
        schedule: events.Schedule.cron({ minute: String(i * minutesApart + Math.floor(minutesApart / 4)), hour: '8' }),
        targets: [new targets.LambdaFunction(this.syncLambda, {
          event: events.RuleTargetInput.fromObject({ mode: 'missing', venue }),
        })],
      });
    });
    new events.Rule(this, 'SpecSyncNewRule', {
      description: 'Spec sync: gives new listings their first spec',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.syncLambda, { event: events.RuleTargetInput.fromObject({ mode: 'new' }) })],
    });

    // A venue's API can trail its feed by a moment, so a refresh that doesn't see the new tick yet is read again after
    // the visibility timeout; five tries span several minutes, then it waits in the dead-letter queue (alarmed) and the
    // next full pass records the change, dated then.
    this.refreshDeadLetters = new sqs.Queue(this, 'SpecRefreshDeadLetters', {
      queueName: SPEC_REFRESH_QUEUE.replace('.fifo', '-dlq.fifo'),
      fifo: true,
      retentionPeriod: cdk.Duration.days(4),
    });
    this.refreshQueue = new sqs.Queue(this, 'SpecRefreshQueue', {
      queueName: SPEC_REFRESH_QUEUE,
      fifo: true,
      visibilityTimeout: cdk.Duration.seconds(90),
      deadLetterQueue: { queue: this.refreshDeadLetters, maxReceiveCount: 5 },
    });
    this.refreshLambda = new lambda.NodejsFunction(this, 'spec-refresh-lambda', { ...shared, timeout: cdk.Duration.seconds(60) });
    this.refreshLambda.addToRolePolicy(readApiKey);
    this.refreshLambda.addEventSource(new SqsEventSource(this.refreshQueue, { batchSize: 10, reportBatchItemFailures: true }));
  }
}
