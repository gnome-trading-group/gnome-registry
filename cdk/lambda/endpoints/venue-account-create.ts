import { APIGatewayProxyEvent } from 'aws-lambda';
import {
  CreateSecretCommand, DeleteSecretCommand, ResourceExistsException, SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { createPrivateKey } from 'crypto';
import { registryFetch, resolveApiKey } from '../sync/registry-client';
import { getActor } from './base';
import { gamertag } from './gamertag';
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
      const privateKey = text(fields, 'privateKey', what);
      try {
        createPrivateKey(privateKey);
      } catch {
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

// What a read-only secret must hold for the poller; Polymarket Intl reads the chain and needs none.
function readSecretFor(exchangeCode: string, fields: Fields | undefined): Record<string, string> | null {
  if (fields === undefined || fields === null) return null;
  if (exchangeCode === 'POLYMARKET_INTL') throw new CreateError(400, 'Polymarket Intl accounts are read without credentials');
  return credentialsFor(exchangeCode, fields, 'readCredentials').secret;
}

async function createSecret(name: string, value: Record<string, string>) {
  await secrets.send(new CreateSecretCommand({
    Name: name,
    SecretString: JSON.stringify(value),
    AddReplicaRegions: REPLICA_REGIONS.map(Region => ({ Region })),
    Description: 'Venue account credentials, registered from the controller',
  }));
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

export const handler = async (event: APIGatewayProxyEvent) => {
  const resource = (event.resource ?? '').replace(/^\/cognito\//, '/');
  try {
    const body = JSON.parse(event.body ?? '{}');
    if (resource === '/venue-accounts/create' && event.httpMethod === 'POST') {
      return createResponse(200, await createAccount(body, getActor(event)));
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
