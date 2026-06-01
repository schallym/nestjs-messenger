import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import importPlugin from 'eslint-plugin-import';
import unicorn from 'eslint-plugin-unicorn';
import promise from 'eslint-plugin-promise';
import prettier from 'eslint-config-prettier';

/**
 * Boundary elements per ADR-001. The order is significant: eslint-plugin-boundaries
 * assigns the FIRST matching element to a file, so the specific files
 * (handler/registry.ts, handler/discovery.ts) come before the broad globs.
 */
const boundaryElements = [
  { type: 'entrypoint', mode: 'full', pattern: 'packages/messenger/src/index.ts' },
  {
    type: 'nestjs-integration',
    mode: 'full',
    pattern: 'packages/messenger/src/handler/discovery.ts',
  },
  {
    type: 'framework-agnostic',
    mode: 'full',
    pattern: 'packages/messenger/src/handler/registry.ts',
  },
  { type: 'cli', mode: 'full', pattern: 'packages/messenger/src/cli/**/*' },
  { type: 'nestjs-integration', mode: 'full', pattern: 'packages/messenger/src/nestjs/**/*' },
  {
    type: 'framework-agnostic',
    mode: 'full',
    pattern: [
      'packages/messenger/src/envelope/**/*',
      'packages/messenger/src/stamps/**/*',
      'packages/messenger/src/bus/**/*',
      'packages/messenger/src/middleware/**/*',
      'packages/messenger/src/transport/**/*',
      'packages/messenger/src/retry/**/*',
      'packages/messenger/src/serializer/**/*',
      'packages/messenger/src/errors/**/*',
      'packages/messenger/src/testing/**/*',
    ],
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.tsbuildinfo',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  unicorn.configs['flat/recommended'],
  promise.configs['flat/recommended'],

  // Project-wide language + resolver settings.
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import/resolver': {
        typescript: { project: ['./tsconfig.eslint.json'] },
      },
    },
  },

  // The non-negotiable engineering rules (CLAUDE.md Rule 9), applied to source.
  {
    files: ['**/*.ts', '**/*.mjs', '**/*.cjs'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Enums are banned. Use an `as const` object or a string-literal union.',
        },
      ],
      complexity: ['error', 10],
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],

      // Marker interfaces (à la Symfony's StampInterface) are a deliberate pattern
      // here; still forbid the `{}` object-type literal everywhere else.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],

      // NestJS modules are decorated classes with only static factory methods
      // (`forRoot`/`forRootAsync`); allow the framework pattern, still flag plain ones.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],

      'import/no-default-export': 'error',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      // prevent-abbreviations is more noise than signal for a queue library
      // whose vocabulary is full of legitimate short names (env, args, msg, fn).
      'unicorn/prevent-abbreviations': 'off',
    },
  },

  // Boundary enforcement (ADR-001 / CLAUDE.md Rule 1). Scoped to the single
  // main package whose internal modules carry the architecture.
  {
    files: ['packages/messenger/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['packages/messenger/src/**/*'],
      'boundaries/elements': boundaryElements,
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: ['framework-agnostic'], allow: ['framework-agnostic'] },
            {
              from: ['nestjs-integration'],
              allow: ['framework-agnostic', 'nestjs-integration'],
            },
            { from: ['cli'], allow: ['framework-agnostic', 'nestjs-integration', 'cli'] },
            {
              from: ['entrypoint'],
              allow: ['framework-agnostic', 'nestjs-integration', 'cli', 'entrypoint'],
            },
          ],
        },
      ],
    },
  },

  // Tests: same strictness, minus the export-surface rules that only make
  // sense for shipped source, and allowing payload-free marker message classes.
  {
    files: ['**/*.spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },

  // Tooling/config files: not part of the shipped library, so they may use
  // default exports and don't need type-aware linting.
  {
    files: ['**/*.config.{ts,js,mjs,cjs}', '**/jest.config.ts', 'eslint.config.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'import/no-default-export': 'off',
      // The typescript-eslint default export legitimately also carries a `configs`
      // named export; our `tseslint.configs.*` usage here is intentional.
      'import/no-named-as-default-member': 'off',
    },
  },

  prettier,
);
