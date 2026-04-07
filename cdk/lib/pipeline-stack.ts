import * as cdk from "aws-cdk-lib";
import * as pipelines from "aws-cdk-lib/pipelines";
import * as config from "./config";
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from "constructs";
import { DatabaseStack } from "./stacks/database-stack";
import { ApiStack } from "./stacks/api-stack";
import { GnomeAccount } from "@gnome-trading-group/gnome-shared-cdk";

class AppStage extends cdk.Stage {

  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);

    const databaseStack = new DatabaseStack(this, "DatabaseStack", {
      ...props,
    });

    const apiStack = new ApiStack(this, "ApiStack", {
      ...props,
      database: databaseStack.database,
      vpc: databaseStack.vpc,
      rootUserSecret: databaseStack.rootUserSecret,
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
        input: pipelines.CodePipelineSource.gitHub(config.GITHUB_REPO, config.GITHUB_BRANCH),
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

    const dev = new AppStage(this, "Dev", {
      env: GnomeAccount.InfraDev.environment,
    })
    // const staging = new AppStage(this, "Staging", {
    //   env: GnomeAccount.InfraStaging.environment,
    // });
    const prod = new AppStage(this, "Prod", {
      env: GnomeAccount.InfraProd.environment,
    });

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
