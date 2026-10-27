import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'

export default [
  {
    // tz-realm.js is the page-realm engine ported verbatim from the Timezone
    // Lock userscript (MIT) — like a vendored file, it keeps its upstream
    // formatting so any future diff against the proven source stays minimal
    // and reviewable. Covered end-to-end by test/unit/tz-realm.test.js.
    ignores: ['node_modules/', '.cache/', 'dist/', 'src/tz-realm.js']
  },
  js.configs.recommended,
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: false,
    jsx: false,
    braceStyle: '1tbs',
    commaDangle: 'never'
  }),
  {
    rules: {
      '@stylistic/space-before-function-paren': ['error', 'always'],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        // Firefox background-window stdout, used by the e2e log capture
        dump: 'readonly',
        // for the CommonJS guard that lets node:test require the pure modules
        module: 'readonly'
      }
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  {
    // run as background scripts inside the e2e builds, not under node
    files: ['test/e2e/selftest.js', 'test/e2e/transition-selftest.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions }
    }
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    }
  }
]
