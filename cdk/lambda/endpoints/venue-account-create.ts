import { APIGatewayProxyEvent } from 'aws-lambda';
import {
  CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, DescribeSecretCommandOutput, PutSecretValueCommand,
  ResourceExistsException, ResourceNotFoundException, SecretsManagerClient, TagResourceCommand,
} from '@aws-sdk/client-secrets-manager';
import { createPrivateKey } from 'crypto';
import { registryFetch, resolveApiKey } from '../sync/registry-client';
import { getActor } from './base';
import { gamertag } from './gamertag';
import { identityChange } from './venue-accounts';
import { createResponse, isPositiveInt } from './ledger-common';

// Registers a venue account from the controller: its credentials go into Secrets Manager under a fresh gamer-tag
// label, and the registry records the account (PROVISIONING) with only the secrets' names. Outside the VPC, since the
// registry's subnets have no route to Secrets Manager; it reaches the registry through its API like the launcher.
//
// Credentials arrive in the request body and leave only for Secrets Manager: never logged, never returned, and a
// failed registration deletes the secrets it made. Each secret holds the fields exactly as the orchestrator reads them
// (gnome-orchestrator gateways/credentials), all as strings.

const PRIMARY_REGION = 'us-east-1';
// Orchestrators trade from every one of these, so each needs its own copy of an account's credentials.
const REPLICA_REGIONS = ['ap-northeast-1', 'eu-west-1'];
const RECOVERY_WINDOW_DAYS = 7;
const LABEL_ATTEMPTS = 20;

const secrets = new SecretsManagerClient({ region: PRIMARY_REGION });

export class CreateError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

type Fields = Record<string, unknown>;

function text(fields: Fields, key: string, what: string): string {
  const value = fields[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new CreateError(400, `${what} needs ${key}`);
  return value.trim();
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_HEX = /^(0x)?[0-9a-fA-F]{64}$/;

// The secret as the orchestrator reads it, and the public identifiers the poller and the controller need, taken
// from the same fields so the wallet reconciliation checks is always the one that trades.
export function credentialsFor(exchangeCode: string, fields: Fields, what: string): {
  secret: Record<string, string>; venueRef: Record<string, unknown>;
} {
  switch (exchangeCode) {
    case 'KALSHI': {
      // Kalshi issues PKCS#1 keys (BEGIN RSA PRIVATE KEY), but the orchestrator reads only PKCS#8, so every key is
      // stored as PKCS#8 whatever form it was uploaded in.
      let privateKey: string;
      try {
        privateKey = createPrivateKey(text(fields, 'privateKey', what))
          .export({ type: 'pkcs8', format: 'pem' }).toString().trim();
      } catch (error) {
        if (error instanceof CreateError) throw error;
        throw new CreateError(400, `${what}: privateKey isn't a readable PEM private key`);
      }
      const secret: Record<string, string> = { apiKey: text(fields, 'apiKey', what), privateKey };
      const subaccount = fields.subaccount;
      if (subaccount !== undefined && subaccount !== null && String(subaccount).trim() !== '') {
        if (!/^\d+$/.test(String(subaccount).trim())) throw new CreateError(400, `${what}: subaccount must be a number`);
        secret.subaccount = String(subaccount).trim();
        return { secret, venueRef: { subaccount: Number(secret.subaccount) } };
      }
      return { secret, venueRef: {} };
    }
    case 'POLYMARKET_INTL': {
      const secret: Record<string, string> = {
        apiKey: text(fields, 'apiKey', what),
        secret: text(fields, 'secret', what),
        passphrase: text(fields, 'passphrase', what),
        ethereumPrivateKey: text(fields, 'ethereumPrivateKey', what),
        signerAddress: text(fields, 'signerAddress', what),
        funderAddress: text(fields, 'funderAddress', what),
        signatureType: String(fields.signatureType ?? '').trim(),
      };
      if (!PRIVATE_KEY_HEX.test(secret.ethereumPrivateKey)) {
        throw new CreateError(400, `${what}: ethereumPrivateKey must be 32 bytes of hex`);
      }
      for (const key of ['signerAddress', 'funderAddress']) {
        if (!ADDRESS.test(secret[key])) throw new CreateError(400, `${what}: ${key} must be a 0x address`);
      }
      if (!/^[0-3]$/.test(secret.signatureType)) throw new CreateError(400, `${what}: signatureType must be 0 to 3`);
      return {
        secret,
        venueRef: {
          signerAddress: secret.signerAddress, funderAddress: secret.funderAddress,
          signatureType: secret.signatureType,
        },
      };
    }
    case 'POLYMARKET_US': {
      const secret = { apiKey: text(fields, 'apiKey', what), secret: text(fields, 'secret', what) };
      if (Buffer.from(secret.secret, 'base64').length < 32) {
        throw new CreateError(400, `${what}: secret must be a base64 Ed25519 key of at least 32 bytes`);
      }
      return { secret, venueRef: {} };
    }
    default:
      throw new CreateError(400, `Accounts can't be created on ${exchangeCode} yet`);
  }
}

// Every venue we trade takes three keys, each revocable without breaking the others: one that trades, one the balance
// poller reads with, and one market data signs in with. A key some venues have no use for is the exception, listed
// here; anything not listed is required.
export type KeyKind = 'read' | 'marketData';
const KEYS_NOT_NEEDED: Record<string, KeyKind[]> = {
  // The poller reads the wallet from the chain, and the market channel is public.
  POLYMARKET_INTL: ['read', 'marketData'],
};
export const VENUES = ['KALSHI', 'POLYMARKET_INTL', 'POLYMARKET_US'];

export function needsKey(exchangeCode: string, kind: KeyKind): boolean {
  return !(KEYS_NOT_NEEDED[exchangeCode] ?? []).includes(kind);
}

// A venue's poller key must be its own: Kalshi's is read-scoped, but Polymarket US keys can all trade, so there it
// only makes the poller's key revocable alone.
export function readSecretFor(exchangeCode: string, fields: Fields | undefined): Record<string, string> | null {
  if (!needsKey(exchangeCode, 'read')) {
    if (fields !== undefined && fields !== null) {
      throw new CreateError(400, `${exchangeCode} accounts are read without credentials`);
    }
    return null;
  }
  if (fields === undefined || fields === null) {
    throw new CreateError(400, `${exchangeCode} accounts need a separate key for the poller`);
  }
  return credentialsFor(exchangeCode, fields, 'readCredentials').secret;
}

const ACCOUNT_DESCRIPTION = 'Venue account credentials, registered from the controller';

async function createSecret(name: string, value: Record<string, string>, description = ACCOUNT_DESCRIPTION) {
  await secrets.send(new CreateSecretCommand({
    Name: name,
    SecretString: JSON.stringify(value),
    AddReplicaRegions: REPLICA_REGIONS.map(Region => ({ Region })),
    Description: description,
  }));
}

// Writes a secret, creating it (in every region) if it is new; true when it was created, so a failure can undo it.
async function writeSecret(name: string, value: Record<string, string>, description?: string): Promise<boolean> {
  try {
    await createSecret(name, value, description);
    return true;
  } catch (error) {
    if (!(error instanceof ResourceExistsException)) throw error;
    await secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: JSON.stringify(value) }));
    return false;
  }
}

// The registry's own refusal (a 4xx) is the operator's to read; anything else stays a server error.
function registryRefusal(error: unknown): CreateError | null {
  const match = error instanceof Error ? / failed: (4\d\d) (.*)$/s.exec(error.message) : null;
  if (!match) return null;
  let message = match[2];
  try {
    message = JSON.parse(match[2]).message ?? message;
  } catch {
    // not JSON: keep the text as it came
  }
  return new CreateError(Number(match[1]), message);
}

async function deleteSecret(name: string, recoveryDays: number | null) {
  await secrets.send(new DeleteSecretCommand(recoveryDays === null
    ? { SecretId: name, ForceDeleteWithoutRecovery: true }
    : { SecretId: name, RecoveryWindowInDays: recoveryDays }));
}

interface CreateRequest {
  exchangeId?: number;
  credentials?: Fields;
  readCredentials?: Fields;
  note?: string;
}

export async function createAccount(body: CreateRequest, actor: string) {
  if (!isPositiveInt(body.exchangeId)) throw new CreateError(400, 'exchangeId must be a positive integer');
  if (body.credentials === null || typeof body.credentials !== 'object') throw new CreateError(400, 'credentials are required');
  const apiKey = await resolveApiKey();
  const exchange = (await registryFetch<{ exchange_id: number; exchange_code: string }[]>(
    `/exchanges?exchangeId=${body.exchangeId}`, 'GET', apiKey))[0];
  if (!exchange) throw new CreateError(400, `Unknown exchange ${body.exchangeId}`);
  const { secret, venueRef } = credentialsFor(exchange.exchange_code, body.credentials, 'credentials');
  const readSecret = readSecretFor(exchange.exchange_code, body.readCredentials);

  for (let attempt = 0; attempt < LABEL_ATTEMPTS; attempt++) {
    const label = gamertag();
    const tradingSecretName = `gnome/accounts/${label}/trading`;
    const readSecretName = readSecret ? `gnome/accounts/${label}/read` : null;
    try {
      await createSecret(tradingSecretName, secret);
    } catch (error) {
      if (error instanceof ResourceExistsException) continue;
      throw error;
    }
    const made = [tradingSecretName];
    try {
      if (readSecretName && readSecret) {
        await createSecret(readSecretName, readSecret);
        made.push(readSecretName);
      }
      const account = await registryFetch<Record<string, unknown>>('/venue-accounts', 'POST', apiKey, {
        exchangeId: exchange.exchange_id, label, venueRef, tradingSecretName, readSecretName, actor,
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined,
      });
      console.log(`Registered ${exchange.exchange_code} account ${label} for ${actor}`);
      return {
        account,
        secrets: made.map(name => ({ name, regions: [PRIMARY_REGION, ...REPLICA_REGIONS] })),
      };
    } catch (error) {
      for (const name of made) await deleteSecret(name, null).catch(() => undefined);
      if (error instanceof Error && error.message.includes(' 409 ')) continue;
      throw error;
    }
  }
  throw new CreateError(503, `No free label after ${LABEL_ATTEMPTS} tries`);
}

interface AccountSecrets {
  account_id: number;
  exchange_id: number;
  exchange_code: string;
  label: string;
  status: string;
  venue_ref: Record<string, unknown>;
  trading_secret_name: string;
  read_secret_name: string | null;
}

interface UpdateRequest {
  accountId?: number;
  credentials?: Fields;
  readCredentials?: Fields;
}

// Gives an existing account new credentials under its own label's secrets, for keys a venue rotated, or for the
// accounts seeded from the old per-exchange secrets, which had no read-only key or wallet address.
export async function updateCredentials(body: UpdateRequest, actor: string) {
  if (!isPositiveInt(body.accountId)) throw new CreateError(400, 'accountId must be a positive integer');
  if (body.credentials === null || typeof body.credentials !== 'object') throw new CreateError(400, 'credentials are required');
  const apiKey = await resolveApiKey();
  let account: AccountSecrets;
  try {
    account = await registryFetch<AccountSecrets>(`/venue-accounts/secrets?accountId=${body.accountId}`, 'GET', apiKey);
  } catch (error) {
    throw registryRefusal(error) ?? error;
  }
  if (account.status === 'RETIRED') throw new CreateError(409, `${account.label} is retired`);
  const { secret, venueRef } = credentialsFor(account.exchange_code, body.credentials, 'credentials');
  const changed = identityChange(account.venue_ref, venueRef);
  if (changed) throw new CreateError(409, changed);
  const readSecret = readSecretFor(account.exchange_code, body.readCredentials);

  const tradingSecretName = `gnome/accounts/${account.label}/trading`;
  const readSecretName = readSecret ? `gnome/accounts/${account.label}/read` : account.read_secret_name;
  const created: string[] = [];
  try {
    if (await writeSecret(tradingSecretName, secret)) created.push(tradingSecretName);
    if (readSecret && readSecretName && await writeSecret(readSecretName, readSecret)) created.push(readSecretName);
    const updated = await registryFetch<Record<string, unknown>>('/venue-accounts/secrets', 'PUT', apiKey, {
      accountId: account.account_id, tradingSecretName, readSecretName, venueRef, actor,
    });
    console.log(`Replaced the credentials of ${account.exchange_code} account ${account.label} for ${actor}`);
    const written = [tradingSecretName, ...(readSecret && readSecretName ? [readSecretName] : [])];
    return {
      account: updated,
      secrets: written.map(name => ({ name, regions: [PRIMARY_REGION, ...REPLICA_REGIONS] })),
    };
  } catch (error) {
    for (const name of created) await deleteSecret(name, null).catch(() => undefined);
    throw registryRefusal(error) ?? error;
  }
}

// A retired account's credentials are no longer needed; deleted after Secrets Manager's recovery window.
export async function deleteAccountSecrets(accountId: unknown) {
  if (!isPositiveInt(accountId)) throw new CreateError(400, 'accountId must be a positive integer');
  const apiKey = await resolveApiKey();
  const account = await registryFetch<{ label: string; status: string; trading_secret_name: string; read_secret_name: string | null }>(
    `/venue-accounts/secrets?accountId=${accountId}`, 'GET', apiKey);
  if (account.status !== 'RETIRED') throw new CreateError(409, `${account.label} is ${account.status}; retire it first`);
  const names = [account.trading_secret_name, account.read_secret_name].filter((n): n is string => !!n);
  for (const name of names) await deleteSecret(name, RECOVERY_WINDOW_DAYS);
  console.log(`Scheduled the secrets of retired account ${account.label} for deletion`);
  return { label: account.label, deleted: names, recoveryWindowDays: RECOVERY_WINDOW_DAYS };
}

// Market data signs in with one key per exchange, shared by every session and collector, so it belongs to no venue
// account. Secrets Manager is its only store: tags say who set it and which key it is, and the secret's versions and
// CloudTrail keep its history.
export const MARKET_DATA_EXCHANGES: Record<string, string> = Object.fromEntries(
  VENUES.filter(code => needsKey(code, 'marketData'))
    .map(code => [code, `gnome/market-data/${code.toLowerCase().replace(/_/g, '-')}`]),
);
const UPDATED_BY_TAG = 'updated-by';
const API_KEY_ID_TAG = 'api-key-id';

export interface MarketDataKeyStatus {
  exchangeCode: string;
  secretName: string;
  exists: boolean;
  apiKeyId: string | null;
  updatedBy: string | null;
  lastChangedAt: string | null;
  replicas: { region: string; status: string; message: string | null }[];
  // Every trading region holds the current value: the primary exists and each replica reports InSync.
  inSync: boolean;
}

export function marketDataKeyStatus(
  exchangeCode: string, described: DescribeSecretCommandOutput | null,
): MarketDataKeyStatus {
  const secretName = MARKET_DATA_EXCHANGES[exchangeCode];
  if (!described) {
    return {
      exchangeCode, secretName, exists: false, apiKeyId: null, updatedBy: null, lastChangedAt: null, replicas: [],
      inSync: false,
    };
  }
  const tag = (key: string) => described.Tags?.find(t => t.Key === key)?.Value ?? null;
  const replicas = REPLICA_REGIONS.map(region => {
    const r = described.ReplicationStatus?.find(x => x.Region === region);
    return { region, status: r?.Status ?? 'Missing', message: r?.StatusMessage ?? null };
  });
  return {
    exchangeCode, secretName, exists: true, apiKeyId: tag(API_KEY_ID_TAG), updatedBy: tag(UPDATED_BY_TAG),
    lastChangedAt: described.LastChangedDate ? new Date(described.LastChangedDate).toISOString() : null,
    replicas, inSync: replicas.every(r => r.status === 'InSync'),
  };
}

async function describeMarketDataKey(exchangeCode: string): Promise<MarketDataKeyStatus> {
  try {
    const described = await secrets.send(new DescribeSecretCommand({ SecretId: MARKET_DATA_EXCHANGES[exchangeCode] }));
    // A secret scheduled for deletion still describes, but nothing can read it.
    return marketDataKeyStatus(exchangeCode, described.DeletedDate ? null : described);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return marketDataKeyStatus(exchangeCode, null);
    throw error;
  }
}

export async function listMarketDataKeys(): Promise<MarketDataKeyStatus[]> {
  return Promise.all(Object.keys(MARKET_DATA_EXCHANGES).map(describeMarketDataKey));
}

export async function setMarketDataKey(body: { exchangeCode?: string; credentials?: Fields }, actor: string) {
  const exchangeCode = body.exchangeCode ?? '';
  if (!(exchangeCode in MARKET_DATA_EXCHANGES)) {
    throw new CreateError(400, `exchangeCode must be one of ${Object.keys(MARKET_DATA_EXCHANGES).join(', ')}`);
  }
  if (body.credentials === null || typeof body.credentials !== 'object') throw new CreateError(400, 'credentials are required');
  const { secret } = credentialsFor(exchangeCode, body.credentials, 'credentials');
  const name = MARKET_DATA_EXCHANGES[exchangeCode];
  await writeSecret(name, secret, `Market data credentials for ${exchangeCode}, set from the controller`);
  await secrets.send(new TagResourceCommand({
    SecretId: name,
    Tags: [{ Key: UPDATED_BY_TAG, Value: actor }, { Key: API_KEY_ID_TAG, Value: secret.apiKey }],
  }));
  console.log(`Set the ${exchangeCode} market data key for ${actor}`);
  return describeMarketDataKey(exchangeCode);
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const resource = event.resource ?? '';
  try {
    const body = JSON.parse(event.body ?? '{}');
    if (resource === '/venue-accounts/create' && event.httpMethod === 'POST') {
      return createResponse(200, await createAccount(body, getActor(event)));
    }
    if (resource === '/venue-accounts/credentials' && event.httpMethod === 'POST') {
      return createResponse(200, await updateCredentials(body, getActor(event)));
    }
    if (resource === '/market-data-keys' && event.httpMethod === 'GET') {
      return createResponse(200, await listMarketDataKeys());
    }
    if (resource === '/market-data-keys' && event.httpMethod === 'POST') {
      return createResponse(200, await setMarketDataKey(body, getActor(event)));
    }
    if (resource === '/venue-accounts/delete-secrets' && event.httpMethod === 'POST') {
      return createResponse(200, await deleteAccountSecrets(body.accountId));
    }
    return createResponse(400, { message: `Unsupported ${event.httpMethod} ${event.resource}` });
  } catch (error) {
    if (error instanceof CreateError) return createResponse(error.statusCode, { message: error.message });
    if (error instanceof SyntaxError) return createResponse(400, { message: 'Body is not valid JSON' });
    // Only the error's name and message: the request carried credentials, so nothing from it is logged.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    console.error('Account creation failed:', message);
    return createResponse(500, { message });
  }
};
