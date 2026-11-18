import {
  choosePaperInstance, Instance, instanceKey, instanceNumber, PaperInstanceDeps, PaperInstanceError, parseRequest,
  resolvePaperInstance,
} from '../lambda/endpoints/gateway-paper-instance';
import { GatewayEndpoint, GatewayRow } from '../lambda/endpoints/gateway-status';

const NOW = Date.parse('2026-11-16T18:00:00Z');
const STARTED = Date.parse('2026-11-16T12:00:00Z');

function endpoint(books: number, streams: number, state = 'READY', startedAtMs = STARTED): GatewayEndpoint {
  return {
    state,
    instance: 'i-1',
    privateIp: '10.0.0.1',
    port: 40010,
    version: '2.3.0',
    writtenAt: new Date(NOW).toISOString(),
    linkedSessions: 1,
    workingOrders: 0,
    canHandOver: false,
    handover: false,
    startedAt: new Date(startedAtMs).toISOString(),
    paper: { books, streams, recordsPerSecond: 100, maxBooks: 800, maxStreams: 150 },
    availabilityZone: null,
    availabilityZoneId: null,
  };
}

function instance(number: number, ep: GatewayEndpoint | null, wantedAtMs: number | null = null): Instance {
  return { gatewayKey: instanceKey('kalshi', number), number, endpoint: ep, wantedAtMs };
}

const ask = (listings: number, current?: { key: string; startedAtMs: number }) => ({
  sessionId: 's-1',
  exchange: 'kalshi',
  listings,
  currentKey: current?.key ?? null,
  currentStartedAtMs: current?.startedAtMs ?? null,
});

describe('choosing a paper session\'s gateway', () => {
  it('names instances main, 2, 3 and reads them back', () => {
    expect(instanceKey('kalshi', 1)).toBe('paper:kalshi:main');
    expect(instanceKey('kalshi', 3)).toBe('paper:kalshi:3');
    expect(instanceNumber('paper:kalshi:main')).toBe(1);
    expect(instanceNumber('paper:kalshi:12')).toBe(12);
    expect(instanceNumber('paper:kalshi:load')).toBeNull();
  });

  it('keeps a session on the process holding its books, even when that gateway is now full', () => {
    const instances = [instance(1, endpoint(10, 10)), instance(2, endpoint(800, 150))];

    expect(choosePaperInstance(ask(10, { key: 'paper:kalshi:2', startedAtMs: STARTED }), instances, NOW))
      .toBe('paper:kalshi:2');
  });

  it('moves a session whose gateway restarted, its books gone, to the lowest instance with room', () => {
    const instances = [instance(1, endpoint(10, 10)), instance(2, endpoint(100, 50, 'READY', STARTED + 60_000))];

    expect(choosePaperInstance(ask(10, { key: 'paper:kalshi:2', startedAtMs: STARTED }), instances, NOW))
      .toBe('paper:kalshi:main');
  });

  it('packs onto the lowest instance where all the session\'s listings fit as books and as streams', () => {
    const instances = [instance(1, endpoint(795, 20)), instance(2, endpoint(10, 145)), instance(3, endpoint(10, 10))];

    expect(choosePaperInstance(ask(4), instances, NOW)).toBe('paper:kalshi:main');
    expect(choosePaperInstance(ask(10), instances, NOW)).toBe('paper:kalshi:3');
  });

  it('sends sessions to an instance just asked for and still starting, rather than starting another each', () => {
    const instances = [instance(1, endpoint(800, 150)), instance(2, null, NOW - 30_000)];

    expect(choosePaperInstance(ask(10), instances, NOW)).toBe('paper:kalshi:2');
  });

  it('starts the lowest free instance when every running one is full, reusing a stopped one\'s name', () => {
    const instances = [instance(1, endpoint(800, 150)), instance(2, null, NOW - 3_600_000), instance(3, endpoint(800, 1))];

    expect(choosePaperInstance(ask(10), instances, NOW)).toBe('paper:kalshi:2');
    expect(choosePaperInstance(ask(10), [], NOW)).toBe('paper:kalshi:main');
  });

  it('past the most instances a venue runs, gives the least loaded, whose refusal says it is full', () => {
    const instances = [instance(1, endpoint(800, 150)), instance(2, endpoint(790, 100))];

    expect(choosePaperInstance(ask(20), instances, NOW, 2)).toBe('paper:kalshi:2');
  });

  it('takes a gateway on a release that says no load as having room, as one per venue always did', () => {
    const legacy = { ...endpoint(0, 0), paper: null };

    expect(choosePaperInstance(ask(500), [instance(1, legacy)], NOW)).toBe('paper:kalshi:main');
  });

  it('never chooses a gateway that is stopping', () => {
    const instances = [instance(1, endpoint(10, 10, 'STOPPING')), instance(2, endpoint(10, 10))];

    expect(choosePaperInstance(ask(10), instances, NOW)).toBe('paper:kalshi:2');
  });
});

describe('the paper-instance request', () => {
  it('reads the session, its venue and its listings', () => {
    expect(parseRequest({
      sessionId: 's-1', exchange: 'kalshi', listings: '10', currentKey: 'paper:kalshi:2', currentStartedAtMs: '5',
    })).toEqual({ sessionId: 's-1', exchange: 'kalshi', listings: 10, currentKey: 'paper:kalshi:2', currentStartedAtMs: 5 });
    expect(parseRequest({ sessionId: 's-1', exchange: 'kalshi', listings: '0' }))
      .toEqual({ sessionId: 's-1', exchange: 'kalshi', listings: 0, currentKey: null, currentStartedAtMs: null });
  });

  it.each([
    [null],
    [{ exchange: 'kalshi', listings: '1' }],
    [{ sessionId: 's', exchange: 'Kalshi', listings: '1' }],
    [{ sessionId: 's', exchange: 'kalshi', listings: '-1' }],
    [{ sessionId: 's', exchange: 'kalshi', listings: '1.5' }],
    [{ sessionId: 's', exchange: 'kalshi', listings: '1', currentStartedAtMs: 'soon' }],
  ])('refuses %j', (params) => {
    expect(() => parseRequest(params)).toThrow(PaperInstanceError);
  });
});

describe('resolving a paper session\'s gateway', () => {
  function row(gateway_key: string, mode = 'paper', wanted_at: string | null = null): GatewayRow {
    return {
      gateway_key, mode, exchange_id: 5, exchange_code: 'KALSHI', region: 'us-east-2', profile: 'standard',
      orchestrator_version: null, wanted_at, roll_requested_at: null, roll_requested_by: null, accounts: 0,
    };
  }

  it('looks only at the venue\'s paper gateways, and asks for the one it chose', async () => {
    const ensured: string[] = [];
    const asked: string[][] = [];
    const deps: PaperInstanceDeps = {
      rows: async () => [row('paper:kalshi:main'), row('paper:polymarket_us:main'), row('live:kalshi:main', 'live')],
      endpoints: async (keys) => {
        asked.push(keys);
        return new Map(keys.map((key) => [key, endpoint(800, 150)]));
      },
      ensure: async (key) => {
        ensured.push(key);
      },
      nowMs: () => NOW,
    };

    expect(await resolvePaperInstance(ask(10), deps)).toEqual({ gatewayKey: 'paper:kalshi:2' });
    expect(asked).toEqual([['paper:kalshi:main']]);
    expect(ensured).toEqual(['paper:kalshi:2']);
  });
});
