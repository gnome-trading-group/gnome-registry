import { GnomeAccount, Stage } from "@gnome-trading-group/gnome-shared-cdk";

export const GITHUB_REPO = "gnome-trading-group/gnome-registry";
export const GITHUB_BRANCH = "release";

export interface RegistryConfig {
  account: GnomeAccount;
  slackChannel: string;
}

const defaultConfig = {
  slackChannel: '',
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
  },
};
