import { isWritableEnvValue } from './envfile.js';
import type { SetupIo } from './io.js';

/**
 * Один вопрос мастера. Всё, что отличает вопросы друг от друга, живёт здесь
 * данными, а не пятью почти одинаковыми функциями: у каждой из них был бы свой
 * ответ на «что делает Enter», а разные ответы на этот вопрос в одном диалоге —
 * это способ незаметно затереть значение, которое человек хотел оставить.
 */
export interface ValueSpec {
  /** Имя переменной. Печатается как есть: искать её потом человек будет по нему. */
  readonly key: string;
  readonly description: string;
  readonly example?: string;
  /** Значение из существующего `.env`. Enter оставляет его. */
  readonly current?: string;
  /** Дефолт, когда в файле пусто. Нет ни того, ни другого — значение обязательно. */
  readonly fallback?: string;
  /** Ввод скрывается, а дефолт показывается через `maskWith`. */
  readonly secret?: boolean;
  /** Как показать текущее значение. Для секретов — обязателен. */
  readonly maskWith?: (value: string) => string;
  /** Проверка формы. Возвращает текст проблемы или null. */
  readonly validate?: (value: string) => string | null;
  /** Пустой ответ допустим и означает «не задавать переменную вовсе». */
  readonly optional?: boolean;
}

export async function askValue(io: SetupIo, spec: ValueSpec): Promise<string> {
  const show = spec.maskWith ?? ((value: string): string => value);
  const preset = spec.current ?? spec.fallback;

  for (;;) {
    io.say('');
    io.say(`${spec.key} — ${spec.description}`);
    if (spec.example !== undefined) io.say(`  example: ${spec.example}`);
    if (preset !== undefined && preset !== '') io.say(`  Enter keeps: ${show(preset)}`);
    else if (spec.optional === true) io.say('  Enter leaves it unset');

    const typed = spec.secret === true ? await io.askSecret('  > ') : await io.ask('  > ');
    const value = typed === '' ? (preset ?? '') : typed;

    if (value === '') {
      if (spec.optional === true) return '';
      io.say(`  ${spec.key} has no working default — it has to be answered.`);
      continue;
    }
    if (!isWritableEnvValue(value)) {
      io.say('  that value contains a line break, which .env cannot carry — paste it as one line.');
      continue;
    }
    const problem = spec.validate?.(value) ?? null;
    if (problem !== null) {
      io.say(`  ${problem}`);
      continue;
    }
    return value;
  }
}

export async function confirm(io: SetupIo, question: string, defaultYes: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await io.ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
    if (answer === '') return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    io.say('  answer y or n');
  }
}

/** Что делать после того, как живая проверка не подтвердила введённое. */
export type AfterFailure = 'retry' | 'keep' | 'abort';

/**
 * «Оставить как есть» существует и стоит НЕ первым.
 *
 * Убрать эту ветку заманчиво — мастер ведь ровно затем и написан, чтобы
 * неверное значение не доехало до файла. Но статусы `unverified` и
 * `unreachable` неверность значения как раз и НЕ доказывают: панель может
 * лежать, туннель — быть закрыт, а креды при этом верны. Мастер, который в
 * такой момент отказывается записать файл, заставляет человека писать `.env`
 * руками — то есть ровно тот барьер, который он должен был убрать. Поэтому
 * ветка есть, но по умолчанию выбран повтор, и «оставить» человек называет
 * вслух.
 */
export async function askAfterFailure(io: SetupIo): Promise<AfterFailure> {
  for (;;) {
    io.say('  [r] re-enter it   [k] keep it anyway   [a] abort and write nothing');
    const answer = (await io.ask('  (r) > ')).toLowerCase();
    if (answer === '' || answer === 'r') return 'retry';
    if (answer === 'k') return 'keep';
    if (answer === 'a') return 'abort';
    io.say('  answer r, k or a');
  }
}
