import { randomInt } from 'crypto';

// Venue account labels, e.g. sleepy-otter-42: easy to say and remember, and saying nothing about what trades on an
// account. The words are deliberately free of anything financial, strategic or venue-related.
const ADJECTIVES = [
  'amber', 'bold', 'brave', 'breezy', 'bright', 'brisk', 'bubbly', 'calm', 'cheeky', 'chilly', 'clever', 'cosmic',
  'cozy', 'crafty', 'crispy', 'curious', 'dandy', 'dapper', 'daring', 'dizzy', 'dusty', 'eager', 'electric', 'fancy',
  'fearless', 'feisty', 'fizzy', 'fluffy', 'frosty', 'funky', 'fuzzy', 'gentle', 'giddy', 'glossy', 'goofy', 'grumpy',
  'happy', 'hasty', 'hazy', 'hungry', 'icy', 'jazzy', 'jolly', 'jumpy', 'keen', 'lazy', 'lucky', 'mellow', 'mighty',
  'misty', 'nimble', 'noble', 'odd', 'peppy', 'plucky', 'polite', 'proud', 'quiet', 'quirky', 'rapid', 'rowdy',
  'rusty', 'salty', 'sassy', 'shiny', 'silly', 'sleepy', 'sly', 'smug', 'snappy', 'sneaky', 'snowy', 'sparky',
  'speedy', 'spicy', 'spooky', 'steady', 'stormy', 'sunny', 'swift', 'tidy', 'tiny', 'toasty', 'turbo', 'vivid',
  'wacky', 'wild', 'witty', 'wobbly', 'zany', 'zesty',
];

const NOUNS = [
  'alpaca', 'badger', 'beaver', 'bison', 'bobcat', 'capybara', 'cheetah', 'cobra', 'corgi', 'cougar', 'coyote',
  'crane', 'cricket', 'dingo', 'dolphin', 'donkey', 'eagle', 'falcon', 'ferret', 'flamingo', 'gecko', 'gibbon',
  'gopher', 'heron', 'hippo', 'hornet', 'husky', 'ibex', 'iguana', 'jackal', 'jaguar', 'koala', 'lemur', 'llama',
  'lobster', 'lynx', 'magpie', 'mantis', 'marmot', 'meerkat', 'mongoose', 'moose', 'narwhal', 'newt', 'ocelot',
  'octopus', 'orca', 'osprey', 'otter', 'owl', 'panda', 'pangolin', 'parrot', 'pelican', 'penguin', 'pigeon',
  'platypus', 'possum', 'puffin', 'puma', 'quokka', 'rabbit', 'raccoon', 'raven', 'salamander', 'seal', 'shark',
  'sloth', 'squid', 'stork', 'tapir', 'toucan', 'turtle', 'viper', 'walrus', 'weasel', 'wombat', 'yak', 'zebra',
];

export const LABEL_PATTERN = /^[a-z]+-[a-z]+-[0-9]{2}$/;

export function isLabel(value: unknown): value is string {
  return typeof value === 'string' && LABEL_PATTERN.test(value);
}

export function gamertag(): string {
  const number = String(randomInt(100)).padStart(2, '0');
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}-${number}`;
}
