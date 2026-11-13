// SAST configuration: ESLint + eslint-plugin-security.
// High-confidence vulnerability patterns are ERRORS and fail the pipeline.
// Noisy heuristics are WARNINGS: they are reported for review but do not fail the build.
const security = require('eslint-plugin-security');

module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs' },
    plugins: { security },
    rules: {
      // --- fail the build ---
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'error',
      'security/detect-unsafe-regex': 'error',
      'security/detect-non-literal-regexp': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-bidi-characters': 'error',
      // --- report only (high false-positive rate) ---
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-possible-timing-attacks': 'warn',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script' },
  },
];
