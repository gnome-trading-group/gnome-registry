import { parseIdList } from '../lambda/endpoints/base';
import { ListingHandler } from '../lambda/endpoints/listings';
import { SecurityHandler } from '../lambda/endpoints/securities';

describe('parseIdList', () => {
  it('keeps positive integers and drops everything else', () => {
    expect(parseIdList('3,17,42')).toEqual([3, 17, 42]);
    expect(parseIdList('3, 1.5, -2, 0, abc, 7); DROP TABLE x')).toEqual([3]);
    expect(parseIdList('')).toEqual([]);
    expect(parseIdList(undefined)).toEqual([]);
  });
});

describe('listing id-list filter', () => {
  const handler = new ListingHandler();

  it('filters to the given ids', () => {
    const query = handler.generateSelectQuery({ listingIds: '3,17' });
    expect(query.text).toContain('listing_id = ANY($1::int[])');
    expect(query.values).toEqual([[3, 17]]);
  });

  it('qualifies the column when denormalized', () => {
    expect(handler.generateSelectQuery({ listingIds: '3,17', denormalize: 'true' }).text).toContain('l.listing_id = ANY($1::int[])');
  });

  it('matches nothing rather than everything when no id is valid', () => {
    expect(handler.generateSelectQuery({ listingIds: 'abc' }).text).toContain('WHERE FALSE');
  });
});

describe('security id-list filter', () => {
  const handler = new SecurityHandler();

  it('filters to the given ids', () => {
    const query = handler.generateSelectQuery({ securityIds: '5,9' });
    expect(query.text).toContain('s.security_id = ANY($1::int[])');
    expect(query.values).toEqual([[5, 9]]);
  });

  it('matches nothing rather than everything when no id is valid', () => {
    expect(handler.generateSelectQuery({ securityIds: '' }).text).toContain('WHERE FALSE');
  });
});
