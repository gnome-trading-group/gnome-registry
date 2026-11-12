import { ValidationError } from '../endpoints/base';

// Each venue scores its program by its own terms; the scorers (Java, Python) read them from the stored definition,
// so a definition they couldn't read must never be stored.
//   KALSHI             targetSize (contracts per side a snapshot needs), discountFactor (per tick behind the
//                      reference price, in (0, 1])
//   POLYMARKET_INTL    minSize (shares an order needs to score), maxSpreadCents (from the adjusted midpoint), asset
//                      (the token it pays in). The venue lists some markets at a zero spread and size and $0.001 a
//                      day, which no order can earn; they're kept as listed.

function positive(name: string, value: unknown, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new ValidationError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} number`);
  }
  return value;
}

function exactKeys(name: string, value: object, allowed: string[]): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ValidationError(`${name} has unknown fields: ${extra.join(', ')}`);
}

const VALIDATORS: Record<string, (d: Record<string, unknown>) => void> = {
  KALSHI: (d) => {
    exactKeys('definition', d, ['targetSize', 'discountFactor']);
    positive('definition.targetSize', d.targetSize);
    if (positive('definition.discountFactor', d.discountFactor) > 1) {
      throw new ValidationError('definition.discountFactor must be at most 1');
    }
  },
  POLYMARKET_INTL: (d) => {
    exactKeys('definition', d, ['minSize', 'maxSpreadCents', 'asset']);
    positive('definition.minSize', d.minSize, true);
    positive('definition.maxSpreadCents', d.maxSpreadCents, true);
    if (typeof d.asset !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(d.asset)) {
      throw new ValidationError('definition.asset must be a token address');
    }
  },
};

export function validateIncentiveDefinition(exchangeCode: string, value: unknown): Record<string, unknown> {
  const validate = VALIDATORS[exchangeCode];
  if (!validate) throw new ValidationError(`${exchangeCode} has no incentive programs`);
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('definition must be an object');
  }
  validate(value as Record<string, unknown>);
  return value as Record<string, unknown>;
}
