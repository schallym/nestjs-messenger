import type { Config } from 'jest';

/**
 * E2E runner. Runs in band against the shared brokers from docker-compose.yml.
 * E2E does NOT contribute to coverage (ADR-002), so coverage is never collected
 * here. Scenarios land from M3 onward (see docs/ROADMAP.md and the e2e-testing skill).
 */
const config: Config = {
  displayName: 'e2e',
  rootDir: '.',
  roots: ['<rootDir>/scenarios'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/scenarios/**/*.e2e-spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  testTimeout: 30_000,
  // Real broker SDKs (ioredis, the Pub/Sub gRPC client) keep background reconnect timers
  // that can outlive the suite even after close(); force-exit rather than hang CI.
  forceExit: true,
};

export default config;
