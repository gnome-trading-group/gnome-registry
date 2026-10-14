import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { MonitoringFacade, noopAction } from 'cdk-monitoring-constructs';

interface Props extends cdk.StackProps {
  api: apigw.RestApi;
  syncLambda: lambda.IFunction;
  settlementSweeperLambda: lambda.IFunction;
  venuePollerLambda: lambda.IFunction;
  sessionMonitorLambda: lambda.IFunction;
  database: rds.DatabaseInstance;
}

// The alarms carry no action: every alarm's state change reaches the alert router through EventBridge, which reads
// the severity from the tier the alarm is declared under (Critical, Error or Warning, the end of its name). Nothing
// here is Critical: the database or API going down shows up as the alert store failing (AlertingMeta) and as sessions
// going silent, which page on their own.
const GIB = 1024 ** 3;

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const monitoring = new MonitoringFacade(this, 'RegistryDashboard', {
      alarmFactoryDefaults: {
        actionsEnabled: true,
        alarmNamePrefix: 'Registry-',
        action: noopAction(),
        datapointsToAlarm: 1,
      },
    });

    monitoring
      .addLargeHeader('Gnome Registry')
      .monitorApiGateway({
        api: props.api,
        humanReadableName: 'Registry API',
        alarmFriendlyName: 'RegistryApi',
        add5XXFaultCountAlarm: {
          Error: { maxErrorCount: 10 },
        },
      })
      .monitorLambdaFunction({
        lambdaFunction: props.syncLambda,
        humanReadableName: 'Exchange Sync',
        alarmFriendlyName: 'ExchangeSync',
        addFaultCountAlarm: {
          Error: { maxErrorCount: 0 },
        },
      })
      .monitorLambdaFunction({
        lambdaFunction: props.settlementSweeperLambda,
        humanReadableName: 'Settlement Sweeper',
        alarmFriendlyName: 'SettlementSweeper',
        addFaultCountAlarm: {
          Error: { maxErrorCount: 0 },
        },
      })
      .monitorLambdaFunction({
        lambdaFunction: props.venuePollerLambda,
        humanReadableName: 'Venue Poller',
        alarmFriendlyName: 'VenuePoller',
        addFaultCountAlarm: {
          Error: { maxErrorCount: 0 },
        },
      })
      .monitorLambdaFunction({
        lambdaFunction: props.sessionMonitorLambda,
        humanReadableName: 'Strategy Session Monitor',
        alarmFriendlyName: 'StrategySessionMonitor',
        addFaultCountAlarm: {
          Error: { maxErrorCount: 0 },
        },
      })
      .monitorRdsInstance({
        instance: props.database,
        humanReadableName: 'Registry Database',
        alarmFriendlyName: 'RegistryDatabase',
        addFreeStorageSpaceAlarm: {
          Warning: { minCount: 5 * GIB },
        },
        addCpuUsageAlarm: {
          Warning: { maxUsagePercent: 80 },
        },
      });
  }
}
