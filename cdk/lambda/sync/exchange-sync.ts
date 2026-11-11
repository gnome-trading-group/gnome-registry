import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  CurrencyResponse,
  ExchangeFetch,
  ExchangeResponse,
  ListingResponse,
  ListingSpecResponse,
  SecurityResponse,
} from './exchanges/types';
import { getAdapter } from './exchanges/index';
import { registryFetch, resolveApiKey } from './registry-client';

const smClient = new SecretsManagerClient({});
let cachedSlackToken: string | undefined;

async function resolveSlackToken(): Promise<string | undefined> {
  const secretName = process.env.SLACK_BOT_TOKEN_SECRET;
  if (!secretName) return undefined;
  if (!cachedSlackToken) {
    const res = await smClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    cachedSlackToken = res.SecretString!;
  }
  return cachedSlackToken;
}

const PAGE_SIZE = 5000;
const PATCH_BATCH_SIZE = 200;

async function registryFetchAll<T>(path: string, apiKey: string): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  while (true) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await registryFetch<T[]>(
      `${path}${separator}limit=${PAGE_SIZE}&offset=${offset}`, 'GET', apiKey
    );
    items.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return items;
}

async function batchExecute<T>(items: T[], batchSize: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}

type ListingNote = { exchangeName: string; symbol: string };

interface ListingPatch {
  listingId: number;
  active?: boolean;
  volume24h?: number;
}

/**
 * What to change on an exchange's existing listings: each one the venue returned takes the venue's active flag and
 * volume, and an active one the venue no longer returns is retired, if the fetch covers it. Only listings of the
 * security types the fetch returned are retired, so contracts the classifier keeps on the same exchange are left alone;
 * an empty fetch retires nothing.
 */
export function listingPatches(
  fetched: ExchangeFetch,
  listings: ListingResponse[],
  securityTypeByListing: Map<number, number>,
): ListingPatch[] {
  const byVenueId = new Map(fetched.securities.map(sec => [sec.exchangeSecurityId, sec]));
  const syncedTypes = new Set(fetched.securities.map(sec => sec.securityType));
  const patches: ListingPatch[] = [];
  for (const listing of listings) {
    const sec = byVenueId.get(listing.exchange_security_id);
    if (sec) {
      const patch: ListingPatch = { listingId: listing.listing_id };
      if (listing.active !== sec.active) patch.active = sec.active;
      if (sec.volume24h !== undefined && (listing.volume_24h === null || Number(listing.volume_24h) !== sec.volume24h)) {
        patch.volume24h = sec.volume24h;
      }
      if (patch.active !== undefined || patch.volume24h !== undefined) patches.push(patch);
      continue;
    }
    const type = securityTypeByListing.get(listing.listing_id);
    if (listing.active && type !== undefined && syncedTypes.has(type) && fetched.covers(listing.exchange_security_id)) {
      patches.push({ listingId: listing.listing_id, active: false });
    }
  }
  return patches;
}

async function postSlackNotification(
  newSecuritySymbols: string[],
  newListings: ListingNote[],
  deactivated: ListingNote[],
  reactivated: ListingNote[],
  summary: { currencies: number; specCreated: number; specUpdated: number; volumes: number; errors: number },
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

  const listingSection = (notes: ListingNote[], label: string) => {
    if (notes.length === 0) return;
    const byExchange = new Map<string, string[]>();
    for (const l of notes) {
      (byExchange.get(l.exchangeName) ?? (byExchange.set(l.exchangeName, []), byExchange.get(l.exchangeName)!)).push(l.symbol);
    }
    const lines = [...byExchange.entries()].map(([ex, syms]) => `• *${ex}*: ${syms.map(s => `\`${s}\``).join(', ')}`).join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${notes.length} ${label} ${notes.length === 1 ? 'listing' : 'listings'}*\n${lines}` },
    });
  };
  listingSection(newListings, 'new');
  listingSection(deactivated, 'deactivated');
  listingSection(reactivated, 'reactivated');

  const parts: string[] = [];
  if (summary.currencies > 0) parts.push(`${summary.currencies} currencies`);
  if (summary.specCreated > 0) parts.push(`${summary.specCreated} specs created`);
  if (summary.specUpdated > 0) parts.push(`${summary.specUpdated} specs updated`);
  if (summary.volumes > 0) parts.push(`${summary.volumes} volumes`);
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

  const [exchanges, currencies] = await Promise.all([
    registryFetchAll<ExchangeResponse>('/exchanges', apiKey),
    registryFetchAll<CurrencyResponse>('/currencies', apiKey),
  ]);

  const securities = await registryFetchAll<SecurityResponse>('/securities?assetClass=0', apiKey);

  const adapterExchangeIds = exchanges
    .filter(e => getAdapter(e.exchange_code) != null)
    .map(e => e.exchange_id);

  const listings: (ListingResponse & { security_type: number })[] = [];
  const existingSpecs: ListingSpecResponse[] = [];
  for (const id of adapterExchangeIds) {
    const [l, s] = await Promise.all([
      registryFetchAll<ListingResponse & { security_type: number }>(`/listings?exchangeId=${id}&denormalize=true`, apiKey),
      registryFetchAll<ListingSpecResponse>(`/listing-specs?exchangeId=${id}`, apiKey),
    ]);
    listings.push(...l);
    existingSpecs.push(...s);
  }
  const securityTypeByListing = new Map<number, number>(listings.map(l => [l.listing_id, Number(l.security_type)]));

  const currencyBySymbol = new Map<string, CurrencyResponse>(currencies.map(c => [c.symbol, c]));
  const securityBySymbol = new Map<string, SecurityResponse>(securities.map(s => [s.symbol, s]));
  const listingByKey = new Map<string, ListingResponse>(
    listings.map(l => [`${l.exchange_id}:${l.exchange_security_id}`, l])
  );
  const specByListingId = new Map<number, ListingSpecResponse>(existingSpecs.map(s => [s.listing_id, s]));
  const exchangeNameById = new Map<number, string>(exchanges.map(e => [e.exchange_id, e.exchange_name]));

  const byExchange: Array<{ exchangeId: number; fetched: ExchangeFetch; data: ExchangeFetch['securities'] }> = [];
  for (const exchange of exchanges) {
    const adapter = getAdapter(exchange.exchange_code);
    if (!adapter) {
      console.log(`No adapter for exchange "${exchange.exchange_name}" — skipping`);
      continue;
    }
    try {
      const fetched = await adapter.fetchSecurities();
      byExchange.push({ exchangeId: exchange.exchange_id, fetched, data: fetched.securities });
    } catch (err) {
      console.error(`Failed to fetch securities from "${exchange.exchange_name}":`, err);
    }
  }

  let currencyCreated = 0;
  let securityCreated = 0;
  let listingCreated = 0;
  let specCreated = 0;
  let specUpdated = 0;
  let volumesWritten = 0;
  let skipped = 0;
  let errors = 0;
  const newSecuritySymbols: string[] = [];
  const newListings: ListingNote[] = [];
  const deactivated: ListingNote[] = [];
  const reactivated: ListingNote[] = [];

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

  // Phase 2: Securities (prediction market contracts are handled by the classifier Lambda)
  const uniqueSecurities = new Map<string, ExchangeFetch['securities'][number]>();
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

  // Phase 3: Listings (prediction market contracts are handled by the classifier Lambda)
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
          feeGroup: sec.feeGroup ?? null,
          active: sec.active,
          volume24h: sec.volume24h ?? null,
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

  // Phase 4: Listing specs (prediction market contracts are handled by the classifier Lambda)
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

  // Phase 5: Existing listings' active flag and 24h volume (new listings were created with both)
  for (const { exchangeId, fetched } of byExchange) {
    const existing = listings.filter(l => l.exchange_id === exchangeId);
    const patches = listingPatches(fetched, existing, securityTypeByListing);
    const byId = new Map(existing.map(l => [l.listing_id, l]));
    const exchangeName = exchangeNameById.get(exchangeId) ?? String(exchangeId);
    for (let i = 0; i < patches.length; i += PATCH_BATCH_SIZE) {
      const batch = patches.slice(i, i + PATCH_BATCH_SIZE);
      try {
        await registryFetch('/listings', 'PATCH', apiKey, batch);
      } catch (err) {
        console.error(`Failed to update ${batch.length} listings of exchange ${exchangeName}:`, err);
        errors++;
        continue;
      }
      for (const patch of batch) {
        const symbol = byId.get(patch.listingId)?.exchange_security_symbol ?? String(patch.listingId);
        if (patch.active === false) deactivated.push({ exchangeName, symbol });
        if (patch.active === true) reactivated.push({ exchangeName, symbol });
        if (patch.volume24h !== undefined) volumesWritten++;
      }
    }
  }

  console.log(
    `Exchange sync complete — currencies=${currencyCreated} securities=${securityCreated} ` +
    `listings=${listingCreated} specs.created=${specCreated} specs.updated=${specUpdated} ` +
    `volumes=${volumesWritten} deactivated=${deactivated.length} reactivated=${reactivated.length} ` +
    `skipped=${skipped} errors=${errors}`
  );

  if (newSecuritySymbols.length > 0 || newListings.length > 0 || deactivated.length > 0 || reactivated.length > 0) {
    await postSlackNotification(newSecuritySymbols, newListings, deactivated, reactivated,
      { currencies: currencyCreated, specCreated, specUpdated, volumes: volumesWritten, errors });
  }
};
