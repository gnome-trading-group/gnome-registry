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
    expect(handler.generateSelectQuery({ listingIds: '3,17' })).toContain('AND listing_id IN (3,17)');
  });

  it('qualifies the column when denormalized', () => {
    expect(handler.generateSelectQuery({ listingIds: '3,17', denormalize: 'true' })).toContain('AND l.listing_id IN (3,17)');
  });

  it('matches nothing rather than everything when no id is valid', () => {
    expect(handler.generateSelectQuery({ listingIds: 'abc' })).toContain('AND FALSE');
  });
});

describe('security id-list filter', () => {
  const handler = new SecurityHandler();

  it('filters to the given ids', () => {
    expect(handler.generateSelectQuery({ securityIds: '5,9' })).toContain('AND s.security_id IN (5,9)');
  });

  it('matches nothing rather than everything when no id is valid', () => {
    expect(handler.generateSelectQuery({ securityIds: '' })).toContain('AND FALSE');
  });
});
