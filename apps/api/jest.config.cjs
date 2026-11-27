/** @type {import('jest').Config} */
module.exports = {
  rootDir: '../..',
  roots: ['<rootDir>/apps/api'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/apps/api/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/apps/api/tsconfig.json',
        isolatedModules: false,
      },
    ],
  },
  moduleNameMapper: {
    '^@logbook/shared$': '<rootDir>/packages/shared/dist/index.js',
  },
  // PGlite applies the full SQL migration chain twice in db.spec; under CI load
  // the default 30s timeout is too tight.
  testTimeout: 120000,
};
