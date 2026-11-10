import { ensureGateway, EnsureDeps } from '../lambda/endpoints/gateway-ensure';

function deps(mode = 'live') {
  const marked: string[] = [];
  const wakes: string[] = [];
  let now = 1_000_000;
  const d: EnsureDeps = {
    markWanted: async (key) => {
      marked.push(key);
      return { mode };
    },
    wake: async (id) => {
      wakes.push(id);
    },
    nowMs: () => now,
  };
  return { d, marked, wakes, advance: (ms: number) => { now += ms; } };
}

describe('a session asking for a gateway', () => {
  it('marks it wanted and wakes the reconciler, touching nothing else', async () => {
    const { d, marked, wakes } = deps();

    expect(await ensureGateway('live:kalshi:main', d)).toEqual({ gatewayKey: 'live:kalshi:main', wanted: true });
    expect(marked).toEqual(['live:kalshi:main']);
    expect(wakes).toHaveLength(1);
  });

  it('wakes with one id within a few seconds, so a burst of asks costs the reconciler one tick', async () => {
    const { d, wakes, advance } = deps();
    await ensureGateway('live:kalshi:main', d);
    advance(1_000);
    await ensureGateway('live:polymarket_us:main', d);
    advance(10_000);
    await ensureGateway('live:kalshi:main', d);

    expect(wakes[0]).toBe(wakes[1]);
    expect(wakes[2]).not.toBe(wakes[1]);
  });

  it('refuses what isn\'t a live gateway', async () => {
    await expect(ensureGateway('paper', deps().d)).rejects.toThrow(/live gateway's key/);
    const { d, wakes } = deps('paper');
    await expect(ensureGateway('live:kalshi:main', d)).rejects.toThrow(/isn't a live gateway/);
    expect(wakes).toEqual([]);
  });
});
