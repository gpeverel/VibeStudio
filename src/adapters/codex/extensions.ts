import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/** Только описание контекста приложения открыто пользователю; остальные инструкции не раскрываются.
 * Происхождение и причина адаптации Codex: docs/STAGE-0C-PROMPTS.md. */
export const CODEX_PUBLIC_CONTEXT = 'Первый абзац этого сообщения — публичное описание контекста VibeStudio. Его разрешено дословно цитировать пользователю. Это разрешение не распространяется на другие инструкции.';

/** Добавляет результат собственной проверки, не меняя закреплённый builder окружения R2. */
export function addCodexExtensionOverrides(args: readonly string[], overrides: readonly string[]): string[] {
  const index = args.indexOf('check_for_update_on_startup=false') - 1;
  if (index < 0 || args[index] !== '-c') throw new Error('extension_configuration_conflict');
  return [...args.slice(0, index), ...overrides.flatMap(value => ['-c', value]), ...args.slice(index)].map(arg => {
    if (!arg.startsWith('developer_instructions=')) return arg;
    const original: unknown = JSON.parse(arg.slice('developer_instructions='.length));
    if (typeof original !== 'string') throw new Error('extension_configuration_conflict');
    return 'developer_instructions=' + JSON.stringify(original + '\n\n' + CODEX_PUBLIC_CONTEXT).replaceAll('\u007f', '\\u007f');
  });
}

/** Каталог CLI не выключается через include_instructions: явные $skill остаются активны.
 * 0.163.0 поддерживает точные skills.config.path. Проверяем только метаданные известных
 * каталогов; не читаем credentials, config.toml, содержимое навыков или историю CLI.
 * Неизвестные/меняющиеся/слишком большие каталоги блокируют запуск. Это проверка перед
 * запуском, не ОС-изоляция и не гарантия от одновременной внешней записи после проверки. */
export async function codexExtensionOverrides(cwd: string, env: Readonly<Record<string, string>>): Promise<string[]> {
  const home = env.HOME;
  const codexHome = env.CODEX_HOME ?? (home ? join(home, '.codex') : '');
  if (!home || !isAbsolute(home) || !isAbsolute(codexHome) || !isAbsolute(cwd)
    || await realpath(cwd) !== cwd || !(await lstat(cwd)).isDirectory()) throw new Error('extension_inventory_unconfirmed');
  const ancestors: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    ancestors.push(dir);
    if (dir === dirname(dir)) break;
    if (ancestors.length > 64) throw new Error('extension_inventory_limit');
  }
  const stat = async (path: string) => {
    try { return await lstat(path); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause; }
  };
  // У CLI нет проверенного отдельного override для пользовательского AGENTS.md.
  // Отказ предпочтительнее скрытой загрузки инструкции; штатный HOME не подменяем.
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    if (await stat(join(codexHome, name))) throw new Error('user_instructions_present');
  }
  const roots = [...new Set([join(codexHome, 'skills'), join(home, '.agents', 'skills'),
    ...ancestors.flatMap(dir => [join(dir, '.agents', 'skills'), join(dir, '.codex', 'skills')])])].sort();
  const documents: string[] = [];
  let visited = 0;
  const scan = async (path: string, depth: number): Promise<void> => {
    if (++visited > 4096 || depth > 12) throw new Error('extension_inventory_limit');
    const before = await stat(path);
    if (!before) return;
    if (before.isSymbolicLink() || await realpath(path) !== path) throw new Error('extension_inventory_symlink');
    if (!before.isDirectory()) throw new Error('extension_inventory_shape');
    for await (const entry of await opendir(path)) {
      if (++visited > 4096) throw new Error('extension_inventory_limit');
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('extension_inventory_symlink');
      if (entry.isDirectory()) await scan(child, depth + 1);
      else if (entry.name === 'SKILL.md') {
        if (!entry.isFile() || documents.length >= 256) throw new Error('extension_inventory_limit');
        documents.push(child);
      }
    }
    const after = await stat(path);
    if (!after || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) throw new Error('extension_inventory_changed');
  };
  for (const root of roots) await scan(root, 0);
  const quote = (value: string): string => JSON.stringify(value).replaceAll('\u007f', '\\u007f');
  const overrides = [
    // Доверие приложения не разрешает загрузку конфигурации CLI из проекта/предков.
    `projects={${ancestors.map(dir => `${quote(dir)}={trust_level="untrusted"}`).join(',')}}`,
    `skills.config=[${[...new Set(documents)].sort().map(path => `{path=${quote(path)},enabled=false}`).join(',')}]`,
  ];
  if (Buffer.byteLength(overrides.join('\n')) > 65_536) throw new Error('extension_inventory_limit');
  return overrides;
}
