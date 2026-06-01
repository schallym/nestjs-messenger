import type { Config } from 'jest';

/**
 * Coverage thresholds per ADR-002 / CLAUDE.md Rule 2: the transport implementation is
 * held to the strict tier (100%), glue/config to the relaxed tier (95% lines / 90%
 * branches). DSN parsing and the transport itself are the implementation.
 *
 * These tests run against a real Redis (the `dev:brokers` docker service, or the CI
 * Redis service) — mocking ioredis would test our mock, not the Streams behaviour.
 */
const STRICT = { branches: 100, functions: 100, lines: 100, statements: 100 } as const;

const config: Config = {
  displayName: '@schally/nestjs-messenger-transport-redis',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/index.ts'],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov'],
  testTimeout: 20_000,
  // These are integration tests against a real Redis: every transport is closed
  // (`quit()`), but ioredis keeps an internal connect/reconnect timer that can outlive
  // the suite. Force-exit rather than hang — a standard pattern for real-broker suites.
  forceExit: true,
  coverageThreshold: {
    global: { branches: 90, functions: 95, lines: 95, statements: 95 },
    './src/dsn.ts': STRICT,
    './src/error-mapping.ts': STRICT,
    './src/redis-streams.transport.ts': STRICT,
  },
};

export default config;
