import type { Config } from 'jest';

/**
 * Coverage thresholds per ADR-002 / CLAUDE.md Rule 2: the transport implementation is
 * held to the strict tier (100%), glue/config to the relaxed tier (95% lines / 90%
 * branches).
 *
 * These tests run against a real Kafka broker (the `dev:brokers` docker service, or the
 * CI Kafka service) — mocking `kafkajs` would test our mock, not Kafka behaviour.
 * `setup-broker.ts` defaults `KAFKA_BROKERS` for local runs.
 */
const STRICT = { branches: 100, functions: 100, lines: 100, statements: 100 } as const;

const config: Config = {
  displayName: '@schally/nestjs-messenger-transport-kafka',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['<rootDir>/test/setup-broker.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/index.ts'],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov'],
  // Kafka is slow: consumer-group coordination on each fresh transport adds latency.
  testTimeout: 60_000,
  // The kafkajs client keeps background reconnect timers that can outlive the suite even
  // after disconnect(); force-exit rather than hang.
  forceExit: true,
  coverageThreshold: {
    global: { branches: 90, functions: 95, lines: 95, statements: 95 },
    './src/error-mapping.ts': STRICT,
    './src/kafka.transport.ts': STRICT,
  },
};

export default config;
