module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
  ignorePatterns: ['dist/**'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      // Test suite ported verbatim from vp's src/utils/monitor/__tests__/
      // (Ticket 04 — move, not rewrite). vp's own test suite never enforced
      // no-explicit-any/ban-ts-comment; re-litigating every `any` here would
      // turn a move into a rewrite. Production src/*.ts keeps full strictness.
      files: ['src/__tests__/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/ban-ts-comment': 'off',
      },
    },
  ],
};
