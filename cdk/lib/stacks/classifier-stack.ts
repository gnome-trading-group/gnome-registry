import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { join } from 'path';

interface Props extends cdk.StackProps {
  api: apigw.RestApi;
  apiKey: apigw.ApiKey;
}

export class ClassifierStack extends cdk.Stack {
  public readonly classifierLambda: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const anthropicApiKeySecret = secrets.Secret.fromSecretNameV2(
      this, 'AnthropicApiKey', 'anthropic-api-key'
    );
    const voyageApiKeySecret = secrets.Secret.fromSecretNameV2(
      this, 'VoyageApiKey', 'voyage-api-key'
    );

    this.classifierLambda = new lambda.DockerImageFunction(this, 'classifier-lambda', {
      code: lambda.DockerImageCode.fromImageAsset(
        join(__dirname, '..', '..', 'lambda', 'classifier')
      ),
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      environment: {
        REGISTRY_API_URL: props.api.url,
        REGISTRY_API_KEY_ID: props.apiKey.keyId,
        ANTHROPIC_API_KEY_SECRET: 'anthropic-api-key',
        VOYAGE_API_KEY_SECRET: 'voyage-api-key',
      },
    });

    this.classifierLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [props.apiKey.keyArn],
    }));

    anthropicApiKeySecret.grantRead(this.classifierLambda);
    voyageApiKeySecret.grantRead(this.classifierLambda);

    const rule = new events.Rule(this, 'ClassifierRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    });
    rule.addTarget(new targets.LambdaFunction(this.classifierLambda));
  }
}
