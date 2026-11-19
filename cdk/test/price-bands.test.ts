import { ValidationError } from '../lambda/endpoints/base';
import { checkGridEnd, singleBand, validatePriceBands } from '../lambda/endpoints/price-bands';

const TAPERED = [
  { start: 0, end: 100_000_000, step: 1_000_000 },
  { start: 100_000_000, end: 900_000_000, step: 10_000_000 },
  { start: 900_000_000, end: 1_000_000_000, step: 1_000_000 },
];

describe('validatePriceBands', () => {
  it('accepts a tapered binary grid, an open grid and a single band', () => {
    expect(validatePriceBands(TAPERED)).toEqual(TAPERED);
    const hyperliquid = [{ start: 0, end: 10_000_000_000_000, step: 100_000_000 }, { start: 10_000_000_000_000, end: null, step: 1_000_000_000 }];
    expect(validatePriceBands(hyperliquid)).toEqual(hyperliquid);
    expect(validatePriceBands(singleBand(10_000_000, 1_000_000_000))).toEqual([{ start: 0, end: 1_000_000_000, step: 10_000_000 }]);
  });

  it.each([
    ['not an array', { start: 0, end: null, step: 1 }],
    ['no bands', []],
    ['more than 16 bands', Array.from({ length: 17 }, (_, i) => ({ start: i * 10, end: i === 16 ? null : (i + 1) * 10, step: 10 }))],
    ['a first start above 0', [{ start: 10, end: 1_000_000_000, step: 10 }]],
    ['a gap', [{ start: 0, end: 50, step: 10 }, { start: 100, end: null, step: 10 }]],
    ['an overlap', [{ start: 0, end: 150, step: 10 }, { start: 100, end: null, step: 10 }]],
    ['an inner edge off the upper step', [{ start: 0, end: 105, step: 1 }, { start: 105, end: null, step: 10 }]],
    ['an inner edge off the lower step', [{ start: 0, end: 105, step: 10 }, { start: 105, end: null, step: 1 }]],
    ['an end off the last step', [{ start: 0, end: 1_000_000_005, step: 10 }]],
    ['an open band before the last', [{ start: 0, end: null, step: 10 }, { start: 100, end: null, step: 10 }]],
    ['a zero step', [{ start: 0, end: null, step: 0 }]],
    ['a fractional step', [{ start: 0, end: null, step: 2.5 }]],
    ['a string step', [{ start: 0, end: null, step: '10' }]],
    ['an end before its start', [{ start: 0, end: 0, step: 10 }]],
    ['a closed end off an inner step', [{ start: 0, end: 6, step: 3 }, { start: 6, end: 10, step: 2 }]],
  ])('refuses %s', (_name, bands) => {
    expect(() => validatePriceBands(bands)).toThrow(ValidationError);
  });
});

describe('checkGridEnd', () => {
  const open = [{ start: 0, end: null, step: 1 }];
  const toDollar = [{ start: 0, end: 1_000_000_000, step: 10_000_000 }];
  const toNinety = [{ start: 0, end: 900_000_000, step: 10_000_000 }];

  it('takes a binary contract ending at $1 and anything else open', () => {
    expect(() => checkGridEnd(1, toDollar, true)).not.toThrow();
    expect(() => checkGridEnd(1, TAPERED, true)).not.toThrow();
    expect(() => checkGridEnd(2, open, false)).not.toThrow();
  });

  it.each([
    ['a binary contract open', open, true, 'must end at 1000000000, not open'],
    ['a binary contract ending below $1', toNinety, true, 'must end at 1000000000, not 900000000'],
    ['an unbounded listing ending', toDollar, false, 'must end open, not at 1000000000'],
  ])('refuses %s', (_name, bands, binary, message) => {
    expect(() => checkGridEnd(7, bands, binary)).toThrow(ValidationError);
    expect(() => checkGridEnd(7, bands, binary)).toThrow(message);
  });
});
