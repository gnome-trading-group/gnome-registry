import { ValidationError } from '../endpoints/base';

// How a venue behaves in simulation, in the shape backtest configs, session configs and the controller all write
// (gnome-simulation's config classes read it with Jackson, snake_case, the model named by `type`). Fees aren't here:
// they come from the fee schedules.

export interface ILatency {
  type: 'static' | 'lognormal' | 'maker_taker' | 'recorded';
  latency_nanos?: number;
  floor_nanos?: number;
  median_nanos?: number;
  p99_nanos?: number;
  base_nanos?: number;
  taker_delay_nanos?: number;
  maker_delay_nanos?: number;
  fallback?: ILatency;
}

export interface IQueueModel {
  type: 'optimistic' | 'risk_averse' | 'probabilistic';
  cancel_ahead_probability?: number;
}

export interface ISimulationParameters {
  network_latency: ILatency;
  order_processing_latency: ILatency;
  market_data_latency: ILatency;
  queue_model: IQueueModel;
  self_trade_prevention: 'CANCEL_INCOMING' | 'CANCEL_RESTING';
}

const LATENCY_FIELDS: Record<string, string[]> = {
  static: ['latency_nanos'],
  lognormal: ['floor_nanos', 'median_nanos', 'p99_nanos'],
  maker_taker: ['base_nanos', 'taker_delay_nanos', 'maker_delay_nanos'],
};
const QUEUE_FIELDS: Record<string, string[]> = { optimistic: [], risk_averse: [], probabilistic: ['cancel_ahead_probability'] };
const SELF_TRADE_PREVENTION = new Set(['CANCEL_INCOMING', 'CANCEL_RESTING']);
const BLOCKS = ['network_latency', 'order_processing_latency', 'market_data_latency', 'queue_model', 'self_trade_prevention'];

function object(name: string, value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(name: string, value: object, allowed: string[]): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ValidationError(`${name} has unknown fields: ${extra.join(', ')}`);
  const missing = allowed.filter((k) => !(k in value));
  if (missing.length) throw new ValidationError(`${name} is missing: ${missing.join(', ')}`);
}

function nanos(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${name} must be a whole number of nanoseconds, 0 or more`);
  }
  return value;
}

// Every field of the chosen model is required, so what is stored is exactly what runs: no model default fills a gap.
// A run's own log-normal model may pin its draws with a seed; the registry's never does, so runs keep their own.
function latency(name: string, value: unknown, allowRecorded: boolean, allowSeed = false): ILatency {
  const l = object(name, value);
  if (l.type === 'recorded') {
    if (!allowRecorded) throw new ValidationError(`${name}.type recorded applies only to market_data_latency`);
    exactKeys(name, l, ['type', 'fallback']);
    latency(`${name}.fallback`, l.fallback, false);
    return l as unknown as ILatency;
  }
  const fields = LATENCY_FIELDS[String(l.type)];
  if (!fields) {
    const types = [...Object.keys(LATENCY_FIELDS), ...(allowRecorded ? ['recorded'] : [])];
    throw new ValidationError(`${name}.type must be one of ${types.join(', ')}`);
  }
  const seeded = allowSeed && l.type === 'lognormal' && 'seed' in l;
  exactKeys(name, l, ['type', ...fields, ...(seeded ? ['seed'] : [])]);
  for (const f of fields) nanos(`${name}.${f}`, l[f]);
  if (seeded && !Number.isSafeInteger(l.seed)) throw new ValidationError(`${name}.seed must be a whole number`);
  if (l.type === 'lognormal') {
    const { floor_nanos: floor, median_nanos: median, p99_nanos: p99 } = l as Record<string, number>;
    if (!(floor < median && median < p99)) throw new ValidationError(`${name} needs floor_nanos < median_nanos < p99_nanos`);
  }
  return l as unknown as ILatency;
}

function queueModel(name: string, value: unknown): IQueueModel {
  const q = object(name, value);
  const fields = QUEUE_FIELDS[String(q.type)];
  if (!fields) throw new ValidationError(`${name}.type must be one of ${Object.keys(QUEUE_FIELDS).join(', ')}`);
  exactKeys(name, q, ['type', ...fields]);
  if (q.type === 'probabilistic') {
    const p = q.cancel_ahead_probability;
    if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new ValidationError(`${name}.cancel_ahead_probability must be within [0, 1]`);
  }
  return q as unknown as IQueueModel;
}

// The orchestrator and backtests build a venue's simulated exchange from this, so a definition they couldn't read, or
// one missing a block, must never be stored.
export function validateParameters(value: unknown): ISimulationParameters {
  const d = object('definition', value);
  exactKeys('definition', d, BLOCKS);
  latency('definition.network_latency', d.network_latency, false);
  latency('definition.order_processing_latency', d.order_processing_latency, false);
  latency('definition.market_data_latency', d.market_data_latency, true);
  queueModel('definition.queue_model', d.queue_model);
  if (!SELF_TRADE_PREVENTION.has(String(d.self_trade_prevention))) {
    throw new ValidationError(`definition.self_trade_prevention must be one of ${[...SELF_TRADE_PREVENTION].join(', ')}`);
  }
  return d as unknown as ISimulationParameters;
}

const FEE_FIELDS: Record<string, string[]> = {
  registry: [],
  static: ['taker_fee', 'maker_fee'],
  parametric: ['taker_fee_rate', 'maker_fee_rate'],
};

function feeModel(name: string, value: unknown): void {
  const f = object(name, value);
  const fields = FEE_FIELDS[String(f.type)];
  if (!fields) throw new ValidationError(`${name}.type must be one of ${Object.keys(FEE_FIELDS).join(', ')}`);
  exactKeys(name, f, ['type', ...fields]);
  for (const k of fields) {
    if (typeof f[k] !== 'number' || !Number.isFinite(f[k])) throw new ValidationError(`${name}.${k} must be a number`);
  }
}

// The blocks a run sets in place of its exchange's parameters: any of a definition's, plus fees, each complete.
export function validateOverrides(name: string, value: unknown): Partial<ISimulationParameters> {
  const o = object(name, value);
  const extra = Object.keys(o).filter((k) => k !== 'fee_model' && !BLOCKS.includes(k));
  if (extra.length) throw new ValidationError(`${name} has unknown fields: ${extra.join(', ')}`);
  if ('fee_model' in o) feeModel(`${name}.fee_model`, o.fee_model);
  if ('network_latency' in o) latency(`${name}.network_latency`, o.network_latency, false, true);
  if ('order_processing_latency' in o) latency(`${name}.order_processing_latency`, o.order_processing_latency, false, true);
  if ('market_data_latency' in o) latency(`${name}.market_data_latency`, o.market_data_latency, true, true);
  if ('queue_model' in o) queueModel(`${name}.queue_model`, o.queue_model);
  if ('self_trade_prevention' in o && !SELF_TRADE_PREVENTION.has(String(o.self_trade_prevention))) {
    throw new ValidationError(`${name}.self_trade_prevention must be one of ${[...SELF_TRADE_PREVENTION].join(', ')}`);
  }
  return o as Partial<ISimulationParameters>;
}

// What a paper session's simulated exchange needs from each layer, lowest first: the registry's parameters for its
// exchange, then the run's overrides for the exchange, then for the listing. Market data latency is a backtest's.
export const PAPER_BLOCKS = ['network_latency', 'order_processing_latency', 'queue_model', 'self_trade_prevention'];

export interface ISessionSimulation {
  as_of?: string;
  seed?: number;
  exchanges?: Record<string, Partial<ISimulationParameters>>;
  listings?: Record<string, Partial<ISimulationParameters>>;
}

// A paper session's `simulation` config value, as the orchestrator reads it (gnome-simulation SessionSimulationConfig).
export function validateSessionSimulation(value: unknown): ISessionSimulation {
  const s = object('simulation', value ?? {});
  const extra = Object.keys(s).filter((k) => !['as_of', 'seed', 'exchanges', 'listings'].includes(k));
  if (extra.length) throw new ValidationError(`simulation has unknown fields: ${extra.join(', ')}`);
  if (s.seed !== undefined && !Number.isSafeInteger(s.seed)) throw new ValidationError('simulation.seed must be a whole number');
  for (const [code, o] of Object.entries(object('simulation.exchanges', s.exchanges ?? {}))) {
    validateOverrides(`simulation.exchanges.${code}`, o);
  }
  for (const [listingId, o] of Object.entries(object('simulation.listings', s.listings ?? {}))) {
    if (!/^\d+$/.test(listingId)) throw new ValidationError(`simulation.listings keys are listing ids, not ${listingId}`);
    validateOverrides(`simulation.listings.${listingId}`, o);
  }
  return s as ISessionSimulation;
}
