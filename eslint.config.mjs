import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'release/**', 'coverage/**', '.tmp/**', '.cache/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}', '*.ts', 'src/{main,preload,adapters}/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
);
