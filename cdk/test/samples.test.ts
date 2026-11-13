import { isSubject, MAX_AGE_MS, MAX_FUTURE_MS, MAX_SAMPLES_PER_POST, parseSamples } from '../lambda/endpoints/samples';

const NOW = Date.UTC(2026, 10, 13, 12);

describe('posted samples', () => {
  it('keeps well-formed samples in order', () => {
    const raw = [
      { kind: 'runtime', tsMs: NOW - 10_000, data: { host: { cpuBusyPermille: 120 } } },
      { kind: 'latency.oms', tsMs: NOW - 60_000, data: { keys: [] } },
    ];
    expect(parseSamples(raw, NOW)).toEqual({ samples: raw, dropped: 0 });
  });

  it('reads no samples as none', () => {
    expect(parseSamples(undefined, NOW)).toEqual({ samples: [], dropped: 0 });
    expect(parseSamples(null, NOW)).toEqual({ samples: [], dropped: 0 });
  });

  it('drops what it cannot store, counting each', () => {
    const { samples, dropped } = parseSamples([
      { kind: 'Runtime', tsMs: NOW, data: {} },
      { kind: 'runtime', tsMs: NOW + 0.5, data: {} },
      { kind: 'runtime', tsMs: NOW, data: [] },
      { kind: 'runtime', tsMs: NOW, data: null },
      { kind: 'runtime', tsMs: NOW + MAX_FUTURE_MS + 1, data: {} },
      { kind: 'runtime', tsMs: NOW - MAX_AGE_MS - 1, data: {} },
      'runtime',
      { kind: 'runtime', tsMs: NOW, data: {} },
    ], NOW);
    expect(samples).toEqual([{ kind: 'runtime', tsMs: NOW, data: {} }]);
    expect(dropped).toBe(7);
  });

  it('takes at most a post\'s worth and counts the rest dropped', () => {
    const raw = Array.from({ length: MAX_SAMPLES_PER_POST + 5 }, (_, i) => ({ kind: 'runtime', tsMs: NOW - i, data: {} }));
    const { samples, dropped } = parseSamples(raw, NOW);
    expect(samples).toHaveLength(MAX_SAMPLES_PER_POST);
    expect(dropped).toBe(5);
  });

  it('counts a samples field that is not a list as one dropped', () => {
    expect(parseSamples({ kind: 'runtime' }, NOW)).toEqual({ samples: [], dropped: 1 });
  });
});

describe('subjects', () => {
  it('takes each kind of process by its own id', () => {
    expect(isSubject('session', 'a1B2_c3-d4')).toBe(true);
    expect(isSubject('gateway', 'live:kalshi:main')).toBe(true);
    expect(isSubject('gateway', 'paper:polymarket_intl:main')).toBe(true);
    expect(isSubject('shard', 'use1-1b7a9c')).toBe(true);
    expect(isSubject('shard', 'local')).toBe(true);
  });

  it('refuses an id of the wrong shape for its kind, and unknown kinds', () => {
    expect(isSubject('gateway', 'use1-1b7a9c')).toBe(false);
    expect(isSubject('gateway', 'LIVE:kalshi:main')).toBe(false);
    expect(isSubject('shard', 'live:kalshi:main')).toBe(false);
    expect(isSubject('session', 'a/b')).toBe(false);
    expect(isSubject('collector', 'use1-1b7a9c')).toBe(false);
    expect(isSubject('toString', 'x')).toBe(false);
    expect(isSubject('session', '')).toBe(false);
    expect(isSubject(undefined, 'x')).toBe(false);
  });
});
