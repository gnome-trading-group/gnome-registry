module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // `tsc` leaves gitignored .js next to every .ts; resolving .ts first keeps tests off stale compiled output.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  // Type-checking in every worker loads the whole program's types (about 1.8 GB each, one worker per core), which
  // exhausts a laptop's memory; jest only strips types, and `npm run build` is the type check.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }],
  },
  maxWorkers: '50%',
};
