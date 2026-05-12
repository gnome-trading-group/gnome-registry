import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { Exchange, Listing, ListingSpecData, Security } from './exchanges/types';
import { getAdapter } from './exchanges/index';

const apiGwClient = new APIGatewayClient({});
let cachedApiKey: string | undefined;

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

interface ListingSpec {
  listing_id: number;
  tick_size: number;
  lot_size: number;
  min_notional: number;
}

export const handler = async () => {
  const apiKey = await resolveApiKey();

  const [exchanges, listings, securities, existingSpecs] = await Promise.all([
    registryFetch<Exchange[]>('/exchanges', 'GET', apiKey),
    registryFetch<Listing[]>('/listings', 'GET', apiKey),
    registryFetch<Security[]>('/securities', 'GET', apiKey),
    registryFetch<ListingSpec[]>('/listing-specs', 'GET', apiKey),
  ]);

  const existingSpecMap = new Map<number, ListingSpec>(
    existingSpecs.map(s => [s.listing_id, s])
  );

  const listingsByExchangeId = new Map<number, Listing[]>();
  for (const listing of listings) {
    const group = listingsByExchangeId.get(listing.exchange_id) ?? [];
    group.push(listing);
    listingsByExchangeId.set(listing.exchange_id, group);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const exchange of exchanges) {
    const adapter = getAdapter(exchange.exchange_name);
    if (!adapter) {
      console.log(`No adapter for exchange "${exchange.exchange_name}" — skipping`);
      continue;
    }

    const exchangeListings = listingsByExchangeId.get(exchange.exchange_id) ?? [];
    if (exchangeListings.length === 0) continue;

    let specMap: Map<number, ListingSpecData>;
    try {
      specMap = await adapter.fetchSpecs(exchangeListings, securities);
    } catch (err) {
      console.error(`Failed to fetch specs from ${exchange.exchange_name}:`, err);
      errors++;
      continue;
    }

    for (const [listingId, spec] of specMap) {
      const existing = existingSpecMap.get(listingId);
      try {
        if (!existing) {
          await registryFetch('/listing-specs', 'POST', apiKey, {
            listingId,
            tickSize: spec.tickSize,
            lotSize: spec.lotSize,
            minNotional: spec.minNotional,
          });
          created++;
        } else if (
          existing.tick_size !== spec.tickSize ||
          existing.lot_size !== spec.lotSize ||
          existing.min_notional !== spec.minNotional
        ) {
          await registryFetch(`/listing-specs?listingId=${listingId}`, 'PATCH', apiKey, {
            tickSize: spec.tickSize,
            lotSize: spec.lotSize,
            minNotional: spec.minNotional,
          });
          updated++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`Failed to upsert spec for listingId=${listingId}:`, err);
        errors++;
      }
    }
  }

  console.log(`Listing spec sync complete — created=${created} updated=${updated} skipped=${skipped} errors=${errors}`);
};
