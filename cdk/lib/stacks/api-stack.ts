import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { join } from 'path';
import { Runtime } from 'aws-cdk-lib/aws-lambda';

interface Props extends cdk.StackProps {
  database: rds.DatabaseInstance;
  vpc: ec2.Vpc;
  rootUserSecret: secrets.Secret;
}

export class ApiStack extends cdk.Stack {
  private nodeJsProps: lambda.NodejsFunctionProps;
  private props: Props;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    this.props = props;

    const api = new apigw.RestApi(this, 'registry-api', {
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
        stageName: 'api',
      },
      apiKeySourceType: apigw.ApiKeySourceType.HEADER,
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

    const crudResources = ['securities', 'exchanges', 'listings', 'listing-specs', 'strategies'];
    for (const resourceName of crudResources) {
      const resource = api.root.addResource(resourceName);
      this.attachMethods(resource, `${resourceName}.ts`, ['GET', 'POST', 'DELETE', 'PATCH']);
    }

    // /pnl/snapshots (GET + POST) and /pnl/latest (GET only)
    const pnlResource = api.root.addResource('pnl');
    this.attachMethods(pnlResource.addResource('snapshots'), 'pnl-snapshots.ts', ['GET', 'POST']);
    this.attachMethods(pnlResource.addResource('latest'), 'pnl-latest.ts', ['GET']);

    // /risk/policies (full CRUD)
    const riskResource = api.root.addResource('risk');
    this.attachMethods(riskResource.addResource('policies'), 'risk-policies.ts', ['GET', 'POST', 'DELETE', 'PATCH']);

    const apiKey = new apigw.ApiKey(this, 'ApiKey');
    const usagePlan = new apigw.UsagePlan(this, 'UsagePlan', {
      name: 'Global Usage Plan',
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({
      stage: api.deploymentStage
    });

    new cdk.CfnOutput(this, 'API URL', { value: api.url });
  }

  private attachMethods(resource: apigw.Resource, fileName: string, methods: string[]) {
    const integration = this.createIntegration(fileName);
    for (const method of methods) {
      resource.addMethod(method, integration, { apiKeyRequired: true });
    }
  }

  private createIntegration(fileName: string) {
    const lambdaName = fileName.substring(0, fileName.indexOf('.'));
    const l = new lambda.NodejsFunction(this, `${lambdaName}-lambda`, {
      entry: join(__dirname, '..', '..', 'lambda', 'endpoints', fileName),
      ...this.nodeJsProps,
      vpc: this.props.vpc,
      vpcSubnets: this.props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
    });
    this.props.database.grantConnect(l);

    return new apigw.LambdaIntegration(l);
  }
}
