import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { registryFetch, resolveApiKey } from './registry-client';
import { readKalshi, readKalshiCredits } from './venues/kalshi';
import { readPolymarketIntl, readPolymarketIntlBreakdowns, readPolymarketIntlCredits } from './venues/polymarket-intl';
import { readPolymarketUs, readPolymarketUsBreakdowns, readPolymarketUsCredits } from './venues/polymarket-us';
import {
  BreakdownMarket, BROKEN_DOWN_BY_VENUE, CreditBreakdown, PendingCredit, PollTarget, VenueCredit, VenueReading,
} from './venues/types';

// Reads what every venue account holds and posts it to the registry, which reconciles it against the ledger. Runs
// on a schedule outside the VPC (the venues are on the internet), one deployment per region that can reach its
// venues; VENUES limits a deployment to some exchange codes. It only ever uses an account's read secret, never the
// trading one; on Kalshi that key also carries `write::transfer`, so the poller keeps the account's shard rebalancing
// targets set as the registry wants them. A venue that can't be read is posted as an ERROR snapshot, which the controller flags.
// With the balances go the venue's credits since the registry last booked one (rewards, rebates, interest, deposits,
// withdrawals), which the registry books as transfers before reconciling; they're read after the balances, so the
// cash any of them added is never missing from the snapshot they go with. Credits that can't be read are left out
// and the balances still posted. Rewards the venue breaks down by market get that breakdown read too, for those just
// read and those the registry still holds pending, so it can give each market's share to the strategies that earned it.

const secrets = new SecretsManagerClient({});

async function readSecret(name: string | null): Promise<Record<string, string>> {
  if (!name) throw new Error('This account has no read-only secret');
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
  return JSON.parse(res.SecretString ?? '{}');
}

interface Reader {
  balances(): Promise<VenueReading>;
  credits(since: Date): Promise<VenueCredit[]>;
  breakdowns(pending: PendingCredit[]): Promise<CreditBreakdown[]>;
}

const none = async () => [];

async function reader(target: PollTarget): Promise<Reader> {
  switch (target.exchange_code) {
    case 'KALSHI': {
      const c = await readSecret(target.read_secret_name);
      const credentials = { apiKey: c.apiKey, privateKey: c.privateKey };
      return {
        balances: () => readKalshi(target, credentials), credits: since => readKalshiCredits(target, credentials, since),
        breakdowns: none,
      };
    }
    case 'POLYMARKET_INTL': {
      // The wallet's CLOB API key, where one is registered, only reads its liquidity rewards by market.
      const c = target.read_secret_name ? await readSecret(target.read_secret_name) : null;
      const clob = c ? { apiKey: c.apiKey, secret: c.secret, passphrase: c.passphrase } : null;
      return {
        balances: () => readPolymarketIntl(target), credits: since => readPolymarketIntlCredits(target, since),
        breakdowns: pending => readPolymarketIntlBreakdowns(target, clob, pending),
      };
    }
    case 'POLYMARKET_US': {
      const c = await readSecret(target.read_secret_name);
      const credentials = { apiKey: c.apiKey, secret: c.secret };
      return {
        balances: () => readPolymarketUs(target, credentials), credits: since => readPolymarketUsCredits(credentials, since),
        breakdowns: pending => readPolymarketUsBreakdowns(credentials, pending),
      };
    }
    default:
      throw new Error(`No poller for ${target.exchange_code}`);
  }
}

export function creditBody(c: VenueCredit) {
  return {
    externalRef: c.externalRef, kind: c.kind, program: c.program, amount: c.amount.toString(),
    occurredAt: c.occurredAt.toISOString(), venueMarket: c.venueMarket, venueType: c.venueType,
    reverses: c.reverses ?? null, raw: c.raw,
  };
}

function marketBody(m: BreakdownMarket) {
  return {
    venueMarket: m.venueMarket, amount: m.amount.toString(), from: m.from.toISOString(), to: m.to.toISOString(),
    periodStart: m.periodStart?.toISOString() ?? null, periodEnd: m.periodEnd?.toISOString() ?? null,
  };
}

export function breakdownBody(b: CreditBreakdown) {
  return {
    externalRef: b.externalRef,
    markets: b.markets.map(marketBody),
    alternatives: (b.alternatives ?? []).map(markets => markets.map(marketBody)),
    inArrears: b.inArrears === true,
  };
}

// What the registry still waits on, and what was just read that it will: rewards whose program the venue breaks down.
export function wantedBreakdowns(target: PollTarget, credits: VenueCredit[]): PendingCredit[] {
  const programs = BROKEN_DOWN_BY_VENUE[target.exchange_code] ?? [];
  const wanted = new Map(target.pending_credits.map(p => [p.external_ref, p]));
  for (const c of credits) {
    if (c.kind !== 'REWARD' || c.program === null || !programs.includes(c.program) || wanted.has(c.externalRef)) continue;
    wanted.set(c.externalRef, {
      external_ref: c.externalRef, program: c.program, occurred_at: c.occurredAt.toISOString(), amount: c.amount.toString(),
    });
  }
  return [...wanted.values()].filter(p => programs.includes(p.program));
}

interface CreditsRead {
  credits?: ReturnType<typeof creditBody>[];
  breakdowns?: ReturnType<typeof breakdownBody>[];
  errors: string[];
}

async function readCredits(target: PollTarget, venue: Reader): Promise<CreditsRead> {
  const read: CreditsRead = { errors: [] };
  const failed = (what: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Reading ${target.exchange_code} account ${target.label} ${what} failed: ${message}`);
    read.errors.push(`${what}: ${message}`.slice(0, 1000));
  };
  let credits: VenueCredit[] = [];
  if (target.credits_since !== null) {
    try {
      credits = await venue.credits(new Date(target.credits_since));
      read.credits = credits.map(creditBody);
    } catch (error) {
      failed('credits', error);
    }
  }
  const wanted = wantedBreakdowns(target, credits);
  if (wanted.length > 0) {
    try {
      read.breakdowns = (await venue.breakdowns(wanted)).map(breakdownBody);
    } catch (error) {
      failed('reward breakdowns', error);
    }
  }
  return read;
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
    rebalanceTargets: reading.rebalanceTargets ?? null,
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
      const venue = await reader(target);
      body = snapshotBody(target, await venue.balances());
      const { credits, breakdowns, errors } = await readCredits(target, venue);
      if (credits) body.credits = credits;
      if (breakdowns) body.breakdowns = breakdowns;
      if (errors.length > 0) body.raw = { ...(body.raw as object), creditsErrors: errors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Reading ${target.exchange_code} account ${target.label} failed: ${message}`);
      body = { accountId: target.account_id, status: 'ERROR', error: message.slice(0, 1000) };
    }
    const recon = await registryFetch<{ cashStatus: string; positionBreaks: number; creditsBooked?: number }>(
      '/treasury/snapshots', 'POST', apiKey, body);
    results[target.label] = `${recon.cashStatus}, ${recon.positionBreaks} position break(s), `
      + `${recon.creditsBooked ?? 0} credit(s) booked`;
  }
  console.log('Venue poll:', JSON.stringify(results));
  return results;
};
