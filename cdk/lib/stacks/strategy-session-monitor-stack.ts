import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';

interface Props extends cdk.StackProps {
  database: rds.DatabaseInstance;
  vpc: ec2.Vpc;
  rootUserSecret: secrets.Secret;
}

export class StrategySessionMonitorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const monitorLambda = new lambda.NodejsFunction(this, 'strategy-session-monitor-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'strategy-session-monitor.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DATABASE_SECRET_JSON: props.rootUserSecret.secretValue.unsafeUnwrap(),
      },
      bundling: {
        externalModules: ['pg-native'],
      },
      vpc: props.vpc,
      vpcSubnets: props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });

    props.database.grantConnect(monitorLambda);

    // Matches every instance in the account (Batch and classifier fleets too); those find no session and
    // are no-ops. Other regions forward their events to this bus from gnome-orchestrator's Ec2Stack.
    const rule = new events.Rule(this, 'Ec2InstanceStateChangeRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: ['running', 'shutting-down', 'terminated'],
        },
      },
    });
    rule.addTarget(new targets.LambdaFunction(monitorLambda));
  }
}
