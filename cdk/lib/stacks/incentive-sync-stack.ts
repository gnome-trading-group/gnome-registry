import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { join } from 'path';
import { ApiStack } from './api-stack';

interface Props extends cdk.StackProps {
  api: apigw.RestApi;
  apiKey: apigw.ApiKey;
  // Exchange codes this deployment syncs; empty syncs every venue with a reader.
  venues?: string[];
}

// Every 15 minutes, reads the venues' incentive programs (liquidity rewards) from their public APIs and posts them to
// the registry, which keeps the new and changed ones. Outside the VPC, like the other venue readers: the database's
// subnets have no route to the internet. It needs no venue credentials.
export class IncentiveSyncStack extends cdk.Stack {
  public readonly syncLambda: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    this.syncLambda = new lambda.NodejsFunction(this, 'incentive-sync-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'incentive-sync.ts'),
      runtime: Runtime.NODEJS_20_X,
      // A daily Kalshi payout sweep reads about 140 pages; well under the schedule, so runs never overlap.
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      environment: {
        REGISTRY_API_URL: `https://${props.api.restApiId}.execute-api.${this.region}.${this.urlSuffix}/${ApiStack.STAGE_NAME}/`,
        REGISTRY_API_KEY_ID: props.apiKey.keyId,
        VENUES: (props.venues ?? []).join(','),
      },
      bundling: {
        externalModules: ['pg-native', '@aws-sdk/*'],
      },
    });

    this.syncLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [props.apiKey.keyArn],
    }));

    const rule = new events.Rule(this, 'IncentiveSyncRule', {
      description: 'Incentive sync: records venue incentive programs in the registry',
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    });
    rule.addTarget(new targets.LambdaFunction(this.syncLambda));
  }
}
