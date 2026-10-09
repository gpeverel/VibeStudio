import { contextBridge } from 'electron';
import type { AppApi } from '../shared/app-api.ts';

const api: AppApi = Object.freeze({ appName: 'VibeStudio' });
contextBridge.exposeInMainWorld('api', api);
