import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { GnomeAccount, Stage } from "@gnome-trading-group/gnome-shared-cdk";

export const GITHUB_REPO = "gnome-trading-group/gnome-registry";
export const GITHUB_BRANCH = "release";

export interface RegistryConfig {
  account: GnomeAccount;
  slackChannel: string;
  dbInstanceType: ec2.InstanceType;
  // Where the venue poller reads each venue's accounts.
  venuePoller: {
    kalshiApiUrl: string;
    polygonRpcUrl: string;
    // Polymarket's collateral token on Polygon (CLOB V2).
    pusdTokenAddress: string;
  };
}

const defaultConfig = {
  slackChannel: '',
  dbInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
  venuePoller: {
    kalshiApiUrl: 'https://external-api.kalshi.com',
    // polygon-rpc.com stopped serving anonymous requests; publicnode answers without a key.
    polygonRpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    pusdTokenAddress: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  },
};

export const CONFIGS: { [stage in Stage]?: RegistryConfig } = {
  [Stage.DEV]: {
    ...defaultConfig,
    account: GnomeAccount.InfraDev,
    venuePoller: { ...defaultConfig.venuePoller, kalshiApiUrl: 'https://external-api.demo.kalshi.co' },
  },
  [Stage.PROD]: {
    ...defaultConfig,
    account: GnomeAccount.InfraProd,
    slackChannel: 'C0B60PCAPNC', // #gnome-security-master
    dbInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
  },
};
