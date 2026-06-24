import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';

interface Props extends cdk.StackProps {
  api: apigw.RestApi;
  apiKey: apigw.ApiKey;
  slackChannel: string;
}

export class ExchangeSyncStack extends cdk.Stack {
  public readonly syncLambda: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const slackBotTokenSecret = secrets.Secret.fromSecretNameV2(this, 'SlackBotToken', 'slack-bot-token');

    this.syncLambda = new lambda.NodejsFunction(this, 'exchange-sync-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'exchange-sync.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        REGISTRY_API_URL: props.api.url,
        REGISTRY_API_KEY_ID: props.apiKey.keyId,
        SLACK_BOT_TOKEN_SECRET: 'slack-bot-token',
        SLACK_CHANNEL: props.slackChannel,
      },
      bundling: {
        externalModules: ['pg-native', '@aws-sdk/*'],
      },
    });

    this.syncLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [props.apiKey.keyArn],
    }));

    slackBotTokenSecret.grantRead(this.syncLambda);

    const rule = new events.Rule(this, 'ExchangeSyncRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    });
    rule.addTarget(new targets.LambdaFunction(this.syncLambda));
  }
}
