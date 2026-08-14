import { mkdtempSync } from 'node:fs';
import { readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfirmError, createConfirmStore, hashInput } from './index.js';
import type { MutationDraft } from './index.js';

/**
 * Тесты `peek` лежат отдельным файлом, а не в `index.test.ts`, ровно по той же
 * причине, по которой сам метод понадобился: над этим пакетом одновременно
 * работает несколько исполнителей, и общий файл — это конфликт слияния там, где
 * его можно не создавать.
 */

const NOW = new Date('2026-08-08T12:00:00.000Z');
const TOOL = 'server_edit';
const INPUT = { server_id: 13, fields: { enabled: 0 } };

function tmpDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'hq-confirm-peek-')), 'plans');
}

function draft(over: Partial<MutationDraft> = {}): MutationDraft {
  return {
    tool: TOOL,
    profile: 'human',
    inputHash: hashInput(INPUT),
    before: { server_id: 13, enabled: 1 },
    after: { server_id: 13, enabled: 0 },
    diff: [{ path: 'enabled', from: 1, to: 0 }],
    sideEffects: ['транспорт перестанет выбираться группой'],
    ...over,
  };
}

describe('createConfirmStore.peek', () => {
  it('отдаёт план и НЕ забирает его: после чтения план всё ещё применим', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());

    const seen = await store.peek(plan.token);
    expect(seen).toEqual(plan);
    // Файл на месте — вот всё, ради чего метод существует.
    expect(await readdir(dir)).toEqual([`${plan.token}.json`]);

    await expect(store.take(plan.token, 'human', null, null)).resolves.toMatchObject({
      tool: TOOL,
    });
  });

  it('читается сколько угодно раз — одноразовость живёт в take, а не здесь', async () => {
    const store = createConfirmStore(tmpDir(), { now: () => NOW });
    const plan = await store.put(draft());

    await expect(store.peek(plan.token)).resolves.toMatchObject({ tool: TOOL });
    await expect(store.peek(plan.token)).resolves.toMatchObject({ tool: TOOL });
    await expect(store.peek(plan.token)).resolves.toMatchObject({ tool: TOOL });
  });

  it('после take плана нет: peek отвечает not_found, а не отдаёт снимок второй раз', async () => {
    const store = createConfirmStore(tmpDir(), { now: () => NOW });
    const plan = await store.put(draft());
    await store.take(plan.token, 'human', null, null);

    await expect(store.peek(plan.token)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('план, захваченный соседним вызовом, — in_flight, а не «не найден»', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());
    // Ровно то, что делает take на захвате, и ровно то, что остаётся после
    // процесса, умершего на применении.
    await rename(join(dir, `${plan.token}.json`), join(dir, `${plan.token}.json.taken`));

    await expect(store.peek(plan.token)).rejects.toMatchObject({ code: 'in_flight' });
  });

  it('токен не той формы отбивается ДО обращения к диску (и закрывает выход из каталога)', async () => {
    const store = createConfirmStore(tmpDir(), { now: () => NOW });
    await expect(store.peek('../../etc/passwd')).rejects.toMatchObject({ code: 'bad_token' });
    await expect(store.peek('11111111-2222-3333-4444-55555555555')).rejects.toBeInstanceOf(
      ConfirmError,
    );
  });

  it('битый файл — corrupt, а не SyntaxError из недр JSON.parse', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());
    await writeFile(join(dir, `${plan.token}.json`), '{"token": "оборвано на середине', 'utf8');

    await expect(store.peek(plan.token)).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('НЕ проверяет ни профиль, ни срок: это работа take, и она там осталась', async () => {
    const dir = tmpDir();
    let current = NOW;
    const store = createConfirmStore(dir, { ttlMs: 1000, now: () => current });
    const plan = await store.put(draft({ profile: 'bot' }));

    current = new Date(NOW.getTime() + 60_000);
    // peek отдаёт протухший план чужого профиля — и это правильно: он про
    // «что это за план», а не про «можно ли его применить».
    await expect(store.peek(plan.token)).resolves.toMatchObject({ tool: TOOL, profile: 'bot' });
    await expect(store.take(plan.token, 'human', null, null)).rejects.toMatchObject({
      code: 'foreign_profile',
    });
    // И отказ take не сжёг план — он всё ещё на диске.
    expect(await readdir(dir)).toEqual([`${plan.token}.json`]);
  });
});
