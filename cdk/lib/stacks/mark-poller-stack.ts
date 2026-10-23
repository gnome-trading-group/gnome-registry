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
  // Exchange codes this deployment prices; empty prices every venue.
  venues?: string[];
}

// Every minute, prices the listings still held once every session on them has stopped (a contract held to settlement)
// from the venues' public market data, and posts the marks to the registry. Outside the VPC, as the venue poller is,
// but apart from it: its reads are slower and fail differently, and a stuck reconciliation shouldn't stall the marks.
// It needs no venue credentials.
export class MarkPollerStack extends cdk.Stack {
  public readonly pollerLambda: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    this.pollerLambda = new lambda.NodejsFunction(this, 'mark-poller-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'mark-poller.ts'),
      runtime: Runtime.NODEJS_20_X,
      // Under the schedule's minute, so runs never overlap.
      timeout: cdk.Duration.seconds(50),
      memorySize: 256,
      environment: {
        REGISTRY_API_URL: `https://${props.api.restApiId}.execute-api.${this.region}.${this.urlSuffix}/${ApiStack.STAGE_NAME}/`,
        REGISTRY_API_KEY_ID: props.apiKey.keyId,
        VENUES: (props.venues ?? []).join(','),
      },
      bundling: {
        externalModules: ['pg-native', '@aws-sdk/*'],
      },
    });

    this.pollerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [props.apiKey.keyArn],
    }));

    const rule = new events.Rule(this, 'MarkPollerRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    });
    rule.addTarget(new targets.LambdaFunction(this.pollerLambda));
  }
}
