import { readFileSync } from 'fs';
import { join } from 'path';
import { FeeCalculator, newOrderFeeState } from '../lambda/fees/calculator';
import { validateDefinition } from '../lambda/fees/definition';

// The cases the Java FeeSchedule (FeeVectorsTest) and gnomepy's fees.py also reproduce.
const VECTORS = JSON.parse(readFileSync(join(__dirname, '..', '..', 'src', 'test', 'resources', 'fee-vectors.json'), 'utf8'));

interface IFill { buy: boolean; price: number; qty: number; maker: boolean; fee: number }
interface ICase { name: string; definition: unknown; sharedOrderState: boolean; fills: IFill[] }

describe('FeeCalculator', () => {
  it.each((VECTORS.cases as ICase[]).map((c): [string, ICase] => [c.name, c]))('%s', (_name, c) => {
    const calculator = new FeeCalculator(validateDefinition(c.definition));
    const order = newOrderFeeState();
    for (const fill of c.fills) {
      const fee = calculator.fee(fill.buy, BigInt(fill.price), BigInt(fill.qty), fill.maker,
        c.sharedOrderState ? order : undefined);
      expect([fill, fee]).toEqual([fill, BigInt(fill.fee)]);
    }
  });
});
