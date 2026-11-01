import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Проверки запускают свои Node/Git/Electron: число ядер завышает допустимый параллелизм.
    // Ограничиваем конкуренцию процессов, сохраняя реальные deadline и все проверки.
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
