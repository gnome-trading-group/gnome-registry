import { ValidationError } from '../lambda/endpoints/base';
import { validateOverrides, validateParameters, validateSessionSimulation } from '../lambda/simulation/parameters';
import { SimulationParametersHandler } from '../lambda/endpoints/simulation-parameters';

function valid(): Record<string, any> {
  return {
    network_latency: { type: 'lognormal', floor_nanos: 5_000_000, median_nanos: 12_000_000, p99_nanos: 200_000_000 },
    order_processing_latency: { type: 'maker_taker', base_nanos: 5_000_000, taker_delay_nanos: 250_000_000, maker_delay_nanos: 0 },
    market_data_latency: { type: 'recorded', fallback: { type: 'static', latency_nanos: 50_000_000 } },
    queue_model: { type: 'risk_averse' },
    self_trade_prevention: 'CANCEL_INCOMING',
  };
}

function refused(change: (d: Record<string, any>) => void): string {
  const d = valid();
  change(d);
  try {
    validateParameters(d);
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as Error).message;
  }
  throw new Error('accepted');
}

describe('validateParameters', () => {
  it('accepts a complete definition', () => {
    expect(validateParameters(valid())).toEqual(valid());
    const probabilistic = { ...valid(), queue_model: { type: 'probabilistic', cancel_ahead_probability: 0.3 } };
    expect(validateParameters(probabilistic).queue_model.cancel_ahead_probability).toBe(0.3);
  });

  // A stored row is the whole of what a venue simulates with, so nothing may be left to a model's built-in default.
  it('needs every block and every field of the chosen model', () => {
    expect(refused((d) => delete d.queue_model)).toContain('missing: queue_model');
    expect(refused((d) => delete d.network_latency.p99_nanos)).toContain('missing: p99_nanos');
    expect(refused((d) => { d.queue_model = { type: 'probabilistic' }; })).toContain('cancel_ahead_probability');
  });

  it('refuses what consumers could not read', () => {
    expect(refused((d) => { d.fee_model = { type: 'registry' }; })).toContain('unknown fields: fee_model');
    expect(refused((d) => { d.network_latency.seed = 1; })).toContain('unknown fields: seed');
    expect(refused((d) => { d.network_latency.type = 'gaussian'; })).toContain('must be one of');
    expect(refused((d) => { d.order_processing_latency.base_nanos = 1.5; })).toContain('whole number');
    expect(refused((d) => { d.order_processing_latency.base_nanos = -1; })).toContain('whole number');
    expect(refused((d) => { d.self_trade_prevention = 'NONE'; })).toContain('self_trade_prevention');
    expect(refused((d) => { d.queue_model = { type: 'probabilistic', cancel_ahead_probability: 1.5 }; })).toContain('[0, 1]');
  });

  it('keeps recorded latency to market data, with a model fallback', () => {
    expect(refused((d) => { d.network_latency = { type: 'recorded', fallback: { type: 'static', latency_nanos: 1 } }; }))
      .toContain('applies only to market_data_latency');
    expect(refused((d) => { d.market_data_latency.fallback = { type: 'recorded' }; })).toContain('applies only to market_data_latency');
  });

  it('needs a log-normal ordered floor < median < p99', () => {
    expect(refused((d) => { d.network_latency.median_nanos = d.network_latency.p99_nanos; })).toContain('floor_nanos < median_nanos < p99_nanos');
  });
});

describe('SimulationParametersHandler', () => {
  const handler = new SimulationParametersHandler();

  it('reads the parameters in force per exchange at a pinned time', () => {
    const query = handler.generateSelectQuery({ knownAsOf: '2026-10-01T00:00:00Z', exchangeId: '3' });
    expect(query.text).toContain('DISTINCT ON (exchange_id)');
    expect(query.text).toContain('WHERE recorded_at <= $1::timestamptz AND exchange_id = $2');
    expect(query.values).toEqual(['2026-10-01T00:00:00.000Z', 3]);
  });

  it('lists the history newest first', () => {
    expect(handler.generateSelectQuery({ history: 'true' }).text).toContain('ORDER BY recorded_at DESC');
  });

  it('validates what it stores, and never changes or deletes a row', () => {
    expect(() => handler.generateInsertQuery(JSON.stringify({ exchangeId: 1, definition: { queue_model: {} } }))).toThrow(ValidationError);
    expect(handler.generateInsertQuery(JSON.stringify({ exchangeId: 1, definition: valid(), note: " it's measured " })).values)
      .toContain("it's measured");
    expect(() => handler.generateDeleteQuery('{}')).toThrow('append-only');
    expect(() => handler.generateModifyQuery({}, '{}')).toThrow('append-only');
  });
});

describe('validateOverrides', () => {
  it('takes any blocks, fees too, and lets a run pin its own log-normal draws', () => {
    expect(validateOverrides('o', {
      fee_model: { type: 'parametric', taker_fee_rate: 0.07, maker_fee_rate: 0 },
      network_latency: { type: 'lognormal', floor_nanos: 1, median_nanos: 2, p99_nanos: 3, seed: 9 },
    })).toBeTruthy();
    expect(validateOverrides('o', { fee_model: { type: 'registry' } })).toBeTruthy();
  });

  it('holds each block it does set to the rules a stored one meets', () => {
    expect(() => validateOverrides('o', { fee_model: { type: 'static', taker_fee: 0.01 } })).toThrow('missing: maker_fee');
    expect(() => validateOverrides('o', { profiles: {} })).toThrow('unknown fields: profiles');
    expect(() => validateOverrides('o', { queue_model: { type: 'probabilistic', cancel_ahead_probability: 2 } })).toThrow('[0, 1]');
  });
});

describe('validateSessionSimulation', () => {
  it('reads a session simulation, all of it optional', () => {
    expect(validateSessionSimulation(undefined)).toEqual({});
    expect(validateSessionSimulation({ seed: 1, exchanges: { KALSHI: {} }, listings: { 5: {} } })).toBeTruthy();
  });

  it('refuses what the orchestrator would not read', () => {
    expect(() => validateSessionSimulation({ profiles: {} })).toThrow('unknown fields: profiles');
    expect(() => validateSessionSimulation({ listings: { abc: {} } })).toThrow('listing ids');
    expect(() => validateSessionSimulation({ seed: 1.5 })).toThrow('whole number');
  });
});
