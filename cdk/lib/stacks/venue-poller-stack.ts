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
import { RegistryConfig } from '../config';

interface Props extends cdk.StackProps {
  api: apigw.RestApi;
  apiKey: apigw.ApiKey;
  venuePoller: RegistryConfig['venuePoller'];
  // Exchange codes this deployment polls; empty polls every venue.
  venues?: string[];
}

// Polls every venue account's balances and positions every five minutes and posts them to the registry, which
// reconciles them against the ledger. Outside the VPC: the venues are on the internet, and the registry is reached
// through its API like any other service.
export class VenuePollerStack extends cdk.Stack {
  public readonly pollerLambda: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    this.pollerLambda = new lambda.NodejsFunction(this, 'venue-poller-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'venue-poller.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        REGISTRY_API_URL: `https://${props.api.restApiId}.execute-api.${this.region}.${this.urlSuffix}/${ApiStack.STAGE_NAME}/`,
        REGISTRY_API_KEY_ID: props.apiKey.keyId,
        KALSHI_API_URL: props.venuePoller.kalshiApiUrl,
        POLYGON_RPC_URL: props.venuePoller.polygonRpcUrl,
        PUSD_TOKEN_ADDRESS: props.venuePoller.pusdTokenAddress,
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
    // Only the read-only secrets: a trading secret can move funds (a Polymarket one holds the wallet's key).
    this.pollerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:gnome/accounts/*/read-*`],
    }));

    const rule = new events.Rule(this, 'VenuePollerRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    rule.addTarget(new targets.LambdaFunction(this.pollerLambda));
  }
}
