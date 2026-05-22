import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  CurrencyResponse,
  ExchangeResponse,
  ExchangeSecurityData,
  ListingResponse,
  ListingSpecResponse,
  SecurityResponse,
} from './exchanges/types';
import { getAdapter } from './exchanges/index';

const apiGwClient = new APIGatewayClient({});
const smClient = new SecretsManagerClient({});
let cachedApiKey: string | undefined;
let cachedSlackToken: string | undefined;

async function resolveApiKey(): Promise<string> {
  if (!cachedApiKey) {
    if (process.env.REGISTRY_API_KEY) {
      cachedApiKey = process.env.REGISTRY_API_KEY;
    } else {
      const res = await apiGwClient.send(new GetApiKeyCommand({
        apiKey: process.env.REGISTRY_API_KEY_ID!,
        includeValue: true,
      }));
      cachedApiKey = res.value!;
    }
  }
  return cachedApiKey!;
}

async function resolveSlackToken(): Promise<string | undefined> {
  const secretName = process.env.SLACK_BOT_TOKEN_SECRET;
  if (!secretName) return undefined;
  if (!cachedSlackToken) {
    const res = await smClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    cachedSlackToken = res.SecretString!;
  }
  return cachedSlackToken;
}

async function registryFetch<T>(path: string, method: string, apiKey: string, body?: unknown): Promise<T> {
  const baseUrl = process.env.REGISTRY_API_URL!.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Registry API ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function batchExecute<T>(items: T[], batchSize: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}

async function postSlackNotification(
  newSecuritySymbols: string[],
  newListings: { exchangeName: string; symbol: string }[],
  summary: { currencies: number; specCreated: number; specUpdated: number; errors: number },
): Promise<void> {
  const channel = process.env.SLACK_CHANNEL;
  if (!channel) return;
  const token = await resolveSlackToken();
  if (!token) return;

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Exchange Sync' } },
  ];

  if (newSecuritySymbols.length > 0) {
    const lines = newSecuritySymbols.map(s => `• \`${s}\``).join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${newSecuritySymbols.length} new ${newSecuritySymbols.length === 1 ? 'security' : 'securities'}*\n${lines}` },
    });
  }

  if (newListings.length > 0) {
    const byExchange = new Map<string, string[]>();
    for (const l of newListings) {
      (byExchange.get(l.exchangeName) ?? (byExchange.set(l.exchangeName, []), byExchange.get(l.exchangeName)!)).push(l.symbol);
    }
    const lines = [...byExchange.entries()].map(([ex, syms]) => `• *${ex}*: ${syms.map(s => `\`${s}\``).join(', ')}`).join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${newListings.length} new ${newListings.length === 1 ? 'listing' : 'listings'}*\n${lines}` },
    });
  }

  const parts: string[] = [];
  if (summary.currencies > 0) parts.push(`${summary.currencies} currencies`);
  if (summary.specCreated > 0) parts.push(`${summary.specCreated} specs created`);
  if (summary.specUpdated > 0) parts.push(`${summary.specUpdated} specs updated`);
  if (summary.errors > 0) parts.push(`${summary.errors} errors`);
  if (parts.length > 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] });
  }

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, blocks }),
  });
  const json = await res.json() as { ok: boolean; error?: string };
  if (!json.ok) {
    console.error('Slack notification failed:', json.error);
  }
}

export const handler = async () => {
  const apiKey = await resolveApiKey();

  const [exchanges, currencies, securities, listings, existingSpecs] = await Promise.all([
    registryFetch<ExchangeResponse[]>('/exchanges', 'GET', apiKey),
    registryFetch<CurrencyResponse[]>('/currencies', 'GET', apiKey),
    registryFetch<SecurityResponse[]>('/securities', 'GET', apiKey),
    registryFetch<ListingResponse[]>('/listings', 'GET', apiKey),
    registryFetch<ListingSpecResponse[]>('/listing-specs', 'GET', apiKey),
  ]);

  const currencyBySymbol = new Map<string, CurrencyResponse>(currencies.map(c => [c.symbol, c]));
  const securityBySymbol = new Map<string, SecurityResponse>(securities.map(s => [s.symbol, s]));
  const listingByKey = new Map<string, ListingResponse>(
    listings.map(l => [`${l.exchange_id}:${l.exchange_security_id}`, l])
  );
  const specByListingId = new Map<number, ListingSpecResponse>(existingSpecs.map(s => [s.listing_id, s]));
  const exchangeNameById = new Map<number, string>(exchanges.map(e => [e.exchange_id, e.exchange_name]));

  // Fetch from all adapters
  const byExchange: Array<{ exchangeId: number; data: ExchangeSecurityData[] }> = [];
  for (const exchange of exchanges) {
    const adapter = getAdapter(exchange.exchange_name);
    if (!adapter) {
      console.log(`No adapter for exchange "${exchange.exchange_name}" — skipping`);
      continue;
    }
    try {
      const data = await adapter.fetchSecurities();
      byExchange.push({ exchangeId: exchange.exchange_id, data });
    } catch (err) {
      console.error(`Failed to fetch securities from "${exchange.exchange_name}":`, err);
    }
  }

  let currencyCreated = 0;
  let securityCreated = 0;
  let listingCreated = 0;
  let specCreated = 0;
  let specUpdated = 0;
  let skipped = 0;
  let errors = 0;
  const newSecuritySymbols: string[] = [];
  const newListings: { exchangeName: string; symbol: string }[] = [];

  // Phase 1: Currencies
  const allCurrencySymbols = new Set<string>();
  for (const { data } of byExchange) {
    for (const sec of data) {
      allCurrencySymbols.add(sec.baseCurrency);
      allCurrencySymbols.add(sec.quoteCurrency);
      allCurrencySymbols.add(sec.settleCurrency);
    }
  }
  const newCurrencies = [...allCurrencySymbols].filter(sym => !currencyBySymbol.has(sym));
  await batchExecute(newCurrencies, 10, async (symbol) => {
    try {
      const created = await registryFetch<CurrencyResponse>('/currencies', 'POST', apiKey, { symbol });
      currencyBySymbol.set(symbol, created);
      currencyCreated++;
    } catch (err) {
      console.error(`Failed to create currency "${symbol}":`, err);
      errors++;
    }
  });

  // Phase 2: Securities (deduplicated by securitySymbol across exchanges)
  const uniqueSecurities = new Map<string, ExchangeSecurityData>();
  for (const { data } of byExchange) {
    for (const sec of data) {
      if (!uniqueSecurities.has(sec.securitySymbol)) {
        uniqueSecurities.set(sec.securitySymbol, sec);
      }
    }
  }
  await batchExecute([...uniqueSecurities.values()], 10, async (sec) => {
    if (securityBySymbol.has(sec.securitySymbol)) return;
    const baseCurrencyId = currencyBySymbol.get(sec.baseCurrency)?.currency_id ?? null;
    const quoteCurrencyId = currencyBySymbol.get(sec.quoteCurrency)?.currency_id ?? null;
    const settleCurrencyId = currencyBySymbol.get(sec.settleCurrency)?.currency_id ?? null;
    try {
      const created = await registryFetch<SecurityResponse>('/securities', 'POST', apiKey, {
        symbol: sec.securitySymbol,
        type: sec.securityType,
        contractType: sec.contractType,
        assetClass: sec.assetClass,
        baseCurrencyId,
        quoteCurrencyId,
        settleCurrencyId,
        inverse: sec.inverse,
        quanto: sec.isQuanto,
        active: true,
      });
      securityBySymbol.set(sec.securitySymbol, created);
      newSecuritySymbols.push(sec.securitySymbol);
      securityCreated++;
    } catch (err) {
      console.error(`Failed to create security "${sec.securitySymbol}":`, err);
      errors++;
    }
  });

  // Phase 3: Listings
  for (const { exchangeId, data } of byExchange) {
    await batchExecute(data, 10, async (sec) => {
      const key = `${exchangeId}:${sec.exchangeSecurityId}`;
      if (listingByKey.has(key)) return;
      const security = securityBySymbol.get(sec.securitySymbol);
      if (!security) {
        console.warn(`Security "${sec.securitySymbol}" not in registry — skipping listing ${key}`);
        return;
      }
      try {
        const created = await registryFetch<ListingResponse>('/listings', 'POST', apiKey, {
          exchangeId,
          securityId: security.security_id,
          exchangeSecurityId: sec.exchangeSecurityId,
          exchangeSecuritySymbol: sec.exchangeSecuritySymbol,
        });
        listingByKey.set(key, created);
        newListings.push({ exchangeName: exchangeNameById.get(exchangeId) ?? String(exchangeId), symbol: sec.exchangeSecuritySymbol });
        listingCreated++;
      } catch (err) {
        console.error(`Failed to create listing ${key}:`, err);
        errors++;
      }
    });
  }

  // Phase 4: Listing specs — append-only, INSERT only when values change
  for (const { exchangeId, data } of byExchange) {
    await batchExecute(data, 10, async (sec) => {
      const key = `${exchangeId}:${sec.exchangeSecurityId}`;
      const listing = listingByKey.get(key);
      if (!listing) return;
      const existing = specByListingId.get(listing.listing_id);
      const changed = !existing
        || Number(existing.tick_size) !== sec.tickSize
        || Number(existing.lot_size) !== sec.lotSize
        || Number(existing.min_notional) !== sec.minNotional
        || Number(existing.contract_multiplier) !== sec.contractMultiplier;
      if (!changed) {
        skipped++;
        return;
      }
      try {
        await registryFetch('/listing-specs', 'POST', apiKey, {
          listingId: listing.listing_id,
          tickSize: sec.tickSize,
          lotSize: sec.lotSize,
          minNotional: sec.minNotional,
          contractMultiplier: sec.contractMultiplier,
        });
        if (existing) { specUpdated++; } else { specCreated++; }
      } catch (err) {
        console.error(`Failed to record spec for listingId=${listing.listing_id}:`, err);
        errors++;
      }
    });
  }

  console.log(
    `Exchange sync complete — currencies=${currencyCreated} securities=${securityCreated} ` +
    `listings=${listingCreated} specs.created=${specCreated} specs.updated=${specUpdated} ` +
    `skipped=${skipped} errors=${errors}`
  );

  if (newSecuritySymbols.length > 0 || newListings.length > 0) {
    await postSlackNotification(newSecuritySymbols, newListings, { currencies: currencyCreated, specCreated, specUpdated, errors });
  }
};
