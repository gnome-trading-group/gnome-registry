// Registers a venue account: puts its credentials in Secrets Manager under a fresh gamer-tag label and records the
// account in the registry as PROVISIONING. The credentials are read from local files and go straight to Secrets
// Manager with your own AWS profile; the registry only ever learns the secrets' names.
//
//   npx ts-node scripts/register-account.ts --stage dev --profile dev --exchange POLYMARKET_INTL \
//     --credentials ~/pm-wallet.json [--read-credentials ~/pm-wallet-read.json] [--label sleepy-otter-42] [--note ...]
//
// The credentials file holds the secret exactly as the orchestrator reads it: for Polymarket Intl apiKey, secret,
// passphrase, ethereumPrivateKey, signerAddress, funderAddress and signatureType; for Kalshi apiKey and privateKey;
// for Polymarket US apiKey and secret. The registry key comes from GNOME_REGISTRY_API_KEY, or REGISTRY_API_KEY_ID
// looked up with your profile.
//
//   --retire-secrets --label <label>   deletes a RETIRED account's secrets (after a 7-day recovery window)
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import {
  CreateSecretCommand, DeleteSecretCommand, ResourceExistsException, SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { gamertag, isLabel } from '../lambda/endpoints/gamertag';

const HOSTS: Record<string, string> = {
  dev: 'i3116oczxe.execute-api.us-east-1.amazonaws.com',
  prod: 'n5dxpwnij0.execute-api.us-east-1.amazonaws.com',
};
const PRIMARY_REGION = 'us-east-1';
// Orchestrators trade from every one of these, so each needs its own copy of the secret.
const REPLICA_REGIONS = ['ap-northeast-1', 'eu-west-1'];
const RECOVERY_WINDOW_DAYS = 7;
const LABEL_ATTEMPTS = 20;

function args(): Record<string, string | true> {
  const parsed: Record<string, string | true> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function required(options: Record<string, string | true>, key: string): string {
  const value = options[key];
  if (typeof value !== 'string') throw new Error(`--${key} is required`);
  return value;
}

function readJson(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path.replace(/^~(?=\/)/, process.env.HOME ?? '~'), 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

// The public identifiers the poller and the controller need, taken from the very file the orchestrator will sign
// with, so the wallet recon checks can never differ from the one that trades.
function venueRef(exchangeCode: string, credentials: Record<string, unknown>): Record<string, unknown> {
  if (exchangeCode === 'POLYMARKET_INTL') {
    for (const key of ['signerAddress', 'funderAddress', 'signatureType']) {
      if (typeof credentials[key] !== 'string' || (credentials[key] as string).length === 0) {
        throw new Error(`Polymarket Intl credentials need ${key}`);
      }
    }
    return {
      signerAddress: credentials.signerAddress, funderAddress: credentials.funderAddress,
      signatureType: credentials.signatureType,
    };
  }
  if (exchangeCode === 'KALSHI' && credentials.subaccount !== undefined) return { subaccount: credentials.subaccount };
  return {};
}

async function registryKey(): Promise<string> {
  if (process.env.GNOME_REGISTRY_API_KEY) return process.env.GNOME_REGISTRY_API_KEY;
  const keyId = process.env.REGISTRY_API_KEY_ID;
  if (!keyId) throw new Error('Set GNOME_REGISTRY_API_KEY or REGISTRY_API_KEY_ID');
  const key = await new APIGatewayClient({ region: PRIMARY_REGION }).send(
    new GetApiKeyCommand({ apiKey: keyId, includeValue: true }));
  if (!key.value) throw new Error(`API key ${keyId} has no value`);
  return key.value;
}

async function registry(stage: string, path: string, method: string, body?: unknown): Promise<any> {
  const host = HOSTS[stage];
  if (!host) throw new Error(`--stage must be one of ${Object.keys(HOSTS).join(', ')}`);
  const response = await fetch(`https://${host}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': await registryKey() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

async function createSecret(secrets: SecretsManagerClient, name: string, value: Record<string, unknown>) {
  await secrets.send(new CreateSecretCommand({
    Name: name,
    SecretString: JSON.stringify(value),
    AddReplicaRegions: REPLICA_REGIONS.map(Region => ({ Region })),
    Description: 'Venue account credentials, registered with register-account.ts',
  }));
}

// A label is taken if either the registry or Secrets Manager already has it, so a fresh one is drawn until both
// are free; creating the secret first claims the name.
async function claimLabel(secrets: SecretsManagerClient, requested: string | undefined,
  credentials: Record<string, unknown>): Promise<string> {
  for (let attempt = 0; attempt < LABEL_ATTEMPTS; attempt++) {
    const label = requested ?? gamertag();
    if (!isLabel(label)) throw new Error(`${label} is not a gamer tag like sleepy-otter-42`);
    try {
      await createSecret(secrets, `gnome/accounts/${label}/trading`, credentials);
      return label;
    } catch (error) {
      if (!(error instanceof ResourceExistsException) || requested) throw error;
    }
  }
  throw new Error(`No free label after ${LABEL_ATTEMPTS} tries`);
}

async function retireSecrets(label: string) {
  if (!isLabel(label)) throw new Error('--label must be a gamer tag');
  const secrets = new SecretsManagerClient({ region: PRIMARY_REGION });
  for (const kind of ['trading', 'read']) {
    try {
      await secrets.send(new DeleteSecretCommand({
        SecretId: `gnome/accounts/${label}/${kind}`, RecoveryWindowInDays: RECOVERY_WINDOW_DAYS,
      }));
      console.log(`Scheduled gnome/accounts/${label}/${kind} for deletion in ${RECOVERY_WINDOW_DAYS} days`);
    } catch (error) {
      console.log(`Skipped gnome/accounts/${label}/${kind}: ${(error as Error).message}`);
    }
  }
}

async function main() {
  const options = args();
  if (typeof options.profile === 'string') process.env.AWS_PROFILE = options.profile;
  if (options['retire-secrets'] === true) {
    await retireSecrets(required(options, 'label'));
    return;
  }
  const stage = required(options, 'stage');
  const exchangeCode = required(options, 'exchange');
  const credentials = readJson(required(options, 'credentials'));
  const readCredentials = typeof options['read-credentials'] === 'string' ? readJson(options['read-credentials']) : null;
  const ref = venueRef(exchangeCode, credentials);

  const exchanges = await registry(stage, '/exchanges', 'GET') as { exchange_id: number; exchange_code: string }[];
  const exchange = exchanges.find(e => e.exchange_code === exchangeCode);
  if (!exchange) throw new Error(`No exchange ${exchangeCode}`);

  const secrets = new SecretsManagerClient({ region: PRIMARY_REGION });
  const label = await claimLabel(secrets, typeof options.label === 'string' ? options.label : undefined, credentials);
  const tradingSecretName = `gnome/accounts/${label}/trading`;
  let readSecretName: string | null = null;
  if (readCredentials) {
    readSecretName = `gnome/accounts/${label}/read`;
    await createSecret(secrets, readSecretName, readCredentials);
  }
  const actor = execSync('git config user.email', { encoding: 'utf8' }).trim() || process.env.USER || 'unknown';

  const account = await registry(stage, '/venue-accounts', 'POST', {
    exchangeId: exchange.exchange_id, label, venueRef: ref, tradingSecretName, readSecretName, actor,
    note: typeof options.note === 'string' ? options.note : undefined,
  });
  console.log(`Registered ${exchangeCode} account ${label} (id ${account.account_id}) as PROVISIONING.`);
  console.log('Next: fund it, wait for a green balance snapshot, record the OPENING transfer, then activate it.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
