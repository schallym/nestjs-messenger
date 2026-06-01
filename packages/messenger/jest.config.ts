import type { Config } from 'jest';

/**
 * Differentiated coverage thresholds per ADR-002 / CLAUDE.md Rule 2.
 *
 * - `global` carries the relaxed tier (95% lines / 90% branches) and applies to
 *   the NestJS integration glue: `nestjs/`, `cli/`, `handler/discovery.ts`, the
 *   `handler/index` barrel, and the package entrypoint.
 * - The per-path overrides hold the strict tier (100% everywhere) for the
 *   framework-agnostic modules and the conformance test helpers.
 */
const STRICT = { branches: 100, functions: 100, lines: 100, statements: 100 } as const;

const config: Config = {
  displayName: '@schally/nestjs-messenger',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  // Barrel files (`index.ts`) are pure re-exports with no logic; the type-aware
  // emit turns each re-export into a getter, which only skews function coverage.
  // Exclude them from measurement rather than write theater tests to access them.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/index.ts'],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov'],
  coverageThreshold: {
    global: { branches: 90, functions: 95, lines: 95, statements: 95 },
    './src/envelope/**/*.ts': STRICT,
    './src/stamps/**/*.ts': STRICT,
    './src/bus/**/*.ts': STRICT,
    './src/middleware/**/*.ts': STRICT,
    './src/transport/**/*.ts': STRICT,
    './src/retry/**/*.ts': STRICT,
    './src/serializer/**/*.ts': STRICT,
    './src/errors/**/*.ts': STRICT,
    './src/testing/**/*.ts': STRICT,
    './src/handler/registry.ts': STRICT,
  },
};

export default config;
