import { tagKey } from '../lambda/endpoints/events';

describe('tagKey', () => {
  it('spells a tag as the classifier stores it', () => {
    expect(tagKey('Rotten-Tomatoes')).toBe('rotten tomatoes');
    expect(tagKey(' league_of-legends ')).toBe('league of legends');
    expect(tagKey('College  Football')).toBe('college football');
    expect(tagKey('s&p 500')).toBe('s&p 500');
  });
});
