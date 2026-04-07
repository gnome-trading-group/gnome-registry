#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RegistryPipelineStack } from '../lib/pipeline-stack';
import { GnomeAccount } from '@gnome-trading-group/gnome-shared-cdk';

const app = new cdk.App();
new RegistryPipelineStack(app, 'RegistryPipelineStack', {
  env: GnomeAccount.InfraPipelines.environment,
});
app.synth();
