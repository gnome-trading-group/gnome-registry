import * as cdk from "aws-cdk-lib";
import * as pipelines from "aws-cdk-lib/pipelines";
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from "constructs";
import { Stage } from "@gnome-trading-group/gnome-shared-cdk";
import { DatabaseStack } from "./stacks/database-stack";
import { ApiStack } from "./stacks/api-stack";
import { ExchangeSyncStack } from "./stacks/exchange-sync-stack";
import { ClassifierStack } from "./stacks/classifier-stack";
import { MonitoringStack } from "./stacks/monitoring-stack";
import { GITHUB_REPO, GITHUB_BRANCH, CONFIGS, RegistryConfig } from "./config";

class AppStage extends cdk.Stage {

  constructor(scope: Construct, id: string, config: RegistryConfig) {
    super(scope, id, { env: config.account.environment });

    const databaseStack = new DatabaseStack(this, "DatabaseStack");

    const apiStack = new ApiStack(this, "ApiStack", {
      database: databaseStack.database,
      vpc: databaseStack.vpc,
      rootUserSecret: databaseStack.rootUserSecret,
    });

    const classifierStack = new ClassifierStack(this, "ClassifierStack", {
      api: apiStack.api,
      apiKey: apiStack.apiKey,
    });

    const exchangeSyncStack = new ExchangeSyncStack(this, "ExchangeSyncStack", {
      api: apiStack.api,
      apiKey: apiStack.apiKey,
      slackChannel: config.slackChannel,
    });

    new MonitoringStack(this, "MonitoringStack", {
      api: apiStack.api,
      syncLambda: exchangeSyncStack.syncLambda,
      classifierLambda: classifierStack.classifierLambda,
      database: databaseStack.database,
    });
  }
}

export class RegistryPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const npmSecret = secrets.Secret.fromSecretNameV2(this, 'NPMToken', 'npm-token');

    const pipeline = new pipelines.CodePipeline(this, "RegistryPipeline", {
      crossAccountKeys: true,
      pipelineName: "RegistryPipeline",
      synth: new pipelines.ShellStep("deploy", {
        input: pipelines.CodePipelineSource.gitHub(GITHUB_REPO, GITHUB_BRANCH),
        commands: [
          'echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" > ~/.npmrc',
          "cd cdk/",
          "npm ci",
          "npx cdk synth"
        ],
        env: {
          NPM_TOKEN: npmSecret.secretValue.unsafeUnwrap()
        },
        primaryOutputDirectory: 'cdk/cdk.out',
      }),
    });

    const dev = new AppStage(this, "Dev", CONFIGS[Stage.DEV]!);
    // const staging = new AppStage(this, "Staging", CONFIGS[Stage.STAGING]!);
    const prod = new AppStage(this, "Prod", CONFIGS[Stage.PROD]!);

    pipeline.addStage(dev);
    // pipeline.addStage(staging, {
    //   pre: [new pipelines.ManualApprovalStep('ApproveStaging')],
    // });
    pipeline.addStage(prod, {
      pre: [new pipelines.ManualApprovalStep('ApproveProd')],
    });

    pipeline.buildPipeline();
    npmSecret.grantRead(pipeline.synthProject.role!!);
    npmSecret.grantRead(pipeline.pipeline.role);
  }
}
