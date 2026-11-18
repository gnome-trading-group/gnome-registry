import { ValidationError } from '../lambda/endpoints/base';
import { ExchangeHandler, homeZone } from '../lambda/endpoints/exchanges';

const kalshi = { exchange_id: 5, exchange_code: 'KALSHI', exchange_name: 'Kalshi', region: 'us-east-2', home_zone_id: 'use2-az2' };

function update(body: object) {
  return new ExchangeHandler().generateModifyQuery(kalshi, JSON.stringify(body));
}

describe('exchange home zones', () => {
  it("takes a zone of the region's platform network, and leaves or clears it", () => {
    expect(homeZone('us-east-2', 'use2-az2')).toBe('use2-az2');
    expect(homeZone('us-east-2', 'use2-az1')).toBe('use2-az1');
    expect(homeZone('us-east-2', undefined)).toBeUndefined();
    expect(homeZone('us-east-2', null)).toBeNull();
  });

  it('refuses a zone of another region, one outside the platform network, a zone name, and a region with no network', () => {
    expect(() => homeZone('us-east-2', 'use1-az2')).toThrow(ValidationError);
    expect(() => homeZone('us-east-2', 'use2-az3')).toThrow(/not a zone of us-east-2's platform network/);
    expect(() => homeZone('us-east-2', 'us-east-2b')).toThrow(ValidationError);
    expect(() => homeZone('eu-west-2', 'euw2-az1')).toThrow(/eu-west-2 has no platform network/);
  });

  it('stores a home zone on create, and none when the body has none', () => {
    const handler = new ExchangeHandler();
    const created = handler.generateInsertQuery(JSON.stringify(
      { exchangeCode: 'KALSHI', exchangeName: 'Kalshi', region: 'us-east-2', homeZoneId: 'use2-az2' }));
    expect(created.text).toContain('home_zone_id');
    expect(created.values).toEqual(['KALSHI', 'Kalshi', 'us-east-2', 'use2-az2']);
    const bare = handler.generateInsertQuery(JSON.stringify({ exchangeCode: 'X', exchangeName: 'X', region: 'us-east-1' }));
    expect(bare.values).toEqual(['X', 'X', 'us-east-1', null]);
    expect(() => handler.generateInsertQuery(JSON.stringify(
      { exchangeCode: 'X', exchangeName: 'X', region: 'us-east-1', homeZoneId: 'use2-az2' }))).toThrow(ValidationError);
  });

  it('changes, clears or keeps the home zone, checked against the region', () => {
    const changed = update({ homeZoneId: 'use2-az1' });
    expect(changed.text).toContain('home_zone_id =');
    expect(changed.values).toContain('use2-az1');

    const cleared = update({ homeZoneId: null });
    expect(cleared.text).toContain('home_zone_id =');
    expect(cleared.values).toContain(null);

    expect(update({ exchangeName: 'Kalshi Inc' }).text).not.toContain('home_zone_id');
    expect(() => update({ homeZoneId: 'use1-az2' })).toThrow(ValidationError);
  });

  it('drops the home zone when the exchange moves region, unless the move brings one of the new region', () => {
    const moved = update({ region: 'us-east-1' });
    expect(moved.text).toContain('home_zone_id =');
    expect(moved.values).toContain(null);

    const movedWithZone = update({ region: 'us-east-1', homeZoneId: 'use1-az2' });
    expect(movedWithZone.values).toEqual(expect.arrayContaining(['us-east-1', 'use1-az2']));
    expect(() => update({ region: 'us-east-1', homeZoneId: 'use2-az2' })).toThrow(ValidationError);

    expect(update({ region: 'us-east-2' }).text).not.toContain('home_zone_id');
  });
});
