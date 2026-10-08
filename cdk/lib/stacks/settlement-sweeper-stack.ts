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

export class SettlementSweeperStack extends cdk.Stack {
  public readonly sweeperLambda: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    this.sweeperLambda = new lambda.NodejsFunction(this, 'settlement-sweeper-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'settlement-sweeper.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      // No reserved concurrency: sweeps run 5 minutes apart and finish within the timeout, and an overlap would still
      // book nothing twice (each booking locks its position, and SETTLEMENT rows are unique per position).
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

    props.database.grantConnect(this.sweeperLambda);

    // A position becomes bookable when its market settles or, later, when the session holding it stops; polling
    // catches both, and a failed booking is simply retried on the next run.
    const rule = new events.Rule(this, 'SettlementSweeperRule', {
      description: 'Settlement sweeper: books settled positions into the ledger',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    rule.addTarget(new targets.LambdaFunction(this.sweeperLambda));
  }
}
