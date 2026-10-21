import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { GnomeAccount, Stage } from "@gnome-trading-group/gnome-shared-cdk";

export const GITHUB_REPO = "gnome-trading-group/gnome-registry";
export const GITHUB_BRANCH = "release";

export interface RegistryConfig {
  account: GnomeAccount;
  slackChannel: string;
  dbInstanceType: ec2.InstanceType;
  // Where the venue poller reads each venue's accounts.
  // Where alerts go: every alert to the Slack channel; CRITICAL ones also page through incident.io where enabled.
  // metaEmails hear when alerting itself is broken.
  alerting: {
    slackChannel: string;
    controllerUrl: string;
    incidentIo: boolean;
    metaEmails: string[];
    // The account's monthly AWS budget: nearing it, passing it or being forecast to pass it raises an alert.
    monthlyBudgetUsd: number;
  };
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
    alerting: {
      slackChannel: 'C08KX2GAUE4', // #gnome-alerts-dev
      controllerUrl: 'https://controller-dev.gnometrading.group',
      incidentIo: false,
      metaEmails: [],
      monthlyBudgetUsd: 300,
    },
    venuePoller: { ...defaultConfig.venuePoller, kalshiApiUrl: 'https://external-api.demo.kalshi.co' },
  },
  [Stage.PROD]: {
    ...defaultConfig,
    account: GnomeAccount.InfraProd,
    alerting: {
      slackChannel: 'C08KD27QZKN', // #gnome-alerts-prod
      controllerUrl: 'https://controller.gnometrading.group',
      incidentIo: true,
      metaEmails: ["alerts@gnometrading.group"],
      monthlyBudgetUsd: 300,
    },
    slackChannel: 'C0B60PCAPNC', // #gnome-security-master
    dbInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
  },
};
