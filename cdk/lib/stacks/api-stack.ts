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
import {
  API_KEY_SECRET_NAMES, ApiKeySecret, CallerKind, GnomeApiAuthorizer, RouteMethods, Stage,
} from '@gnome-trading-group/gnome-shared-cdk';
import { CONTROLLER_READ_PATHS } from '../../lambda/endpoints/controller-read-paths';
import { ALERT_BUS_NAME } from '../../lambda/alerts/model';

const SERVICE = CallerKind.SERVICE;
const PERSON = CallerKind.PERSON;
const BOT = CallerKind.BOT;

interface Props extends cdk.StackProps {
  database: rds.DatabaseInstance;
  vpc: ec2.Vpc;
  rootUserSecret: secrets.Secret;
  stage: Stage;
}

export class ApiStack extends cdk.Stack {
  public static readonly STAGE_NAME = 'api';
  public readonly api: apigw.RestApi;
  public readonly apiKey: apigw.ApiKey;
  public static readonly USER_POOL_ARN_PARAMETER = '/gnome/cognito/user-pool-arn';
  private nodeJsProps: lambda.NodejsFunctionProps;
  private props: Props;
  private auth: GnomeApiAuthorizer;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    this.props = props;

    this.api = new apigw.RestApi(this, 'registry-api', {
      description: "Gnome's Registry API",
      cloudWatchRole: true,
      deployOptions: {
        stageName: ApiStack.STAGE_NAME,
      },
      // People (the controller UI) and services call the same routes, so every route takes a browser's preflight.
      // Preflights are mock methods with no authorizer: the authorizer is set per method, never as a default.
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: [
          ...apigw.Cors.DEFAULT_HEADERS,
          'Authorization',
          'Content-Type',
          'X-Amz-Date',
          'X-Amz-Security-Token'
        ],
      },
    });

    // Without these, a request the authorizer rejects (401/403) comes back with no CORS headers and the
    // browser reports an opaque CORS failure instead of the auth error.
    this.api.addGatewayResponse('Default4xxCors', {
      type: apigw.ResponseType.DEFAULT_4XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
    });
    this.api.addGatewayResponse('Default5xxCors', {
      type: apigw.ResponseType.DEFAULT_5XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
    });

    // Created before the routes so the authorizer can check it and its keyId can reach the launcher Lambda's env var
    // and IAM policy.
    this.apiKey = new apigw.ApiKey(this, 'ApiKey');
    new ApiKeySecret(this, 'ApiKeySecret', { apiKey: this.apiKey, secretName: API_KEY_SECRET_NAMES.REGISTRY });

    // The pool is owned by another stack and published through SSM. Services call with the API key, people with a
    // Cognito ID token and bots with a gnome-api-scoped access token; each route below names which of them it serves.
    const userPool = cognito.UserPool.fromUserPoolArn(this, 'OperatorUserPool',
      ssm.StringParameter.valueForStringParameter(this, ApiStack.USER_POOL_ARN_PARAMETER));
    this.auth = new GnomeApiAuthorizer(this, 'Authorizer', { userPool, apiKeys: [this.apiKey] });

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
        STAGE: props.stage,
      },
    };

    // Services may do anything to the security master; people get the listed methods and bots read.
    const ALL = ['GET', 'POST', 'DELETE', 'PATCH'];
    const crudResources: [string, string[]][] = [
      ['securities', ALL],
      ['exchanges', ALL],
      ['listings', ALL],
      ['listing-specs', ALL],
      ['strategies', ALL],
      ['currencies', ['GET']],
      ['events', ['GET']],
      ['event-contracts', ['GET']],
      ['contract-relationships', ['GET', 'POST', 'DELETE']],
      ['hedge-keywords', ['GET', 'POST', 'DELETE']],
    ];
    for (const [resourceName, personMethods] of crudResources) {
      const methods: RouteMethods = {};
      for (const method of ALL) {
        methods[method] = [SERVICE, ...(personMethods.includes(method) ? [PERSON] : []), ...(method === 'GET' ? [BOT] : [])];
      }
      this.routeFile(resourceName, `${resourceName}.ts`, methods);
    }

    // Market-data sources and streams. Services read them; vendor sources are added and edited by a person (venue
    // sources and listing streams are created by the database with their exchange and listing).
    this.routeFile('sources', 'sources.ts', { GET: [SERVICE, PERSON, BOT], POST: [PERSON], PATCH: [PERSON] });
    this.routeFile('streams', 'streams.ts', { GET: [SERVICE, PERSON, BOT] });

    // Fee schedules are append-only, so there is no DELETE or PATCH: a fix is a new row.
    this.routeFile('fees', 'fees.ts', { GET: [SERVICE, PERSON, BOT], POST: [SERVICE, PERSON] });
    this.routeFile('simulation-parameters', 'simulation-parameters.ts', { GET: [SERVICE, PERSON, BOT], POST: [SERVICE, PERSON] });

    // The controller's PnL, ledger and monitoring reads (PnL is derived from the ledger's fills and marks; nothing
    // about it is stored). One Lambda serves them all, for people and bots.
    const controllerReads = this.createIntegration('controller-reads.ts');
    for (const path of CONTROLLER_READ_PATHS) {
      this.route(path, controllerReads, { GET: [PERSON, BOT] });
    }

    // Alerts for the controller: what's open and what fired before, and closing one (people only). Alerts arrive
    // through the alerting stack's own ingest API.
    this.routeFile('alerts', 'alerts.ts', { GET: [PERSON, BOT], PATCH: [PERSON] });

    // The trading ledger. Running sessions write it; an operator's position adjustments are people only, so each one is
    // attributed to a person.
    this.routeFile('ledger/batch', 'ledger-batch.ts', { POST: [SERVICE] });
    this.routeFile('ledger/positions', 'ledger-positions.ts', { GET: [SERVICE, PERSON, BOT] });
    this.routeFile('ledger/orders', 'ledger-orders.ts', { GET: [SERVICE, PERSON, BOT] });
    this.routeFile('ledger/adjustments', 'ledger-adjustments.ts', { POST: [PERSON] });

    // Policy writes are people only so the audit log attributes every change to a person.
    this.routeFile('risk/policies', 'risk-policies.ts',
      { GET: [SERVICE, PERSON, BOT], POST: [PERSON], DELETE: [PERSON], PATCH: [PERSON] });
    this.routeFile('risk/policies/history', 'risk-policy-history.ts', { GET: [SERVICE, PERSON, BOT] });
    // Services only: the OMS halts its own strategy automatically, and the handler can only ever enable a kill.
    this.routeFile('risk/halts', 'risk-halts.ts', { POST: [SERVICE] });

    // Venue accounts: the account-creation Lambda registers one (the credentials go to Secrets Manager, not here), a
    // starting orchestrator reads the accounts its session was bound to, and moving an account through its lifecycle
    // is a person's. Secret names are for the account-creation Lambda alone.
    const venueAccounts = this.createIntegration('venue-accounts.ts');
    this.route('venue-accounts', venueAccounts, { POST: [SERVICE], GET: [PERSON, BOT] });
    this.route('venue-accounts/status', venueAccounts, { PATCH: [PERSON] });
    this.route('strategy-sessions/accounts', venueAccounts, { GET: [SERVICE, PERSON, BOT] });
    this.route('venue-accounts/secrets', venueAccounts, { GET: [SERVICE], PUT: [SERVICE] });

    // Creating an account from the controller puts its credentials in Secrets Manager, which the registry's isolated
    // subnets can't reach, so this one runs outside the VPC and registers the account through the API. People only,
    // so each account is attributed to the person who created it. It also sets the per-exchange market-data keys, and
    // may only touch gnome/accounts/* and gnome/market-data/* secrets.
    const accountCreator = new lambda.NodejsFunction(this, 'venue-account-create-lambda', {
      entry: join(__dirname, '..', '..', 'lambda', 'endpoints', 'venue-account-create.ts'),
      ...this.nodeJsProps,
      bundling: {
        externalModules: ['pg-native', '@aws-sdk/*'],
      },
      environment: {
        REGISTRY_API_URL: `https://${this.api.restApiId}.execute-api.${this.region}.${this.urlSuffix}/${ApiStack.STAGE_NAME}/`,
        REGISTRY_API_KEY_ID: this.apiKey.keyId,
      },
    });
    accountCreator.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:ReplicateSecretToRegions',
        'secretsmanager:TagResource',
      ],
      resources: [
        `arn:aws:secretsmanager:*:${this.account}:secret:gnome/accounts/*`,
        `arn:aws:secretsmanager:*:${this.account}:secret:gnome/market-data/*`,
      ],
    }));
    accountCreator.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [`arn:aws:apigateway:${this.region}::/apikeys/${this.apiKey.keyId}`],
    }));
    const accountCreation = new apigw.LambdaIntegration(accountCreator, { scopePermissionToMethod: false });
    this.route('venue-accounts/create', accountCreation, { POST: [PERSON] });
    this.route('venue-accounts/credentials', accountCreation, { POST: [PERSON] });
    this.route('venue-accounts/delete-secrets', accountCreation, { POST: [PERSON] });
    // Not even bots read which market-data keys are set.
    this.route('market-data-keys', accountCreation, { GET: [PERSON], POST: [PERSON] });

    // The treasury: the venue poller posts what each account holds and reads which accounts to poll (services); an
    // operator reads where the money stands and records transfers, settings and manual readings (people). The mark
    // poller's one route shares its Lambda, rather than adding one to a stack at its resource cap.
    const treasury = this.createIntegration('treasury-api.ts');
    this.route('ledger/poller-marks', treasury, { POST: [SERVICE] });
    this.route('treasury/snapshots', treasury, { POST: [SERVICE, PERSON] });
    this.route('treasury/poll-targets', treasury, { GET: [SERVICE] });
    this.route('treasury/summary', treasury, { GET: [PERSON, BOT] });
    this.route('treasury/transfers', treasury, { GET: [PERSON, BOT], POST: [PERSON] });
    this.route('treasury/account-config', treasury, { PUT: [PERSON] });
    this.route('treasury/recon', treasury, { GET: [PERSON, BOT] });

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
        STAGE: this.props.stage,
      },
    });
    strategySessionsLauncherLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:RunInstances',
        'ec2:TerminateInstances',
        'ec2:DescribeInstances',
        'ec2:DescribeImages',
        'ec2:CreateTags',
      ],
      resources: ['*'],
    }));
    strategySessionsLauncherLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: ['arn:aws:iam::*:role/gnome-orchestrator-*'],
      conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
    }));
    strategySessionsLauncherLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        'arn:aws:ssm:*:*:parameter/gnome/orchestrator/ami/*',
        'arn:aws:ssm:*:*:parameter/gnome/orchestrator/latest-version',
        'arn:aws:ssm:*:*:parameter/gnome/orchestrator/properties/*',
        'arn:aws:ssm:*:*:parameter/gnome/alerting/api-url',
      ],
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
    // A stop whose kill switch fails raises an alert. The bus is named, not referenced, so this stack doesn't depend on
    // the alerting stack (which depends on this one's API key).
    strategySessionsLauncherLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:aws:events:${this.region}:${this.account}:event-bus/${ALERT_BUS_NAME}`],
    }));

    const sessionsDbIntegration = new apigw.LambdaIntegration(strategySessionsDbLambda, { scopePermissionToMethod: false });
    const sessionsLauncherIntegration = new apigw.LambdaIntegration(
      strategySessionsLauncherLambda, { scopePermissionToMethod: false });

    this.route('strategy-sessions', sessionsDbIntegration, { GET: [SERVICE, PERSON, BOT], PATCH: [SERVICE], POST: [SERVICE] });
    this.route('strategy-sessions/launch', sessionsLauncherIntegration, { POST: [SERVICE, PERSON] });
    // People stop attributed from their token; services (the launcher's automated shutdowns) name themselves in the
    // body, so the kill-switch audit entry still says who stopped it.
    this.route('strategy-sessions/stop', sessionsLauncherIntegration, { POST: [SERVICE, PERSON] });
    this.route('strategy-sessions/logs', sessionsLauncherIntegration, { GET: [SERVICE, PERSON, BOT] });
    // A running session's liveness and health, every few seconds, from the session itself.
    this.routeFile('strategy-sessions/heartbeat', 'strategy-session-heartbeat.ts', { POST: [SERVICE] });
    // For the controller's override picker; the launcher Lambda already reads the orchestrator's SSM parameters.
    this.route('orchestrator/properties', sessionsLauncherIntegration, { GET: [PERSON, BOT] });

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

  private routeFile(path: string, fileName: string, methods: RouteMethods) {
    this.route(path, this.createIntegration(fileName), methods);
  }

  private route(path: string, integration: apigw.Integration, methods: RouteMethods) {
    this.auth.addRoute(this.api.root, path, integration, methods);
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

    // CloudFormation caps a stack at 500 resources, and a permission scoped to each method would add one per method
    // (two with the console's "Test" button). One permission per function lets this API invoke it from any of its
    // methods, which are the only ones wired to it anyway.
    return new apigw.LambdaIntegration(l, { scopePermissionToMethod: false });
  }
}
