import type { Config } from 'jest';

/**
 * Coverage thresholds per ADR-002 / CLAUDE.md Rule 2: the transport implementation is
 * held to the strict tier (100%), glue/config to the relaxed tier (95% lines / 90%
 * branches).
 *
 * These tests run against a real Pub/Sub **emulator** (the `dev:brokers` docker service,
 * or the CI emulator service) — mocking `@google-cloud/pubsub` would test our mock, not
 * Pub/Sub behaviour. `setup-emulator.ts` defaults `PUBSUB_EMULATOR_HOST` for local runs.
 */
const STRICT = { branches: 100, functions: 100, lines: 100, statements: 100 } as const;

const config: Config = {
  displayName: '@schally/nestjs-messenger-transport-google-pubsub',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['<rootDir>/test/setup-emulator.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/index.ts'],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov'],
  testTimeout: 30_000,
  // Integration tests against a real emulator; the gRPC client keeps background timers
  // that can outlive the suite even after close(). Force-exit rather than hang.
  forceExit: true,
  coverageThreshold: {
    global: { branches: 90, functions: 95, lines: 95, statements: 95 },
    './src/error-mapping.ts': STRICT,
    './src/google-pubsub.transport.ts': STRICT,
  },
};

export default config;
