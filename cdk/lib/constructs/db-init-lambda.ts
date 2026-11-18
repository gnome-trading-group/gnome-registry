import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as triggers from 'aws-cdk-lib/triggers';
import { Construct } from 'constructs';
import { join } from 'path';

// The most a Lambda may run: data migrations rewrite whole tables, each file in one transaction.
const MIGRATION_TIMEOUT = cdk.Duration.minutes(15);

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
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
      runtime: Runtime.NODEJS_22_X,
      // Data migrations rewrite whole tables (e.g. re-keying every Kalshi binary event) and run in one transaction.
      timeout: MIGRATION_TIMEOUT,
      memorySize: 512,
      environment: {
        DATABASE_SECRET_JSON: props.rootUserSecret.secretValue.unsafeUnwrap(),
      },
      bundling: {
        commandHooks: {
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [`cp -r ${inputDir}/lambda/db-init/migrations ${outputDir}/migrations`];
          },
          beforeBundling(): string[] { return []; },
          beforeInstall(): string[] { return []; },
        },
      },
    });
    props.database.grantConnect(initLambda);
    initLambda.node.addDependency(props.database);

    // Applies the migrations on deploy. The migrations are bundled into the function, so a new one changes its code
    // and its version, which runs the trigger again; a deploy with no new migration runs nothing. The runner skips
    // what `_migrations` records as applied and throws on a failing file (rolled back), which fails this stack's
    // update, so the stage stops before the API (which deploys after this stack) runs code needing the change.
    new triggers.Trigger(this, 'ApplyMigrations', {
      handler: initLambda,
      executeOnHandlerChange: true,
      invocationType: triggers.InvocationType.REQUEST_RESPONSE,
      timeout: MIGRATION_TIMEOUT,
    });

    const queryLambda = new lambda.NodejsFunction(this, 'DatabaseQueryLambda-Lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'db-query', 'index.ts'),
      vpc: props.vpc,
      vpcSubnets: props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
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
