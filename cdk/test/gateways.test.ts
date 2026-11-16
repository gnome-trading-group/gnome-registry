import { GatewayHandler, generateWantPaperQuery } from '../lambda/endpoints/gateways';

const handler = new GatewayHandler();
const live = { gateway_key: 'live:kalshi:main', mode: 'live' };
const paper = { gateway_key: 'paper:kalshi:main', mode: 'paper' };

describe('gateways', () => {
  it('filters by key, mode and exchange', () => {
    const query = handler.generateSelectQuery({ gatewayKey: 'live:kalshi:main', mode: 'live', exchangeId: '3' });
    expect(query.text).toContain('g.gateway_key = $1');
    expect(query.text).toContain('g.mode = $2');
    expect(query.text).toContain('g.exchange_id = $3');
    expect(query.values).toEqual(['live:kalshi:main', 'live', '3']);
    expect(handler.generateSelectQuery(null).values).toEqual([]);
  });

  it('records a wanted time from the database clock, not the caller', () => {
    const update = handler.generateModifyQuery(live, JSON.stringify({ wanted: true }));
    expect(update.text).toContain('wanted_at = NOW()');
    expect(update.values).toEqual(['live:kalshi:main']);
    expect(() => handler.generateModifyQuery(live, JSON.stringify({ wanted: false }))).toThrow('wanted');
  });

  it('records a roll request from the roll route only, stamped by the database clock', () => {
    const fromPerson = new GatewayHandler();
    expect(() => fromPerson.generateModifyQuery(live, JSON.stringify({ rollRequestedBy: 'a@b.c' })))
      .toThrow('POST /gateways/roll');

    const fromService = new GatewayHandler();
    (fromService as unknown as { fromService: boolean }).fromService = true;
    const update = fromService.generateModifyQuery(live, JSON.stringify({ rollRequestedBy: 'a@b.c' }));
    expect(update.text).toContain('roll_requested_at = NOW()');
    expect(update.values).toEqual(['a@b.c', 'live:kalshi:main']);
    expect(() => fromService.generateModifyQuery(live, JSON.stringify({ rollRequestedBy: '' }))).toThrow('rollRequestedBy');
  });

  it('creates a paper gateway on its exchange the first time it is wanted, and only marks it after', () => {
    const query = generateWantPaperQuery('paper:polymarket_intl:main');
    expect(query.text).toContain('INSERT INTO account_master.gateway');
    expect(query.text).toContain('lower(e.exchange_code) = $2');
    expect(query.text).toContain('ON CONFLICT (gateway_key) DO UPDATE SET wanted_at');
    expect(query.values).toEqual(['paper:polymarket_intl:main', 'polymarket_intl']);
    expect(() => generateWantPaperQuery('live:kalshi:main')).toThrow("isn't a paper gateway's key");
    expect(() => generateWantPaperQuery("paper:x' OR 1=1:main")).toThrow("isn't a paper gateway's key");
  });

  it('takes a live profile for a live gateway and only paper for a paper one', () => {
    expect(handler.generateModifyQuery(live, JSON.stringify({ profile: 'low_latency' })).values)
      .toEqual(['low_latency', 'live:kalshi:main']);
    expect(() => handler.generateModifyQuery(live, JSON.stringify({ profile: 'paper' }))).toThrow('profile');
    expect(() => handler.generateModifyQuery(paper, JSON.stringify({ profile: 'standard' }))).toThrow('profile');
  });

  it('pins and clears a release', () => {
    const pin = handler.generateModifyQuery(live, JSON.stringify({ orchestratorVersion: '1.29.0' }));
    expect(pin.text).toContain('orchestrator_version = $1');
    expect(pin.values).toEqual(['1.29.0', 'live:kalshi:main']);
    expect(handler.generateModifyQuery(live, JSON.stringify({ orchestratorVersion: null })).values)
      .toEqual([null, 'live:kalshi:main']);
    expect(() => handler.generateModifyQuery(live, JSON.stringify({ orchestratorVersion: 'latest' })))
      .toThrow('orchestratorVersion');
  });
});
