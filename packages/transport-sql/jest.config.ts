import type { Config } from 'jest';

/**
 * Coverage thresholds per ADR-002 / CLAUDE.md Rule 2: the transport implementation is
 * held to the strict tier (100%), glue/config to the relaxed tier (95% lines / 90%
 * branches).
 *
 * These tests run against a real PostgreSQL AND a real MySQL (the `dev:brokers` docker
 * services, or the CI services) — mocking the drivers would test our mock, not the
 * SKIP LOCKED / LISTEN/NOTIFY behaviour the transport is built on.
 */
const STRICT = { branches: 100, functions: 100, lines: 100, statements: 100 } as const;

const config: Config = {
  displayName: '@schally/nestjs-messenger-transport-sql',
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
  // Integration tests against real databases: every transport is closed (pools ended,
  // the LISTEN client released), but driver-internal keepalive/cleanup timers can
  // outlive the suite. Force-exit rather than hang — the repo's standard pattern for
  // real-broker suites (see transport-redis).
  forceExit: true,
  coverageThreshold: {
    global: { branches: 90, functions: 95, lines: 95, statements: 95 },
    './src/driver.ts': STRICT,
    './src/dsn.ts': STRICT,
    './src/error-mapping.ts': STRICT,
    './src/transient-retry.ts': STRICT,
    './src/sql.transport.ts': STRICT,
    './src/postgres.driver.ts': STRICT,
    './src/mysql.driver.ts': STRICT,
  },
};

export default config;
