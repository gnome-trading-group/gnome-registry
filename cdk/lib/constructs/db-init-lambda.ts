import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { join } from 'path';

export interface DatabaseInitLambdaProps {
  database: rds.DatabaseInstance;
  vpc: ec2.Vpc;
  rootUserSecret: secrets.Secret;
}

export class DatabaseInitLambda extends Construct {
  constructor(scope: Construct, id: string, props: DatabaseInitLambdaProps) {
    super(scope, id);

    const initLambda = new lambda.NodejsFunction(this, 'DatabaseInitLambda-Lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'db-init', 'index.ts'),
      vpc: props.vpc,
      vpcSubnets: props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      runtime: Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        DATABASE_SECRET_JSON: props.rootUserSecret.secretValue.unsafeUnwrap(),
      },
    });
    props.database.grantConnect(initLambda);
    initLambda.node.addDependency(props.database);

    const queryLambda = new lambda.NodejsFunction(this, 'DatabaseQueryLambda-Lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'db-query', 'index.ts'),
      vpc: props.vpc,
      vpcSubnets: props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      runtime: Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        DATABASE_SECRET_JSON: props.rootUserSecret.secretValue.unsafeUnwrap(),
      },
    });
    props.database.grantConnect(queryLambda);
    queryLambda.node.addDependency(props.database);
  }
}
