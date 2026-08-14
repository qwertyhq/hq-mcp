import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Права ровно 0600: файл целиком состоит из секретов доступа к биллингу. */
export const ENV_FILE_MODE = 0o600;

export interface EnvEntry {
  readonly key: string;
  readonly value: string;
  /** Одна строка комментария над записью. Секретов не несёт — это про смысл, не про значение. */
  readonly comment?: string;
}

export interface EnvSection {
  readonly title: string;
  readonly entries: readonly EnvEntry[];
}

/**
 * Разбор `.env` СОВПАДАЕТ с тем, что делает сам сервер (`loadDotEnv` в
 * apps/stdio): срез по первому `=`, обрезка пробелов, никакого снятия кавычек.
 *
 * Совпадает намеренно. Мастер показывает человеку текущее значение и говорит
 * «оставить?» — и если бы он разбирал файл щедрее сервера, то показывал бы
 * `abc` там, где сервер прочтёт `"abc"`, то есть подтверждал бы значение,
 * которого в рантайме не будет. Пусть лучше кавычки видно, и живая проверка на
 * них честно споткнётся.
 */
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

export interface ExistingEnv {
  readonly exists: boolean;
  readonly values: Record<string, string>;
}

export function readEnvFile(path: string): ExistingEnv {
  if (!existsSync(path)) return { exists: false, values: {} };
  return { exists: true, values: parseEnvText(readFileSync(path, 'utf8')) };
}

/**
 * Значение, которое переживёт запись и чтение. Перевод строки внутри значения
 * `.env` не поддерживает никак: сервер прочтёт первую строку, а хвост — как
 * мусорную строку файла, и токен молча окажется обрезанным.
 */
export function isWritableEnvValue(value: string): boolean {
  return !/[\r\n]/.test(value);
}

/**
 * `pnpm run setup`, а не `pnpm setup`: у pnpm есть СВОЯ встроенная команда
 * `setup`, и без `run` она перехватывает вызов, правит ~/.zshrc и до этого
 * репозитория не доходит вовсе. Пропущенное слово стоит здесь не «команда не
 * найдена», а тихо выполненного чужого действия, поэтому оно есть везде, где
 * команда напечатана.
 */
const HEADER = [
  '# hq-mcp configuration, written by `pnpm run setup`.',
  '#',
  '# Mode 0600 and gitignored: every line below is a live credential of a',
  '# production billing and panel. If one leaks, rotate it — a commit will not',
  '# take it back.',
  '#',
  '# Re-run `pnpm run setup` to change anything; it backs this file up first.',
];

export function renderEnvFile(sections: readonly EnvSection[], writtenAt: Date): string {
  const lines = [...HEADER, `# Written: ${writtenAt.toISOString()}`];
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    lines.push('', `# ─── ${section.title} ───`);
    for (const entry of section.entries) {
      if (entry.comment !== undefined) lines.push(`# ${entry.comment}`);
      lines.push(`${entry.key}=${entry.value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** `/x/.env` → `/x/.env.backup-20260813-125500`; `.env.*` уже в .gitignore. */
export function backupPathFor(path: string, now: Date, attempt = 0): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
  return attempt === 0
    ? `${path}.backup-${stamp}`
    : `${path}.backup-${stamp}-${String(attempt)}`;
}

/**
 * Копия ПЕРЕД записью, и с теми же правами 0600.
 *
 * Не «на всякий случай»: перезапись `.env` — единственное необратимое действие
 * мастера, а внутри лежит то, чего нигде больше нет — пароль, который человек
 * когда-то ввёл один раз. Резервная копия делается копированием, а не
 * переименованием: переименование рвёт bind-mount, если файл во что-нибудь
 * смонтирован, и мы уже наступали на это в соседнем проекте.
 */
export function backupEnvFile(path: string, now: Date): string | null {
  if (!existsSync(path)) return null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = backupPathFor(path, now, attempt);
    if (existsSync(target)) continue;
    copyFileSync(path, target);
    chmodSync(target, ENV_FILE_MODE);
    return target;
  }
  throw new Error(`could not pick a free backup name next to ${path}`);
}

/**
 * chmod ОТДЕЛЬНОЙ строкой не избыточен: `mode` в writeFileSync действует
 * только при СОЗДАНИИ файла. Перезапись уже существующего `.env`, который
 * когда-то создали руками с правами 0644, оставила бы их такими же — и мастер
 * отчитался бы про 0600, не сделав их.
 */
export function writeEnvFile(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: ENV_FILE_MODE });
  chmodSync(path, ENV_FILE_MODE);
}
