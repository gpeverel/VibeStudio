/**
 * Архитектурные границы из docs/SPEC.md §2.
 * shared -> ничего своего; core -> shared; adapters -> core/shared;
 * main собирает зависимости; renderer ходит в приложение только через window.api.
 */
const NPM = ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown'];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Циклические зависимости между модулями запрещены.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-is-leaf',
      severity: 'error',
      comment: 'shared содержит только DTO и схемы: без core, adapters, main, renderer.',
      from: { path: '^src/shared' },
      to: { path: '^src/(core|adapters|main|preload|renderer)' },
    },
    {
      name: 'shared-no-node-builtins',
      severity: 'error',
      comment: 'shared не использует встроенные модули Node.',
      from: { path: '^src/shared' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'shared-only-zod',
      severity: 'error',
      comment: 'Из внешних пакетов shared разрешён только zod.',
      from: { path: '^src/shared' },
      to: { dependencyTypes: NPM, pathNot: '^node_modules/zod(/|$)' },
    },
    {
      name: 'core-depends-on-shared-only',
      severity: 'error',
      comment: 'core зависит только от shared и собственных портов.',
      from: { path: '^src/core' },
      to: { path: '^src/(adapters|main|preload|renderer)' },
    },
    {
      name: 'core-no-node-builtins',
      severity: 'error',
      comment: 'Доступ к fs/process находится в адаптерах и main.',
      from: { path: '^src/core' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'core-no-npm',
      severity: 'error',
      comment: 'core не зависит от внешних пакетов (sqlite, Electron и т.д. — в адаптерах).',
      from: { path: '^src/core' },
      to: { dependencyTypes: NPM },
    },
    {
      name: 'adapters-below-main',
      severity: 'error',
      comment: 'adapters не знают о main, preload и renderer.',
      from: { path: '^src/adapters' },
      to: { path: '^src/(main|preload|renderer)' },
    },
    {
      name: 'adapters-no-electron',
      severity: 'error',
      from: { path: '^src/adapters' },
      to: { path: '^node_modules/electron(/|$)', dependencyTypes: NPM },
    },
    {
      name: 'renderer-isolated',
      severity: 'error',
      comment: 'renderer использует только shared и window.api, без core, adapters, main и Node.',
      from: { path: '^src/renderer' },
      to: { path: '^src/(core|adapters|main|preload)' },
    },
    {
      name: 'renderer-no-node-builtins',
      severity: 'error',
      from: { path: '^src/renderer' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'renderer-no-electron-or-sqlite',
      severity: 'error',
      from: { path: '^src/renderer' },
      to: { path: '^node_modules/(electron|better-sqlite3)(/|$)' },
    },
    {
      name: 'preload-narrow',
      severity: 'error',
      comment: 'preload зависит только от shared и electron.',
      from: { path: '^src/preload' },
      to: { path: '^src/(core|adapters|main|renderer)' },
    },
    {
      name: 'not-to-tests',
      severity: 'error',
      from: { path: '^src' },
      to: { path: '^tests' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Файл, который никто не импортирует (точки входа и объявления типов исключены).',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          '^src/(main|preload)/index\\.ts$',
          '^src/renderer/main\\.tsx$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
