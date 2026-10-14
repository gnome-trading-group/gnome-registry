import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';

// The registry API as a scheduled job outside the VPC reaches it: over HTTPS with the API key, looked up once per
// container from its id (REGISTRY_API_KEY overrides it for a local run).

const apiGwClient = new APIGatewayClient({});
let cachedApiKey: string | undefined;

export async function resolveApiKey(): Promise<string> {
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

export async function registryFetch<T>(path: string, method: string, apiKey: string, body?: unknown): Promise<T> {
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
