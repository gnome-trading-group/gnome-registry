module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // `tsc` leaves gitignored .js next to every .ts; resolving .ts first keeps tests off stale compiled output.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      diagnostics: {
        // @aws-sdk/client-cloudwatch-logs is supplied by the Lambda runtime and not installed locally, so this
        // file cannot type-check here; its tests mock the module virtually.
        exclude: ['**/lambda/endpoints/strategy-session-launcher.ts'],
      },
    }],
  },
};
