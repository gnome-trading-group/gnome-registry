import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { join } from 'path';
import { SPEC_REFRESH_QUEUE } from '../../lambda/endpoints/spec-refresh-queue';
import { METADATA_SYNC_NAMESPACE } from '../../lambda/sync/metadata/metrics';
import { cronOf, heartbeatOf, schedule } from '../../lambda/sync/metadata/schedule';
import { ApiStack } from './api-stack';

interface Props extends cdk.StackProps {
  api: apigw.RestApi;
  apiKey: apigw.ApiKey;
  cache: s3.IBucket;
}

const KINDS = {
  specs: 'specs.ts',
  incentives: 'incentives.ts',
  fees: 'fees.ts',
} as const;
type KindName = keyof typeof KINDS;

// The venue metadata the registry keeps (listing specs, incentive programs, fee schedules; fee tiers to come): one
// Lambda per kind, run by the rules of one schedule (lambda/sync/metadata/schedule.ts, which keeps any two reads of
// one venue, and any two passes over a whole population, from overlapping), with each kind's snapshots in the cache
// bucket under its own prefix. Specs also read the refresh queue shards post tick changes to. Outside the VPC, like
// the other venue readers; no venue credentials. Its alarms are here, so no other stack imports from it.
export class MetadataSyncStack extends cdk.Stack {
  public readonly lambdas: Record<KindName, lambda.NodejsFunction>;
  public readonly refreshLambda: lambda.NodejsFunction;
  public readonly refreshQueue: sqs.Queue;
  public readonly refreshDeadLetters: sqs.Queue;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const readApiKey = new iam.PolicyStatement({ actions: ['apigateway:GET'], resources: [props.apiKey.keyArn] });
    const functionProps = (kind: KindName): lambda.NodejsFunctionProps => ({
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'metadata', KINDS[kind]),
      runtime: Runtime.NODEJS_20_X,
      memorySize: 1024,
      environment: {
        REGISTRY_API_URL: `https://${props.api.restApiId}.execute-api.${this.region}.${this.urlSuffix}/${ApiStack.STAGE_NAME}/`,
        REGISTRY_API_KEY_ID: props.apiKey.keyId,
        CACHE_BUCKET: props.cache.bucketName,
      },
      bundling: { externalModules: ['pg-native', '@aws-sdk/*'] },
    });

    // A failed run isn't retried: the next one is due anyway, and a retry of a timed-out run could run into it,
    // reading the same venue twice at once.
    const kindLambda = (kind: KindName) => {
      const fn = new lambda.NodejsFunction(this, `${kind}-sync-lambda`, {
        ...functionProps(kind), timeout: cdk.Duration.minutes(15), retryAttempts: 0,
      });
      fn.addToRolePolicy(readApiKey);
      props.cache.grantReadWrite(fn, `${kind}/*`);
      return fn;
    };
    this.lambdas = { specs: kindLambda('specs'), incentives: kindLambda('incentives'), fees: kindLambda('fees') };

    for (const entry of schedule()) {
      const { kind, mode, venue, variant } = entry;
      const name = [kind, mode, variant, venue].filter(Boolean).join('-');
      new events.Rule(this, `Sync-${name}`, {
        description: `Metadata sync: ${name}`,
        schedule: events.Schedule.cron(cronOf(entry)),
        targets: [new targets.LambdaFunction(this.lambdas[kind as KindName], {
          event: events.RuleTargetInput.fromObject({ mode, ...(venue ? { venue } : {}), ...(variant ? { variant } : {}) }),
        })],
      });
    }

    // A venue's API can trail its feed by a moment, so a refresh that doesn't see the new tick yet is read again after
    // the visibility timeout; five tries span several minutes, then it waits in the dead-letter queue (alarmed) and the
    // next reconcile records the change, dated then.
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
    // The specs kind's event-driven entry: its own function, since a refresh must finish well inside the queue's
    // visibility timeout and a scheduled run may take minutes.
    const { CACHE_BUCKET: _cacheBucket, ...refreshEnvironment } = functionProps('specs').environment!;
    this.refreshLambda = new lambda.NodejsFunction(this, 'specs-refresh-lambda', {
      ...functionProps('specs'), environment: refreshEnvironment, timeout: cdk.Duration.seconds(60),
    });
    this.refreshLambda.addToRolePolicy(readApiKey);
    this.refreshLambda.addEventSource(new SqsEventSource(this.refreshQueue, { batchSize: 10, reportBatchItemFailures: true }));

    this.alarms();
  }

  // Alarm names end in their severity and start with the service (Registry), which the alert router and the runbooks
  // read (docs/runbooks/cloudwatch/Registry.md).
  private alarms() {
    const alarm = (id: string, name: string, props: Omit<cloudwatch.AlarmProps, 'alarmName'>) =>
      new cloudwatch.Alarm(this, id, { alarmName: `Registry--MetadataSync-${name}`, ...props });
    const syncMetric = (metricName: string, kind: string, mode: string, venue: string, statistic: string, period: cdk.Duration) =>
      new cloudwatch.Metric({
        namespace: METADATA_SYNC_NAMESPACE, metricName, statistic, period,
        dimensionsMap: { Kind: kind, Mode: mode, Venue: venue },
      });

    for (const [kind, fn] of [...Object.entries(this.lambdas), ['specs-refresh', this.refreshLambda]] as [string, lambda.NodejsFunction][]) {
      alarm(`${kind}-fault`, `${kind}-Fault-Error`, {
        alarmDescription: `A ${kind} run failed: a venue couldn't be read, or the registry refused a write`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }
    alarm('specs-refresh-dlq', 'specs-Refresh-Dlq-Warning', {
      alarmDescription: 'A tick change a shard announced that the venue never confirmed; the next reconcile records it',
      metric: this.refreshDeadLetters.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // A heartbeat per kind, venue and mode that reads the venue: missing runs alarm like failed ones.
    for (const entry of schedule()) {
      if (!entry.venue || entry.variant || (entry.mode !== 'sweep' && entry.mode !== 'reconcile')) continue;
      const { kind, mode, venue } = entry;
      const { periodMinutes, evaluationPeriods } = heartbeatOf(entry);
      const period = cdk.Duration.minutes(periodMinutes);
      alarm(`${kind}-${mode}-${venue}-heartbeat`, `${kind}-${venue}-${mode}-Heartbeat-Error`, {
        alarmDescription: `No healthy ${kind} ${mode} of ${venue} lately: runs failing, refused, or not running`,
        metric: syncMetric('Ok', kind, mode, venue, 'Minimum', period),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods,
        datapointsToAlarm: evaluationPeriods,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      if (mode === 'sweep') {
        alarm(`${kind}-${venue}-nosnapshot`, `${kind}-${venue}-NoSnapshot-Warning`, {
          alarmDescription: `A ${kind} sweep of ${venue} found no snapshot and reconciled to make one`,
          metric: syncMetric('NoSnapshot', kind, mode, venue, 'Maximum', cdk.Duration.minutes(15)),
          threshold: 0,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
      }
    }
    for (const entry of schedule()) {
      if (entry.kind !== 'fees' || entry.mode !== 'sweep' || !entry.venue) continue;
      alarm(`fees-${entry.venue}-unreadable`, `fees-${entry.venue}-Unreadable-Warning`, {
        alarmDescription: `${entry.venue} charges a fee type whose schedule couldn't be read; its listings pay the exchange default`,
        metric: syncMetric('Unreadable', 'fees', 'sweep', entry.venue, 'Maximum', cdk.Duration.hours(1)),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }
    // While Kalshi's changed-since read is only shadowing the full read: a move it didn't name.
    alarm('specs-KALSHI-changed-missed', 'specs-KALSHI-ChangedMissed-Warning', {
      alarmDescription: "Kalshi's metadata-updated read missed a listing whose spec moved; it can't replace the full read yet",
      metric: syncMetric('ChangedMissed', 'specs', 'sweep', 'KALSHI', 'Maximum', cdk.Duration.minutes(15)),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
