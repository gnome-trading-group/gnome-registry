// One retry for a rate limit, if the wait it asks for is short enough to sit out inside the router's invocation;
// anything else fails, and the next tick redelivers.
const MAX_RETRY_WAIT_MS = 10_000;

export async function sendWithRetry(send: () => Promise<Response>): Promise<Response> {
  const first = await send();
  if (first.status !== 429) return first;
  const waitMs = Number(first.headers.get('retry-after') ?? '1') * 1000;
  if (!(waitMs <= MAX_RETRY_WAIT_MS)) return first;
  await new Promise(resolve => setTimeout(resolve, waitMs));
  return send();
}
