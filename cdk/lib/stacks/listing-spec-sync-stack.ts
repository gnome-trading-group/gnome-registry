import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';

interface Props extends cdk.StackProps {
  api: apigw.RestApi;
  apiKey: apigw.ApiKey;
}

export class ListingSpecSyncStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const syncLambda = new lambda.NodejsFunction(this, 'listing-spec-sync-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'listing-spec-sync.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        REGISTRY_API_URL: props.api.url,
        REGISTRY_API_KEY_ID: props.apiKey.keyId,
      },
      bundling: {
        externalModules: ['pg-native', '@aws-sdk/*'],
      },
    });

    syncLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [props.apiKey.keyArn],
    }));

    const rule = new events.Rule(this, 'ListingSpecSyncRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    });
    rule.addTarget(new targets.LambdaFunction(syncLambda));
  }
}
