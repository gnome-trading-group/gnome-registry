import { StrategyHandler } from '../lambda/endpoints/strategies';

const handler = new StrategyHandler();

describe('strategy archiving', () => {
  it('filters by archived', () => {
    expect(handler.generateSelectQuery({ archived: 'false' })).toContain('AND archived=false');
    expect(handler.generateSelectQuery({ archived: 'true' })).toContain('AND archived=true');
    expect(handler.generateSelectQuery({ archived: 'True' })).toContain('AND archived=true');
  });

  it('ignores anything but true/false so nothing else reaches the SQL', () => {
    expect(handler.generateSelectQuery({ archived: '1 OR 1=1' })).not.toContain('archived');
  });

  it('creates strategies unarchived unless asked', () => {
    expect(handler.generateInsertQuery(JSON.stringify({ name: 'mm' }))).toContain("'mm', null, false,");
    expect(handler.generateInsertQuery(JSON.stringify({ name: 'mm', archived: true }))).toContain("'mm', null, true,");
  });

  it('archives and unarchives on update', () => {
    expect(handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ archived: true }))).toContain('archived=true');
    expect(handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ archived: false }))).toContain('archived=false');
    expect(handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ archived: 'yes' }))).not.toContain('archived');
  });
});

describe('strategy status removal', () => {
  it('no longer reads or writes a status column', () => {
    expect(handler.generateSelectQuery({ status: '1' } as never)).not.toContain('status');
    expect(handler.generateInsertQuery(JSON.stringify({ name: 'mm', status: 1 }))).not.toContain('status');
    expect(handler.generateModifyQuery({ strategy_id: 7 }, JSON.stringify({ status: 1, name: 'x' }))).not.toContain('status');
  });
});
