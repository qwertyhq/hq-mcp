import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { InputClosedError, createTtyIo, hasTty } from './io.js';

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: (): string => chunks.join('') };
}

describe('hasTty', () => {
  it('requires a terminal on both ends', () => {
    expect(hasTty({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toBe(true);
    expect(hasTty({ stdin: { isTTY: true }, stdout: {} })).toBe(false);
    expect(hasTty({ stdin: {}, stdout: { isTTY: true } })).toBe(false);
    // Так это и выглядит, когда сервер запускает MCP-клиент: труба с обеих сторон.
    expect(hasTty({ stdin: {}, stdout: {} })).toBe(false);
  });
});

describe('createTtyIo', () => {
  it('echoes an ordinary answer', async () => {
    const input = new PassThrough();
    const out = capture();
    const io = createTtyIo(input, out.stream);

    const answer = io.ask('url: ');
    input.write('https://panel.example.com\n');

    expect(await answer).toBe('https://panel.example.com');
    expect(out.text()).toContain('url: ');
    expect(out.text()).toContain('https://panel.example.com');
    io.close();
  });

  it('shows the prompt of a hidden question but not one character of the answer', async () => {
    const input = new PassThrough();
    const out = capture();
    const io = createTtyIo(input, out.stream);

    const answer = io.askSecret('password: ');
    input.write('example-secret-value\n');

    expect(await answer).toBe('example-secret-value');
    expect(out.text()).toContain('password: ');
    expect(out.text()).not.toContain('example-secret-value');
    // Даже посимвольно: эхо readline идёт по одному символу за раз.
    expect(out.text()).not.toContain('exam');
    io.close();
  });

  it('goes back to echoing after the hidden question', async () => {
    const input = new PassThrough();
    const out = capture();
    const io = createTtyIo(input, out.stream);

    const hidden = io.askSecret('password: ');
    input.write('example-secret-value\n');
    await hidden;
    const visible = io.ask('mode: ');
    input.write('ro\n');
    await visible;

    expect(out.text()).toContain('mode: ');
    expect(out.text()).toContain('ro');
    io.close();
  });

  it('turns a closed input into an error instead of a promise that never settles', async () => {
    const input = new PassThrough();
    const out = capture();
    const io = createTtyIo(input, out.stream);

    const answer = io.ask('url: ');
    input.end();

    await expect(answer).rejects.toBeInstanceOf(InputClosedError);
  });
});
