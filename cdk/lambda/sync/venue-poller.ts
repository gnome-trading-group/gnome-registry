import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { registryFetch, resolveApiKey } from './registry-client';
import { readKalshi } from './venues/kalshi';
import { readPolymarketIntl } from './venues/polymarket-intl';
import { readPolymarketUs } from './venues/polymarket-us';
import { PollTarget, VenueReading } from './venues/types';

// Reads what every venue account holds and posts it to the registry, which reconciles it against the ledger. Runs
// on a schedule outside the VPC (the venues are on the internet), one deployment per region that can reach its
// venues; VENUES limits a deployment to some exchange codes. It only ever reads an account's read-only secret,
// never the trading one. A venue that can't be read is posted as an ERROR snapshot, which the controller flags.

const secrets = new SecretsManagerClient({});

async function readSecret(name: string | null): Promise<Record<string, string>> {
  if (!name) throw new Error('This account has no read-only secret');
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
  return JSON.parse(res.SecretString ?? '{}');
}

async function read(target: PollTarget): Promise<VenueReading> {
  switch (target.exchange_code) {
    case 'KALSHI': {
      const c = await readSecret(target.read_secret_name);
      return readKalshi(target, { apiKey: c.apiKey, privateKey: c.privateKey });
    }
    case 'POLYMARKET_INTL':
      return readPolymarketIntl(target);
    case 'POLYMARKET_US': {
      const c = await readSecret(target.read_secret_name);
      return readPolymarketUs(target, { apiKey: c.apiKey, secret: c.secret });
    }
    default:
      throw new Error(`No poller for ${target.exchange_code}`);
  }
}

function snapshotBody(target: PollTarget, reading: VenueReading) {
  return {
    accountId: target.account_id,
    status: 'OK',
    cashTotal: reading.cashTotal.toString(),
    cashAvailable: reading.cashAvailable.toString(),
    portfolioValue: reading.portfolioValue?.toString() ?? null,
    redeemableValue: reading.redeemableValue.toString(),
    cashByPartition: reading.cashByPartition === undefined ? null
      : Object.fromEntries(Object.entries(reading.cashByPartition).map(([k, v]) => [k, v.toString()])),
    positions: reading.positions?.map(p => ({
      venueKey: p.venueKey, quantity: p.quantity.toString(), redeemable: p.redeemable, value: p.value?.toString() ?? null,
    })) ?? null,
    raw: reading.raw,
  };
}

export const handler = async () => {
  const apiKey = await resolveApiKey();
  const venues = (process.env.VENUES ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const targets = (await registryFetch<PollTarget[]>('/treasury/poll-targets', 'GET', apiKey))
    .filter(t => venues.length === 0 || venues.includes(t.exchange_code));
  const results: Record<string, string> = {};
  for (const target of targets) {
    let body: Record<string, unknown>;
    try {
      body = snapshotBody(target, await read(target));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Reading ${target.exchange_code} account ${target.label} failed: ${message}`);
      body = { accountId: target.account_id, status: 'ERROR', error: message.slice(0, 1000) };
    }
    const recon = await registryFetch<{ cashStatus: string; positionBreaks: number }>(
      '/treasury/snapshots', 'POST', apiKey, body);
    results[target.label] = `${recon.cashStatus}, ${recon.positionBreaks} position break(s)`;
  }
  console.log('Venue poll:', JSON.stringify(results));
  return results;
};
