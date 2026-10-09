import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

// При отсутствии выделенного порта ОС выбирает свободный, без 3000/5173.
const rawPort = process.env.VIBEFORGE_SESSION_PORT ?? process.env.PORT;
const port = rawPort === undefined ? 0 : Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT должен быть целым числом от 0 до 65535.');
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts'),
        output: { format: 'es', entryFileNames: 'index.js' },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    // JSX без inline-предзагрузки React Refresh: CSP остаётся строгой и в dev.
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port, strictPort: true },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
