import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Interface } from 'node:readline/promises';

/**
 * ВЕСЬ диалог мастера ходит через этот интерфейс и никогда через
 * process.stdin/stdout напрямую.
 *
 * Не ради красоты: ветки, которые обязаны быть проверены тестом («креды не
 * приняты», «.env уже есть», «оставили дефолт»), — это ветки ДИАЛОГА, и
 * проверить их иначе, чем подставив сюда сценарий заранее заготовленных
 * ответов, можно только человеком за терминалом. То есть нельзя.
 */
export interface SetupIo {
  /** Вопрос с ВИДИМЫМ вводом: URL, режим, y/n. */
  ask(prompt: string): Promise<string>;
  /**
   * Вопрос со СКРЫТЫМ вводом: пароль, токен. Реализация обязана не отдавать
   * введённое обратно в терминал — ни эхом, ни в подсказке.
   */
  askSecret(prompt: string): Promise<string>;
  /** Строка вывода. Секретов сюда не передаёт никто — см. mask.ts. */
  say(line: string): void;
  close(): void;
}

/**
 * Ввод кончился раньше ответа: Ctrl-D, оборванная труба, закрытый терминал.
 *
 * Отдельный класс, а не общий Error, потому что реакция на него другая:
 * это не поломка, а «человек ушёл», и мастеру полагается выйти, ничего не
 * записав, и сказать об этом. Без него `rl.question` просто никогда не
 * разрешится, event loop опустеет и процесс выйдет с кодом 0, не написав ни
 * строки, — то есть тихо соврёт, что всё прошло.
 */
export class InputClosedError extends Error {
  constructor() {
    super('input stream closed before the answer arrived; nothing was written');
    this.name = 'InputClosedError';
  }
}

/** Мастеру нужен НАСТОЯЩИЙ терминал с обеих сторон, а не только на выводе. */
export function hasTty(streams: {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
}): boolean {
  return streams.stdin.isTTY === true && streams.stdout.isTTY === true;
}

/**
 * Скрытие ввода сделано ГЛУШИЛКОЙ ВЫВОДА, а не raw-режимом stdin.
 *
 * readline пишет эхо не в наш код, а в поток, который ему отдали. Поэтому
 * отдаём ему обёртку, которая на время секретного вопроса выбрасывает всё,
 * что он собирался напечатать: ни одного символа пароля в терминал не
 * попадает, а нам не приходится самим разбирать backspace, стрелки, вставку
 * из буфера и восстанавливать режим терминала после Ctrl-C — то есть тот
 * список, в котором ошибка стоит либо испорченного терминала, либо пароля,
 * напечатанного на экране.
 */
export function createTtyIo(
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
): SetupIo {
  let muted = false;
  const sink = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      if (!muted && (typeof chunk === 'string' || chunk instanceof Uint8Array)) {
        stdout.write(chunk);
      }
      callback();
    },
  });

  const rl: Interface = createInterface({ input: stdin, output: sink, terminal: true });

  /**
   * `rl.question` при закрытии интерфейса не отклоняется — он остаётся висеть.
   * Гонка с событием 'close' превращает это в исключение; слушатель снимается
   * в finally, иначе на каждый вопрос копился бы ещё один.
   */
  async function question(prompt: string): Promise<string> {
    let onClose: (() => void) | undefined;
    try {
      return await Promise.race([
        rl.question(prompt),
        new Promise<never>((_resolve, reject) => {
          onClose = (): void => {
            reject(new InputClosedError());
          };
          rl.once('close', onClose);
        }),
      ]);
    } finally {
      if (onClose !== undefined) rl.removeListener('close', onClose);
    }
  }

  return {
    ask: async (prompt: string): Promise<string> => (await question(prompt)).trim(),
    askSecret: async (prompt: string): Promise<string> => {
      // Подсказка печатается ДО глушилки и мимо неё — иначе её съест та же
      // обёртка, и человек будет смотреть на пустой экран, не зная, чего ждут.
      stdout.write(prompt);
      muted = true;
      try {
        return (await question('')).trim();
      } finally {
        muted = false;
        // Enter, который readline проглотил вместе с эхом: без него следующая
        // строка вывода дописывается в конец подсказки.
        stdout.write('\n');
      }
    },
    say: (line: string): void => {
      stdout.write(`${line}\n`);
    },
    close: (): void => {
      rl.close();
    },
  };
}
