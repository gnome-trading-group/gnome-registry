import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { GnomeAccount, Stage } from "@gnome-trading-group/gnome-shared-cdk";

export const GITHUB_REPO = "gnome-trading-group/gnome-registry";
export const GITHUB_BRANCH = "release";

export interface RegistryConfig {
  account: GnomeAccount;
  slackChannel: string;
  dbInstanceType: ec2.InstanceType;
}

const defaultConfig = {
  slackChannel: '',
  dbInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
};

export const CONFIGS: { [stage in Stage]?: RegistryConfig } = {
  [Stage.DEV]: {
    ...defaultConfig,
    account: GnomeAccount.InfraDev,
  },
  [Stage.PROD]: {
    ...defaultConfig,
    account: GnomeAccount.InfraProd,
    slackChannel: 'C0B60PCAPNC', // #gnome-security-master
    dbInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
  },
};
