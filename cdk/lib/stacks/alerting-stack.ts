import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { join } from 'path';
import { RegistryConfig } from '../config';
import { ALERT_BUS_NAME, ALERT_EVENT_SOURCE, METRICS_NAMESPACE } from '../../lambda/alerts/model';

interface Props extends cdk.StackProps {
  database: rds.DatabaseInstance;
  vpc: ec2.Vpc;
  rootUserSecret: secrets.Secret;
  apiKey: apigw.ApiKey;
  stage: string;
  alerting: RegistryConfig['alerting'];
}

const SLACK_BOT_TOKEN_SECRET = 'slack-bot-token';
const INCIDENT_IO_SECRET = 'incident-io-alert-source';
// incident.io's CloudWatch alert source URL, set by hand once the source exists (prod).
const INCIDENT_IO_CLOUDWATCH_URL_PARAMETER = '/gnome/alerting/incident-io-cloudwatch-url';
export const ALERTS_API_URL_PARAMETER = '/gnome/alerting/api-url';
export const ALERT_BUS_NAME_PARAMETER = '/gnome/alerting/bus-name';
const META_PREFIX = 'AlertingMeta-';

// One path for every alert: the monitoring rules' 1-minute tick, the ingest API, services in the account and
// CloudWatch alarms all put alerts on one bus; the router records each with the store and delivers it to Slack and,
// in prod, incident.io. Alerting's own health is watched by alarms that skip the router entirely.
export class AlertingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const bus = new events.EventBus(this, 'AlertBus', { eventBusName: ALERT_BUS_NAME });

    const store = new lambda.NodejsFunction(this, 'alert-store-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'alerts', 'alert-store.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        DATABASE_SECRET_JSON: props.rootUserSecret.secretValue.unsafeUnwrap(),
        STAGE: props.stage,
      },
      bundling: { externalModules: ['pg-native'] },
      vpc: props.vpc,
      vpcSubnets: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }),
    });
    props.database.grantConnect(store);

    const dlq = new sqs.Queue(this, 'AlertDlq', { retentionPeriod: cdk.Duration.days(14) });
    const router = new lambda.NodejsFunction(this, 'alert-router-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'alerts', 'alert-router.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        STORE_FUNCTION_NAME: store.functionName,
        STAGE: props.stage,
        SLACK_BOT_TOKEN_SECRET,
        SLACK_CHANNEL: props.alerting.slackChannel,
        CONTROLLER_URL: props.alerting.controllerUrl,
        ...(props.alerting.incidentIo ? { INCIDENT_IO_SECRET } : {}),
      },
      bundling: { externalModules: ['pg-native', '@aws-sdk/*'] },
    });
    // EventBridge invokes it asynchronously, so a failure is retried by Lambda, not the rule; one that keeps failing
    // (the store unreachable) is kept for a person to redrive.
    router.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: cdk.Duration.hours(1),
      onFailure: new destinations.SqsDestination(dlq),
    });
    store.grantInvoke(router);
    bus.grantPutEventsTo(router);
    secrets.Secret.fromSecretNameV2(this, 'SlackBotToken', SLACK_BOT_TOKEN_SECRET).grantRead(router);
    if (props.alerting.incidentIo) {
      secrets.Secret.fromSecretNameV2(this, 'IncidentIoSecret', INCIDENT_IO_SECRET).grantRead(router);
    }

    new events.Rule(this, 'AlertRule', {
      description: 'Alerts: every alert on the bus goes to the router',
      eventBus: bus,
      eventPattern: { source: [ALERT_EVENT_SOURCE] },
      targets: [new targets.LambdaFunction(router, { deadLetterQueue: dlq })],
    });
    new events.Rule(this, 'AlarmRule', {
      description: 'Alerts: CloudWatch alarm state changes go to the router',
      eventPattern: { source: ['aws.cloudwatch'], detailType: ['CloudWatch Alarm State Change'] },
      targets: [new targets.LambdaFunction(router, { deadLetterQueue: dlq })],
    });
    // A Rule rather than an EventBridge Scheduler schedule so the controller's System page lists it with its jobs.
    new events.Rule(this, 'AlertTickRule', {
      description: 'Alerts: runs the monitoring rules every minute',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(router, { deadLetterQueue: dlq })],
    });

    // The ingest API: its own API so the registry API's deploys and resource limit never touch it. Callers use the
    // registry's API key.
    const ingest = new lambda.NodejsFunction(this, 'alerts-ingest-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'alerts', 'alerts-ingest.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: { externalModules: ['pg-native', '@aws-sdk/*'] },
    });
    bus.grantPutEventsTo(ingest);
    const api = new apigw.RestApi(this, 'alerts-api', {
      restApiName: 'gnome-alerts-api',
      description: "Gnome's alert ingest API",
      deployOptions: { stageName: 'api' },
      apiKeySourceType: apigw.ApiKeySourceType.HEADER,
    });
    api.root.addResource('alerts').addMethod('POST', new apigw.LambdaIntegration(ingest), { apiKeyRequired: true });
    const usagePlan = new apigw.UsagePlan(this, 'AlertsUsagePlan', {
      name: 'Alerts Usage Plan',
      throttle: { rateLimit: 50, burstLimit: 100 },
    });
    usagePlan.addApiKey(props.apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    new ssm.StringParameter(this, 'AlertsApiUrl', {
      parameterName: ALERTS_API_URL_PARAMETER,
      stringValue: api.url,
      description: 'Where sessions and services report alerts (POST /alerts, registry API key)',
    });
    new ssm.StringParameter(this, 'AlertBusName', {
      parameterName: ALERT_BUS_NAME_PARAMETER,
      stringValue: bus.eventBusName,
      description: 'The bus services in this account put alerts on (events:PutEvents)',
    });

    this.alertOnAlerting(props, router, store, ingest, dlq);
  }

  // Alerting watching itself can't go through the router: these go to incident.io's CloudWatch alert source (prod)
  // and by email.
  private alertOnAlerting(props: Props, router: lambda.NodejsFunction, store: lambda.NodejsFunction,
    ingest: lambda.NodejsFunction, dlq: sqs.Queue) {
    const topic = new sns.Topic(this, 'AlertingMetaTopic');
    if (props.alerting.incidentIo) {
      topic.addSubscription(new subs.UrlSubscription(
        ssm.StringParameter.valueForStringParameter(this, INCIDENT_IO_CLOUDWATCH_URL_PARAMETER),
        { protocol: sns.SubscriptionProtocol.HTTPS }));
    }
    for (const email of props.alerting.metaEmails) topic.addSubscription(new subs.EmailSubscription(email));
    const action = new cwActions.SnsAction(topic);
    const alarm = (id: string, metric: cloudwatch.Metric, props: Partial<cloudwatch.CreateAlarmOptions>) => {
      const a = metric.createAlarm(this, id, {
        alarmName: `${META_PREFIX}${id}-Critical`,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...props,
      });
      a.addAlarmAction(action);
      a.addOkAction(action);
    };
    const fiveMinutes = { period: cdk.Duration.minutes(5), statistic: 'Sum' };
    alarm('RouterErrors', router.metricErrors(fiveMinutes), {});
    alarm('StoreErrors', store.metricErrors(fiveMinutes), {});
    alarm('IngestErrors', ingest.metricErrors(fiveMinutes), {});
    alarm('Dlq', dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }), {});
    alarm('RouterNotRunning', router.metricInvocations(fiveMinutes), {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    alarm('Undelivered', new cloudwatch.Metric({
      namespace: METRICS_NAMESPACE, metricName: 'OldestUndeliveredSeconds', period: cdk.Duration.minutes(5), statistic: 'Maximum',
    }), { threshold: 600 });
  }
}
