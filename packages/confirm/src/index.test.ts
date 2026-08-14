import { mkdtempSync } from 'node:fs';
import { chmod, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDiff, ConfirmError, createConfirmStore, flatten, hashInput, redactDiff } from './index.js';
import type { MutationDraft } from './index.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const INPUT = { uuid: 'h-1', isDisabled: false };
const HASH = hashInput(INPUT);
const TOOL = 'host_edit';

function tmpDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'hq-confirm-')), 'plans');
}

function draft(over: Partial<MutationDraft> = {}): MutationDraft {
  return {
    tool: TOOL,
    profile: 'human',
    inputHash: HASH,
    before: { uuid: 'h-1', isDisabled: true },
    after: { uuid: 'h-1', isDisabled: false },
    diff: [{ path: 'isDisabled', from: true, to: false }],
    sideEffects: ['хост станет виден во всех подписках'],
    rollback: { method: 'PATCH', path: '/api/hosts', body: { uuid: 'h-1', isDisabled: true } },
    ...over,
  };
}

describe('createConfirmStore.put', () => {
  it('writes the plan to disk, mints a token and stamps expiresAt by the TTL', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { ttlMs: 600_000, now: () => NOW });

    const plan = await store.put(draft());

    expect(plan.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.createdAt).toBe('2026-08-08T12:00:00.000Z');
    expect(plan.expiresAt).toBe('2026-08-08T12:10:00.000Z');
    expect(plan.profile).toBe('human');
    expect(plan.inputHash).toBe(HASH);
    expect(plan.rollback).toEqual({
      method: 'PATCH',
      path: '/api/hosts',
      body: { uuid: 'h-1', isDisabled: true },
    });
    // Ровно один файл: временное имя, через которое шла запись, переименовано, а не брошено.
    expect(await readdir(dir)).toEqual([`${plan.token}.json`]);
    expect(JSON.parse(await readFile(join(dir, `${plan.token}.json`), 'utf8'))).toEqual(plan);
  });

  it('keeps the snapshots unreadable to other users: dir 0700, file 0600', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${plan.token}.json`))).mode & 0o777).toBe(0o600);
  });

  it('resolves an idempotency key that needs the token, and stores it on disk', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });

    const plan = await store.put(
      draft({ idempotencyKey: (token) => `hq:billing_adjust:3073:${token}` }),
    );

    expect(plan.idempotencyKey).toBe(`hq:billing_adjust:3073:${plan.token}`);
    const onDisk = JSON.parse(await readFile(join(dir, `${plan.token}.json`), 'utf8')) as {
      idempotencyKey: string;
    };
    // Ключ считается ОДИН раз и живёт в плане: каждый повтор применения берёт тот же (§7.4).
    expect(onDisk.idempotencyKey).toBe(plan.idempotencyKey);
  });

  it('sweeps abandoned snapshots — plans, claims and half-written temporaries alike', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { ttlMs: 1000, now: () => NOW });
    const stale = await store.put(draft());
    const fresh = await store.put(draft());
    const claim = join(dir, `${stale.token}.json.taken`);
    const temp = join(dir, `${stale.token}.json.tmp-abc`);
    await writeFile(claim, '{}', 'utf8');
    await writeFile(temp, '{"trunca', 'utf8');

    const old = new Date(NOW.getTime() - 1000 * 10 - 1);
    await utimes(join(dir, `${stale.token}.json`), old, old);
    await utimes(claim, old, old);
    await utimes(temp, old, old);

    const kept = await store.put(draft());

    expect((await readdir(dir)).sort()).toEqual([`${fresh.token}.json`, `${kept.token}.json`].sort());
  });
});

describe('createConfirmStore.take', () => {
  it('is one-shot: the second call with the same token is refused', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());

    const taken = await store.take(plan.token, 'human', TOOL, HASH);
    expect(taken.tool).toBe(TOOL);
    expect(taken.before).toEqual({ uuid: 'h-1', isDisabled: true });
    expect(await readdir(dir)).toEqual([]);

    await expect(store.take(plan.token, 'human', TOOL, HASH)).rejects.toThrow(
      /уже использован|не найден/,
    );
  });

  it('lets a caller that dispatches by plan.tool pass null for the tool and the hash', async () => {
    // Это ops_confirm: он получает ОДИН токен и узнаёт инструмент из самого плана,
    // а входа мутатора у него нет вовсе — сверять хеш не с чем.
    const store = createConfirmStore(tmpDir(), { now: () => NOW });
    const plan = await store.put(draft());

    await expect(store.take(plan.token, 'human', null, null)).resolves.toMatchObject({
      tool: TOOL,
    });
  });

  it('refuses a foreign profile without burning the plan', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());

    await expect(store.take(plan.token, 'bot', TOOL, HASH)).rejects.toThrow(
      /построен профилем human/,
    );
    expect(await readdir(dir)).toEqual([`${plan.token}.json`]);
    await expect(store.take(plan.token, 'human', TOOL, HASH)).resolves.toMatchObject({
      tool: TOOL,
    });
  });

  it('refuses a token belonging to another tool without burning that tool’s plan', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft({ tool: 'subscription_ops' }));

    await expect(store.take(plan.token, 'human', 'billing_adjust', HASH)).rejects.toThrow(
      /принадлежит плану инструмента subscription_ops/,
    );
    // Именно это и было дырой: план чужого инструмента не должен погибать от чужого вызова.
    expect(await readdir(dir)).toEqual([`${plan.token}.json`]);
    await expect(store.take(plan.token, 'human', 'subscription_ops', HASH)).resolves.toMatchObject(
      { tool: 'subscription_ops' },
    );
  });

  it('refuses arguments the plan was not built from, and keeps the plan applicable', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());

    await expect(
      store.take(plan.token, 'human', TOOL, hashInput({ uuid: 'h-1', isDisabled: true })),
    ).rejects.toThrow(/другими аргументами/);
    expect(await readdir(dir)).toEqual([`${plan.token}.json`]);
    await expect(store.take(plan.token, 'human', TOOL, HASH)).resolves.toMatchObject({
      tool: TOOL,
    });
  });

  it('refuses an expired plan and leaves it on disk until the sweep', async () => {
    const dir = tmpDir();
    let current = new Date(NOW);
    const store = createConfirmStore(dir, { ttlMs: 1000, now: () => current });
    const plan = await store.put(draft());

    current = new Date(NOW.getTime() + 2000);
    await expect(store.take(plan.token, 'human', TOOL, HASH)).rejects.toThrow(ConfirmError);
    // Тот же текст и во второй раз: отказ не сжигает план, поэтому причина не подменяется
    // на «токен уже использован».
    await expect(store.take(plan.token, 'human', TOOL, HASH)).rejects.toThrow(/протух/);
    expect(await readdir(dir)).toEqual([`${plan.token}.json`]);
  });

  it('rejects a token outside the uuid format before touching the filesystem', async () => {
    const store = createConfirmStore(tmpDir(), { now: () => NOW });

    await expect(store.take('../../etc/passwd', 'human', TOOL, HASH)).rejects.toThrow(/формат/);
    await expect(store.take('E1F9D0C8-0000-4000-8000-000000000001', 'human', TOOL, HASH)).rejects.toThrow(
      /формат/,
    );
  });

  it('reports a truncated snapshot as a ConfirmError, not as a SyntaxError', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());
    await writeFile(join(dir, `${plan.token}.json`), '{"tool":"host_edit","befo', 'utf8');

    await expect(store.take(plan.token, 'human', TOOL, HASH)).rejects.toThrow(ConfirmError);
    await expect(store.take(plan.token, 'human', TOOL, HASH)).rejects.toThrow(/повреждён/);
  });

  it('refuses a snapshot whose shape is not a plan, including an unparsable expiresAt', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });

    const noTool = await store.put(draft());
    await writeFile(
      join(dir, `${noTool.token}.json`),
      JSON.stringify({ ...noTool, tool: '' }),
      'utf8',
    );
    await expect(store.take(noTool.token, 'human', TOOL, HASH)).rejects.toThrow(/повреждён/);

    const badDate = await store.put(draft());
    await writeFile(
      join(dir, `${badDate.token}.json`),
      JSON.stringify({ ...badDate, expiresAt: 'позавчера' }),
      'utf8',
    );
    // Дата, которую не разобрать, — это НЕ «свежий план»: сравнение с NaN всегда ложно,
    // и без явной проверки такой файл применялся бы вечно.
    await expect(store.take(badDate.token, 'human', TOOL, HASH)).rejects.toThrow(/повреждён/);
  });

  it('refuses a plan copied under someone else’s file name', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());
    const alias = 'e1f9d0c8-0000-4000-8000-000000000001';
    await writeFile(join(dir, `${alias}.json`), JSON.stringify(plan), 'utf8');

    await expect(store.take(alias, 'human', TOOL, HASH)).rejects.toThrow(/повреждён/);
  });

  // Под root chmod не запрещает чтение — тогда проверять нечего.
  it.skipIf(process.getuid?.() === 0)(
    'explains an unreadable snapshot instead of leaking a bare errno, and gives the plan back',
    async () => {
      const dir = tmpDir();
      const store = createConfirmStore(dir, { now: () => NOW });
      const plan = await store.put(draft());
      const file = join(dir, `${plan.token}.json`);
      await chmod(file, 0o000);

      // Каталог снимков общий у stdio и http, а под разными пользователями это EACCES.
      await expect(store.take(plan.token, 'human', TOOL, HASH)).rejects.toThrow(/не читается/);
      expect(await readdir(dir)).toEqual([`${plan.token}.json`]);

      await chmod(file, 0o600);
      await expect(store.take(plan.token, 'human', TOOL, HASH)).resolves.toMatchObject({
        tool: TOOL,
      });
    },
  );

  it('tells apart a claim in flight from a token that was already spent', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());
    await store.take(plan.token, 'human', TOOL, HASH);
    await writeFile(join(dir, `${plan.token}.json.taken`), JSON.stringify(plan), 'utf8');

    await expect(store.take(plan.token, 'human', TOOL, HASH)).rejects.toThrow(/применяется прямо сейчас/);
  });
});

describe('createConfirmStore under concurrency', () => {
  it('gives the plan to exactly one of twenty simultaneous takes', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.take(plan.token, 'human', TOOL, HASH)),
    );

    // Читать файл, проверять и удалять его тремя await'ами — значит отдать план всем
    // двадцати: два PUT /admin/user/payment по одному плану и есть двойное списание.
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
    for (const outcome of settled) {
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(ConfirmError);
    }
  });

  it('returns the plan to disk when every one of twenty simultaneous takes is refused', async () => {
    const dir = tmpDir();
    const store = createConfirmStore(dir, { now: () => NOW });
    const plan = await store.put(draft());

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.take(plan.token, 'bot', TOOL, HASH)),
    );

    expect(settled.every((r) => r.status === 'rejected')).toBe(true);
    expect(await readdir(dir)).toEqual([`${plan.token}.json`]);
    await expect(store.take(plan.token, 'human', TOOL, HASH)).resolves.toMatchObject({ tool: TOOL });
  });
});

describe('hashInput', () => {
  it('ignores key order and absent-versus-undefined, so a retry hashes the same', () => {
    expect(hashInput({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(
      hashInput({ b: { d: 'x', c: [1, 2] }, a: 1 }),
    );
    expect(hashInput({ user_id: 3073 })).toBe(hashInput({ user_id: 3073, comment: undefined }));
  });

  it('drops the plan identifier itself, whichever of the two names it carries', () => {
    const bare = hashInput({ user_id: 3073, amount: -100 });
    expect(hashInput({ user_id: 3073, amount: -100, confirm_token: 'x' })).toBe(bare);
    expect(hashInput({ user_id: 3073, amount: -100, plan_id: 'x' })).toBe(bare);
    // Только на верхнем уровне: вложенное поле с таким именем — обычный аргумент.
    expect(hashInput({ user_id: 3073, amount: -100, nested: { confirm_token: 'x' } })).not.toBe(bare);
  });

  it('changes with the value, the type and the order of an array', () => {
    const keys = new Set([
      hashInput({ amount: -100 }),
      hashInput({ amount: -999 }),
      hashInput({ amount: '-100' }),
      hashInput({ items: [1, 2] }),
      hashInput({ items: [2, 1] }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('survives a cycle and a BigInt instead of throwing on the way to a mutation', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => hashInput(cyclic)).not.toThrow();
    // JSON.stringify(1n) бросает: хеш входа не имеет права падать на литерале.
    expect(() => hashInput({ amount: 10n })).not.toThrow();
    expect(hashInput({ amount: 10n })).not.toBe(hashInput({ amount: 10 }));
  });
});

describe('the package surface', () => {
  it('re-exports the diff builders, including the masking one Task 5 must call', () => {
    expect(typeof buildDiff).toBe('function');
    expect(typeof flatten).toBe('function');
    expect(redactDiff([{ path: 'trojanPassword', from: 'old', to: 'new' }], 'human')).toEqual([
      { path: 'trojanPassword', from: '<redacted>', to: '<redacted>' },
    ]);
  });
});
