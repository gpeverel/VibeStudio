import { expect, it } from 'vitest';
import { isTrustedIpcSource } from '../../src/main/ipc.ts';

it('доверяет только объектам главного окна и mainFrame с точным текущим URL', () => {
  const url = 'file:///own/app/renderer/index.html', sender = {}, frame = { url };
  const expected = { sender, mainFrame: frame, url, currentUrl: url };
  expect(isTrustedIpcSource({ sender, senderFrame: frame }, expected)).toBe(true);
  // Копия полей, iframe и соседнее webContents не эквивалентны объектам Electron.
  expect(isTrustedIpcSource({ sender: {}, senderFrame: frame }, expected)).toBe(false);
  expect(isTrustedIpcSource({ sender, senderFrame: { url } }, expected)).toBe(false);
  expect(isTrustedIpcSource({ sender, senderFrame: null }, expected)).toBe(false);
  expect(isTrustedIpcSource({ sender, senderFrame: frame }, { ...expected, currentUrl: `${url}?injected` })).toBe(false);
  frame.url = 'https://untrusted.invalid/';
  expect(isTrustedIpcSource({ sender, senderFrame: frame }, expected)).toBe(false);
  expect(isTrustedIpcSource(null, expected)).toBe(false);
  expect(isTrustedIpcSource({ sender, senderFrame: frame }, { ...expected, url: '', currentUrl: '' })).toBe(false);
});
