import { StrategyHandler } from '../lambda/endpoints/strategies';

const handler = new StrategyHandler();

describe('strategy archiving', () => {
  it('filters by archived', () => {
    for (const [param, value] of [['false', false], ['true', true], ['True', true]] as const) {
      const query = handler.generateSelectQuery({ archived: param });
      expect(query.text).toContain('archived = $1');
      expect(query.values).toEqual([value]);
    }
  });

  it('ignores anything but true/false', () => {
    expect(handler.generateSelectQuery({ archived: '1 OR 1=1' }).text).not.toContain('archived');
  });

  it('creates strategies unarchived unless asked', () => {
    expect(handler.generateInsertQuery(JSON.stringify({ name: 'mm' })).values).toEqual(['mm', null, false, null, 1]);
    expect(handler.generateInsertQuery(JSON.stringify({ name: 'mm', archived: true })).values)
      .toEqual(['mm', null, true, null, 1]);
  });

  it('archives and unarchives on update', () => {
    const archive = handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ archived: true }));
    expect(archive.text).toContain('archived = $1');
    expect(archive.values).toEqual([true, 7]);
    expect(handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ archived: false })).values).toEqual([false, 7]);
    expect(handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ archived: 'yes' })).text).not.toContain('archived');
  });
});

describe('strategy status removal', () => {
  it('no longer reads or writes a status column', () => {
    expect(handler.generateSelectQuery({ status: '1' } as never).text).not.toContain('status');
    expect(handler.generateInsertQuery(JSON.stringify({ name: 'mm', status: 1 })).text).not.toContain('status');
    expect(handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ status: 1, name: 'x' })).text).not.toContain('status');
  });
});

describe('strategy rate weight', () => {
  it('defaults to 1 and takes a positive integer', () => {
    expect(handler.generateInsertQuery(JSON.stringify({ name: 'mm', rateWeight: 3 })).values).toEqual(['mm', null, false, null, 3]);
    const update = handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ rateWeight: 2 }));
    expect(update.text).toContain('rate_weight = $1');
    expect(update.values).toEqual([2, 7]);
    expect(handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ name: 'x' })).text).not.toContain('rate_weight');
  });

  it('refuses anything but a positive integer', () => {
    for (const bad of [0, -1, 1.5, '2']) {
      expect(() => handler.generateInsertQuery(JSON.stringify({ name: 'mm', rateWeight: bad }))).toThrow('rateWeight');
      expect(() => handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ rateWeight: bad }))).toThrow('rateWeight');
    }
  });
});
