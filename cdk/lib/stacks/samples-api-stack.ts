import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { CallerKind, GnomeApiAuthorizer } from '@gnome-trading-group/gnome-shared-cdk';
import { join } from 'path';
import { ApiStack } from './api-stack';

// Where gateways, shards, the controller and gnomepy find the samples API.
export const SAMPLES_API_URL_PARAMETER = '/gnome/samples/api-url';

interface Props extends cdk.StackProps {
  database: rds.DatabaseInstance;
  vpc: ec2.Vpc;
  rootUserSecret: secrets.Secret;
  apiKey: apigw.ApiKey;
}

// Samples (ops.sample): the API gateways and shards post theirs to and every read goes through, and the hourly upkeep
// of the table's daily partitions. Its own API, as alerting's ingest is, so telemetry's request volume and the
// registry API's resource limit and deploys never meet. Sessions' samples still arrive with their heartbeat on the
// registry API. Callers use the registry's API key (services), a Cognito ID token (people) or a bot token (reads).
export class SamplesApiStack extends cdk.Stack {
  public static readonly STAGE_NAME = 'api';
  public readonly samplesLambda: lambda.NodejsFunction;
  public readonly partitionsLambda: lambda.NodejsFunction;
  public readonly api: apigw.RestApi;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const securityGroup = new ec2.SecurityGroup(this, 'SamplesSecurityGroup', {
      vpc: props.vpc,
      description: 'Samples API and partition Lambdas',
      allowAllOutbound: true,
    });
    const inVpc = {
      runtime: Runtime.NODEJS_20_X,
      memorySize: 512,
      environment: { DATABASE_SECRET_JSON: props.rootUserSecret.secretValue.unsafeUnwrap() },
      bundling: { externalModules: ['pg-native'] },
      vpc: props.vpc,
      vpcSubnets: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }),
      securityGroups: [securityGroup],
    };

    this.samplesLambda = new lambda.NodejsFunction(this, 'samples-lambda', {
      ...inVpc,
      entry: join(__dirname, '..', '..', 'lambda', 'endpoints', 'samples.ts'),
      timeout: cdk.Duration.seconds(30),
    });
    props.database.grantConnect(this.samplesLambda);

    this.api = new apigw.RestApi(this, 'samples-api', {
      restApiName: 'gnome-samples-api',
      description: "Gnome's samples API: processes' readings over time",
      deployOptions: { stageName: SamplesApiStack.STAGE_NAME },
      // The controller reads from a browser; preflights carry no authorizer.
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: [...apigw.Cors.DEFAULT_HEADERS, 'Authorization', 'Content-Type'],
      },
    });
    this.api.addGatewayResponse('Default4xxCors', {
      type: apigw.ResponseType.DEFAULT_4XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
    });
    this.api.addGatewayResponse('Default5xxCors', {
      type: apigw.ResponseType.DEFAULT_5XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
    });

    const userPool = cognito.UserPool.fromUserPoolArn(this, 'OperatorUserPool',
      ssm.StringParameter.valueForStringParameter(this, ApiStack.USER_POOL_ARN_PARAMETER));
    const auth = new GnomeApiAuthorizer(this, 'Authorizer', { userPool, apiKeys: [props.apiKey] });
    auth.addRoute(this.api.root, 'samples',
      new apigw.LambdaIntegration(this.samplesLambda, { scopePermissionToMethod: false }), {
        GET: [CallerKind.SERVICE, CallerKind.PERSON, CallerKind.BOT],
        POST: [CallerKind.SERVICE],
      });

    new ssm.StringParameter(this, 'SamplesApiUrl', {
      parameterName: SAMPLES_API_URL_PARAMETER,
      stringValue: this.api.url,
      description: 'Where gateways and shards post samples and anyone reads them (GET/POST /samples)',
    });

    this.partitionsLambda = new lambda.NodejsFunction(this, 'sample-partitions-lambda', {
      ...inVpc,
      memorySize: 256,
      entry: join(__dirname, '..', '..', 'lambda', 'sync', 'sample-partitions.ts'),
      timeout: cdk.Duration.seconds(60),
    });
    props.database.grantConnect(this.partitionsLambda);
    new events.Rule(this, 'SamplePartitionsRule', {
      description: 'Sample partitions: creates the days ahead and drops expired days of ops.sample',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(this.partitionsLambda)],
    });
  }
}
