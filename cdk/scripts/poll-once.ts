// Reads one venue account exactly as the venue poller does and prints what it got, posting nothing to the registry:
// for checking the poller against a real account before it runs in AWS.
//
//   npx ts-node scripts/poll-once.ts --exchange KALSHI --credentials ~/kalshi.json [--kalshi-url https://external-api.demo.kalshi.co]
//   npx ts-node scripts/poll-once.ts --exchange POLYMARKET_US --credentials ~/pm-us.json
//   npx ts-node scripts/poll-once.ts --exchange POLYMARKET_INTL --funder 0x...
//
// --get <path> instead prints the venue's raw answer to one signed GET (Kalshi or Polymarket US), for finding
// endpoints the poller doesn't read yet. --out <file> also writes the reading, including the venue's raw answers,
// as JSON for a test fixture. The
// credentials file is read locally and only sent to the venue as signed request headers.
import { readFileSync, writeFileSync } from 'fs';
import { readKalshi } from '../lambda/sync/venues/kalshi';
import { readPolymarketIntl } from '../lambda/sync/venues/polymarket-intl';
import { readPolymarketUs } from '../lambda/sync/venues/polymarket-us';
import { kalshiHeaders, polymarketUsHeaders, polymarketUsKey } from '../lambda/sync/venues/signers';
import { PollTarget, VenueReading } from '../lambda/sync/venues/types';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function credentials(): Record<string, string> {
  const path = option('credentials');
  if (!path) throw new Error('--credentials is required for this venue');
  return JSON.parse(readFileSync(path.replace(/^~(?=\/)/, process.env.HOME ?? '~'), 'utf8'));
}

async function main() {
  const exchange = option('exchange');
  const target: PollTarget = {
    account_id: 0, exchange_id: 0, exchange_code: exchange ?? '', label: 'poll-once', read_secret_name: null,
    venue_ref: option('funder') ? { funderAddress: option('funder') } : {},
  };
  const probe = option('get');
  if (probe) {
    const c = credentials();
    const [base, headers] = exchange === 'KALSHI'
      ? [option('kalshi-url') ?? 'https://external-api.demo.kalshi.co',
        kalshiHeaders(c.apiKey, c.privateKey, 'GET', probe, Date.now())]
      : ['https://api.polymarket.us', polymarketUsHeaders(c.apiKey, polymarketUsKey(c.secret), 'GET', probe, Date.now())];
    const res = await fetch(`${base}${probe}`, { headers });
    console.log(res.status, await res.text());
    return;
  }
  let reading: VenueReading;
  if (exchange === 'KALSHI') {
    process.env.KALSHI_API_URL = option('kalshi-url') ?? process.env.KALSHI_API_URL ?? 'https://external-api.demo.kalshi.co';
    const c = credentials();
    if (c.subaccount !== undefined) target.venue_ref = { subaccount: c.subaccount };
    reading = await readKalshi(target, { apiKey: c.apiKey, privateKey: c.privateKey });
  } else if (exchange === 'POLYMARKET_US') {
    const c = credentials();
    reading = await readPolymarketUs(target, { apiKey: c.apiKey, secret: c.secret });
  } else if (exchange === 'POLYMARKET_INTL') {
    process.env.POLYGON_RPC_URL ??= 'https://polygon-bor-rpc.publicnode.com';
    process.env.PUSD_TOKEN_ADDRESS ??= '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
    reading = await readPolymarketIntl(target);
  } else {
    throw new Error('--exchange must be KALSHI, POLYMARKET_US or POLYMARKET_INTL');
  }
  const json = JSON.stringify(reading, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
  const out = option('out');
  if (out) writeFileSync(out, json);
  console.log(JSON.stringify({ ...JSON.parse(json), raw: out ? `(written to ${out})` : JSON.parse(json).raw }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
