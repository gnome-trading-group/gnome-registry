// A venue read that hits a rate limit or a server fault is tried again a couple of times inside the same poll: a
// single failed call would otherwise post the whole account as an ERROR snapshot until the next poll, five minutes
// later. Client errors are the request's own fault and aren't retried. The worst case stays well inside the
// poller's timeout across every account.
const ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 10_000;

const transientStatus = (status: number) => status === 429 || status >= 500;

function waitMs(res: Response | undefined, attempt: number): number | null {
  const retryAfter = res?.status === 429 ? res.headers.get('retry-after') : null;
  if (retryAfter !== null) {
    const ms = Number(retryAfter) * 1000;
    return ms <= MAX_RETRY_AFTER_MS ? ms : null;
  }
  return BASE_DELAY_MS * 2 ** (attempt - 1) * (1 + Math.random() * 0.25);
}

// The request is rebuilt for every attempt so a signed one carries a fresh timestamp. failedInBody marks an answer
// as transient when the venue reports its fault in a 200's body, as JSON-RPC nodes do; it reads a clone, so the
// caller can still read the body it gets back.
export async function fetchWithRetry(
  url: string,
  init: () => RequestInit = () => ({}),
  failedInBody?: (body: Response) => Promise<boolean>,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, init());
    } catch (error) {
      if (attempt === ATTEMPTS) throw error;
    }
    if (res && !transientStatus(res.status) && !(failedInBody && await failedInBody(res.clone()))) return res;
    const wait = attempt === ATTEMPTS ? null : waitMs(res, attempt);
    if (wait === null) return res!;
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}
