import { requestRoll, RollDeps, RollError, RollItem, RollRow } from '../lambda/endpoints/gateway-roll';

const NOW = Date.parse('2026-11-15T12:00:00Z');

function deps(row: RollRow | null, item: RollItem | null) {
  const marked: Array<[string, string]> = [];
  const wakes: string[] = [];
  const d: RollDeps = {
    row: async () => row,
    rollItem: async () => item,
    markRollRequested: async (key, actor) => {
      marked.push([key, actor]);
      return { gateway_key: key, roll_requested_at: new Date(NOW).toISOString() };
    },
    wake: async (id) => {
      wakes.push(id);
    },
    nowMs: () => NOW,
  };
  return { d, marked, wakes };
}

const row = (requestedAt: string | null = null): RollRow => ({ gateway_key: 'live:kalshi:main', roll_requested_at: requestedAt });

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RollError);
    return error as RollError;
  }
  throw new Error('expected a refusal');
}

describe('an operator asking for a gateway to roll', () => {
  it('records who asked and wakes the reconciler', async () => {
    const { d, marked, wakes } = deps(row(), null);

    expect(await requestRoll('live:kalshi:main', 'a@b.c', d)).toEqual({
      gatewayKey: 'live:kalshi:main', rollRequestedAt: new Date(NOW).toISOString(), rollRequestedBy: 'a@b.c',
    });
    expect(marked).toEqual([['live:kalshi:main', 'a@b.c']]);
    expect(wakes).toHaveLength(1);
  });

  it('may ask again once the last roll ended, however it ended', async () => {
    for (const phase of ['done', 'rolled_back', 'failed', 'refused']) {
      const earlier = new Date(NOW - 60_000).toISOString();
      const { d, marked } = deps(row(earlier), { requestedAtMs: NOW - 60_000, phase });
      await requestRoll('live:kalshi:main', 'a@b.c', d);
      expect(marked).toHaveLength(1);
    }
  });

  it('is refused while a roll is under way', async () => {
    for (const phase of ['stopping', 'starting', 'rolling_back']) {
      const { d, marked, wakes } = deps(row(new Date(NOW - 60_000).toISOString()), { requestedAtMs: NOW - 60_000, phase });
      const error = await refusal(requestRoll('live:kalshi:main', 'a@b.c', d));
      expect(error.statusCode).toBe(409);
      expect(error.message).toContain(phase);
      expect(marked).toEqual([]);
      expect(wakes).toEqual([]);
    }
  });

  it('is refused while the last request waits for the reconciler, unless it has waited too long to be taken up', async () => {
    const waiting = deps(row(new Date(NOW - 30_000).toISOString()), { requestedAtMs: NOW - 3_600_000, phase: 'done' });
    expect((await refusal(requestRoll('live:kalshi:main', 'a@b.c', waiting.d))).statusCode).toBe(409);

    const neverTaken = deps(row(new Date(NOW - 30_000).toISOString()), null);
    expect((await refusal(requestRoll('live:kalshi:main', 'a@b.c', neverTaken.d))).statusCode).toBe(409);

    const lost = deps(row(new Date(NOW - 6 * 60_000).toISOString()), null);
    await requestRoll('live:kalshi:main', 'a@b.c', lost.d);
    expect(lost.marked).toHaveLength(1);
  });

  it("refuses a key that isn't a gateway's, and a gateway that doesn't exist", async () => {
    const { d } = deps(null, null);
    expect((await refusal(requestRoll('kalshi', 'a@b.c', d))).statusCode).toBe(400);
    expect((await refusal(requestRoll('live:kalshi:other', 'a@b.c', d))).statusCode).toBe(404);
  });
});
