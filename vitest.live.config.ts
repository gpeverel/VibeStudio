import { defineConfig } from 'vitest/config';

/** Отдельный вход. Сам сценарий требует LIVE=1; разрешение пользователя проверяется до команды. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.live.ts'],
    testTimeout: 110_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false, shuffle: false },
    retry: 0,
    bail: 1,
  },
});
