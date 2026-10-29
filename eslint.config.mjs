import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  {
    rules: {
      // The code deliberately matches terminal escapes and control characters:
      // it sanitizes remote and on-disk text, and the tests assert on raw output.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['bin/**/*.js', 'lib/**/*.js', 'test/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    files: ['lib/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        // Defined by test/run.js.
        test: 'readonly',
      },
    },
  },
];
