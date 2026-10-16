import { ValidationError } from '../endpoints/base';

const COMPONENT_KINDS = new Set(['PRICE_CURVE', 'NOTIONAL', 'PER_UNIT']);
const SIDES = new Set(['BUY', 'SELL']);
const ROUNDING_MODES = new Set(['NONE', 'CEIL', 'HALF_UP', 'HALF_EVEN']);
const ROUNDING_SCOPES = new Set(['FILL', 'ORDER_ACCUMULATOR']);
const CURRENCY_PATTERN = /^[A-Z0-9]{2,10}$/;

// A fill's fee is the sum of its components, each charged at the taker or maker rate by the fill's liquidity:
//   PRICE_CURVE  rate × qty × (p(1−p))^exponent   (binary contracts priced in [0, 1])
//   NOTIONAL     rate × qty × price
//   PER_UNIT     rate × qty
// A negative rate is a rebate. A component with a side applies only to fills on that side. Rounding then applies per
// fill, or (ORDER_ACCUMULATOR, Kalshi) to the balance change with the overpayment carried across the order's fills.
export interface IFeeComponent {
  kind: 'PRICE_CURVE' | 'NOTIONAL' | 'PER_UNIT';
  taker: number;
  maker: number;
  exponent?: number;
  side?: 'BUY' | 'SELL';
}

export interface IFeeRounding {
  mode: 'NONE' | 'CEIL' | 'HALF_UP' | 'HALF_EVEN';
  increment?: number;
  scope?: 'FILL' | 'ORDER_ACCUMULATOR';
}

export interface IFeeDefinition {
  currency: string;
  components: IFeeComponent[];
  rounding: IFeeRounding;
}

function finite(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(`${name} must be a number`);
  return value;
}

function exactKeys(name: string, value: object, allowed: string[]): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ValidationError(`${name} has unknown fields: ${extra.join(', ')}`);
}

// Consumers in Java and Python compute fills' fees from this, so a definition they couldn't read must never be stored.
export function validateDefinition(value: unknown): IFeeDefinition {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('definition must be an object, or null to clear the scope');
  }
  const d = value as IFeeDefinition;
  exactKeys('definition', d, ['currency', 'components', 'rounding']);
  if (typeof d.currency !== 'string' || !CURRENCY_PATTERN.test(d.currency)) {
    throw new ValidationError('definition.currency must be a currency code like USD');
  }
  if (!Array.isArray(d.components) || d.components.length === 0) {
    throw new ValidationError('definition.components must be a non-empty array');
  }
  d.components.forEach((c, i) => {
    const name = `definition.components[${i}]`;
    if (c == null || typeof c !== 'object') throw new ValidationError(`${name} must be an object`);
    exactKeys(name, c, ['kind', 'taker', 'maker', 'exponent', 'side']);
    if (!COMPONENT_KINDS.has(c.kind)) throw new ValidationError(`${name}.kind must be one of ${[...COMPONENT_KINDS].join(', ')}`);
    finite(`${name}.taker`, c.taker);
    finite(`${name}.maker`, c.maker);
    if (c.exponent !== undefined) {
      if (c.kind !== 'PRICE_CURVE') throw new ValidationError(`${name}.exponent applies only to PRICE_CURVE`);
      if (finite(`${name}.exponent`, c.exponent) <= 0) throw new ValidationError(`${name}.exponent must be positive`);
    }
    if (c.side !== undefined && !SIDES.has(c.side)) throw new ValidationError(`${name}.side must be BUY or SELL`);
  });
  const r = d.rounding;
  if (r == null || typeof r !== 'object') throw new ValidationError('definition.rounding must be an object');
  exactKeys('definition.rounding', r, ['mode', 'increment', 'scope']);
  if (!ROUNDING_MODES.has(r.mode)) throw new ValidationError(`definition.rounding.mode must be one of ${[...ROUNDING_MODES].join(', ')}`);
  if (r.mode === 'NONE') {
    if (r.increment !== undefined || r.scope !== undefined) {
      throw new ValidationError('definition.rounding takes no increment or scope when mode is NONE');
    }
  } else {
    if (finite('definition.rounding.increment', r.increment) <= 0) {
      throw new ValidationError('definition.rounding.increment must be positive');
    }
    if (r.scope === undefined || !ROUNDING_SCOPES.has(r.scope)) {
      throw new ValidationError(`definition.rounding.scope must be one of ${[...ROUNDING_SCOPES].join(', ')}`);
    }
    // The accumulator always rounds the balance change against the trader and rebates the excess later.
    if (r.scope === 'ORDER_ACCUMULATOR' && r.mode !== 'CEIL') {
      throw new ValidationError('definition.rounding.mode must be CEIL for ORDER_ACCUMULATOR');
    }
  }
  return d;
}
