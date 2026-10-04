import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { join } from 'path';
import { Runtime } from 'aws-cdk-lib/aws-lambda';

interface Props extends cdk.StackProps {
  database: rds.DatabaseInstance;
  vpc: ec2.Vpc;
  rootUserSecret: secrets.Secret;
}

export class ApiStack extends cdk.Stack {
  public static readonly STAGE_NAME = 'api';
  public readonly api: apigw.RestApi;
  public readonly apiKey: apigw.ApiKey;
  public static readonly USER_POOL_ARN_PARAMETER = '/gnome/cognito/user-pool-arn';
  private nodeJsProps: lambda.NodejsFunctionProps;
  private props: Props;
  private cognitoAuthorizer: apigw.CognitoUserPoolsAuthorizer;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    this.props = props;

    this.api = new apigw.RestApi(this, 'registry-api', {
      description: "Gnome's Registry API",
      cloudWatchRole: true,
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: [
          ...apigw.Cors.DEFAULT_HEADERS,
          'Authorization',
          'Content-Type',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token'
        ],
      },
      deployOptions: {
        stageName: ApiStack.STAGE_NAME,
      },
      apiKeySourceType: apigw.ApiKeySourceType.HEADER,
    });

    // Without these, a request the Cognito authorizer rejects (401/403) comes back with no CORS headers and the
    // browser reports an opaque CORS failure instead of the auth error.
    this.api.addGatewayResponse('Default4xxCors', {
      type: apigw.ResponseType.DEFAULT_4XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
    });
    this.api.addGatewayResponse('Default5xxCors', {
      type: apigw.ResponseType.DEFAULT_5XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
    });

    // Operator actions that change what may trade are attributed to a person, so they take a Cognito ID token
    // instead of the shared API key. The pool is owned by another stack and published through SSM.
    const userPool = cognito.UserPool.fromUserPoolArn(this, 'OperatorUserPool',
      ssm.StringParameter.valueForStringParameter(this, ApiStack.USER_POOL_ARN_PARAMETER));
    this.cognitoAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'OperatorAuthorizer', {
      cognitoUserPools: [userPool],
    });

    this.nodeJsProps = {
      bundling: {
        // pg-native is not available and won't be used. This is letting the
        // bundler (esbuild) know pg-native won't be included in the bundled JS
        // file.
        externalModules: ['pg-native']
      },
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        DATABASE_SECRET_JSON: props.rootUserSecret.secretValue.unsafeUnwrap(),
      },
    };

    // Create API key early so its keyId can be referenced by the launcher Lambda's env var and IAM policy.
    // UsagePlan.addApiStage must remain at the end (after all methods are registered) to avoid circular deps.
    this.apiKey = new apigw.ApiKey(this, 'ApiKey');

    const crudResources = ['securities', 'exchanges', 'listings', 'listing-specs', 'strategies', 'currencies', 'events', 'event-contracts', 'contract-relationships', 'hedge-keywords'];
    for (const resourceName of crudResources) {
      this.attachMethods(this.api.root.addResource(resourceName), `${resourceName}.ts`, ['GET', 'POST', 'DELETE', 'PATCH']);
    }

    // /pnl/snapshots (GET + POST) and /pnl/latest (GET only)
    const pnlResource = this.api.root.addResource('pnl');
    this.attachMethods(pnlResource.addResource('snapshots'), 'pnl-snapshots.ts', ['GET', 'POST']);
    this.attachMethods(pnlResource.addResource('latest'), 'pnl-latest.ts', ['GET']);

    // /risk/policies (GET with API key, writes with Cognito), /risk/policies/history (GET), /risk/halts (POST)
    const riskResource = this.api.root.addResource('risk');
    const riskPoliciesResource = riskResource.addResource('policies');
    this.attachMethods(riskPoliciesResource, 'risk-policies.ts', ['GET'], ['POST', 'DELETE', 'PATCH']);
    this.attachMethods(riskPoliciesResource.addResource('history'), 'risk-policy-history.ts', ['GET']);
    // API key only: the OMS halts its own strategy automatically, and the handler can only ever enable a kill.
    this.attachMethods(riskResource.addResource('halts'), 'risk-halts.ts', ['POST']);

    // /strategy-sessions — split into two Lambdas:
    // - In-VPC Lambda: GET/PATCH/POST (DB-only operations)
    // - Outside-VPC launcher Lambda: POST /launch + POST /stop (ECS/EC2 orchestration, calls Registry API for DB)
    const strategySessionsDbLambda = new lambda.NodejsFunction(this, 'strategy-sessions-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'endpoints', 'strategy-sessions.ts'),
      ...this.nodeJsProps,
      vpc: this.props.vpc,
      vpcSubnets: this.props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }),
    });
    this.props.database.grantConnect(strategySessionsDbLambda);

    const strategySessionsLauncherLambda = new lambda.NodejsFunction(this, 'strategy-session-launcher-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'endpoints', 'strategy-session-launcher.ts'),
      ...this.nodeJsProps,
      bundling: {
        externalModules: ['pg-native', '@aws-sdk/*'],
      },
      environment: {
        REGISTRY_API_URL: `https://${this.api.restApiId}.execute-api.${this.region}.${this.urlSuffix}/${ApiStack.STAGE_NAME}/`,
        REGISTRY_API_KEY_ID: this.apiKey.keyId,
      },
    });
    strategySessionsLauncherLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'ecs:StopTask'],
      resources: ['*'],
    }));
    strategySessionsLauncherLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: ['arn:aws:iam::*:role/gnome-orchestrator-*'],
    }));
    strategySessionsLauncherLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups'],
      resources: ['*'],
    }));
    strategySessionsLauncherLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [`arn:aws:apigateway:${this.region}::/apikeys/${this.apiKey.keyId}`],
    }));
    strategySessionsLauncherLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['logs:GetLogEvents'],
      resources: ['arn:aws:logs:*:*:log-group:/gnome/orchestrator/*'],
    }));

    const strategySessionsResource = this.api.root.addResource('strategy-sessions');
    const sessionsDbIntegration = new apigw.LambdaIntegration(strategySessionsDbLambda);
    const sessionsLauncherIntegration = new apigw.LambdaIntegration(strategySessionsLauncherLambda);

    strategySessionsResource.addMethod('GET', sessionsDbIntegration, { apiKeyRequired: true });
    strategySessionsResource.addMethod('PATCH', sessionsDbIntegration, { apiKeyRequired: true });
    strategySessionsResource.addMethod('POST', sessionsDbIntegration, { apiKeyRequired: true });

    const launchResource = strategySessionsResource.addResource('launch');
    launchResource.addMethod('POST', sessionsLauncherIntegration, { apiKeyRequired: true });

    const stopResource = strategySessionsResource.addResource('stop');
    stopResource.addMethod('POST', sessionsLauncherIntegration, this.cognitoMethodOptions());

    const logsResource = strategySessionsResource.addResource('logs');
    logsResource.addMethod('GET', sessionsLauncherIntegration, { apiKeyRequired: true });

    const usagePlan = new apigw.UsagePlan(this, 'UsagePlan', {
      name: 'Global Usage Plan',
    });
    usagePlan.addApiKey(this.apiKey);
    usagePlan.addApiStage({
      stage: this.api.deploymentStage
    });

    new cdk.CfnOutput(this, 'API URL', {
      value: this.api.url,
      exportName: 'RegistryApiUrl',
    });
    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: this.apiKey.keyId,
      exportName: 'RegistryApiKeyId',
    });
    new cdk.CfnOutput(this, 'ApiKeyArn', {
      value: this.apiKey.keyArn,
      exportName: 'RegistryApiKeyArn',
    });
  }

  private attachMethods(resource: apigw.Resource, fileName: string, methods: string[], cognitoMethods: string[] = []) {
    const integration = this.createIntegration(fileName);
    for (const method of methods) {
      resource.addMethod(method, integration, { apiKeyRequired: true });
    }
    for (const method of cognitoMethods) {
      resource.addMethod(method, integration, this.cognitoMethodOptions());
    }
  }

  private cognitoMethodOptions(): apigw.MethodOptions {
    return {
      apiKeyRequired: false,
      authorizer: this.cognitoAuthorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };
  }

  private createIntegration(fileName: string) {
    const lambdaName = fileName.substring(0, fileName.indexOf('.'));
    const l = new lambda.NodejsFunction(this, `${lambdaName}-lambda`, {
      entry: join(__dirname, '..', '..', 'lambda', 'endpoints', fileName),
      ...this.nodeJsProps,
      vpc: this.props.vpc,
      vpcSubnets: this.props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });
    this.props.database.grantConnect(l);

    return new apigw.LambdaIntegration(l);
  }
}
