import type { AppApi } from '../shared/app-api.ts';

declare global {
  interface Window {
    readonly api: AppApi;
  }
}
