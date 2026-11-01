import { test, expect } from './fixtures.ts';
import type {} from '../../src/renderer/env.d.ts';

test('Сессии: создание доступно после выбора проекта и подтверждения доверия', async ({ desktop }) => {
  const { page } = desktop;
  const create = page.getByRole('button', { name: 'Создать сессию', exact: true });
  const trust = page.getByRole('checkbox', { name: 'Я доверяю этому локальному проекту', exact: true });

  expect(await page.evaluate(async () => {
    const api = window.api;
    return { projects: await api.listProjects(), sessions: await api.listSessions() };
  })).toEqual({ projects: { ok: true, value: [] }, sessions: { ok: true, value: [] } });
  await expect(page.getByText('Пока нет сессий.', { exact: true })).toBeVisible();
  await expect(create).toBeDisabled();
  await expect(trust).toBeDisabled();

  await page.getByRole('button', { name: 'Выбрать проект', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Проект', exact: true }).locator('option:checked')).toHaveText('project');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(trust).toBeEnabled();
  await expect(trust).not.toBeChecked();
  await expect(create).toBeDisabled();

  await trust.check();
  await expect(trust).toBeChecked();
  await expect(create).toBeEnabled();
});
