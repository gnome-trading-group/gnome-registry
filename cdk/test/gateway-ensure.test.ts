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

  it('asks for a paper gateway as for a live one', async () => {
    const { d, marked, wakes } = deps('paper');

    expect(await ensureGateway('paper:hyperliquid:main', d)).toEqual({ gatewayKey: 'paper:hyperliquid:main', wanted: true });
    expect(marked).toEqual(['paper:hyperliquid:main']);
    expect(wakes).toHaveLength(1);
  });

  it('refuses what isn\'t a gateway\'s key, or a row of the other kind', async () => {
    await expect(ensureGateway('paper', deps().d)).rejects.toThrow(/gateway's key/);
    const asPaper = deps('paper');
    await expect(ensureGateway('live:kalshi:main', asPaper.d)).rejects.toThrow(/isn't a live gateway/);
    expect(asPaper.wakes).toEqual([]);
    const asLive = deps('live');
    await expect(ensureGateway('paper:kalshi:main', asLive.d)).rejects.toThrow(/isn't a paper gateway/);
    expect(asLive.wakes).toEqual([]);
  });
});
