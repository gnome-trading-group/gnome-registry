import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { MonitoringFacade, SnsAlarmActionStrategy } from 'cdk-monitoring-constructs';

interface Props extends cdk.StackProps {
  api: apigw.RestApi;
  syncLambda: lambda.IFunction;
  database: rds.DatabaseInstance;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const slackSnsTopic = sns.Topic.fromTopicArn(
      this, 'SlackSnsTopic', cdk.Fn.importValue('SlackSnsTopicArn')
    );

    const monitoring = new MonitoringFacade(this, 'RegistryDashboard', {
      alarmFactoryDefaults: {
        actionsEnabled: true,
        alarmNamePrefix: 'Registry-',
        action: new SnsAlarmActionStrategy({ onAlarmTopic: slackSnsTopic }),
        datapointsToAlarm: 1,
      },
    });

    monitoring
      .addLargeHeader('Gnome Registry')
      .monitorApiGateway({
        api: props.api,
        humanReadableName: 'Registry API',
        alarmFriendlyName: 'RegistryApi',
      })
      .monitorLambdaFunction({
        lambdaFunction: props.syncLambda,
        humanReadableName: 'Listing Spec Sync',
        alarmFriendlyName: 'ListingSpecSync',
        addFaultCountAlarm: {
          Critical: { maxErrorCount: 0 },
        },
      })
      .monitorRdsInstance({
        instance: props.database,
        humanReadableName: 'Registry Database',
        alarmFriendlyName: 'RegistryDatabase',
      });
  }
}
