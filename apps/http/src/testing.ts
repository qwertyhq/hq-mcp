import { z } from 'zod';
import { Budget } from '@hq/budget';
import { createProbeStore, createRegistry } from '@hq/registry';
import type { RemnaClient, ShmClient, ToolContext, ToolDef } from '@hq/types';
import type { AppDeps } from './app.js';
import type { HttpToken } from './auth.js';
import { Metrics } from './metrics.js';

export const FIXED_NOW = (): Date => new Date('2026-08-08T12:00:00.000Z');
/**
 * Значение начинается с `example`, и это не вкус: `scripts/no-secrets.test.ts` краснеет на
 * присваивании секретоподобного ИМЕНИ (`*TOKEN*`, `*AUTH*`) значения, не похожего на
 * плейсхолдер. Фикстура, которую страж считает утечкой, со временем учит смотреть на его
 * красноту сквозь пальцы — а он один на весь репозиторий.
 */
export const TEST_TOKEN = 'example-token-0123456789abcdef';
export const TEST_TOKENS: readonly HttpToken[] = [{ label: 'test', token: TEST_TOKEN }];
// Без аннотации типа намеренно: `AUTH_HEADERS: Record<string, string> = …` тот же страж
// читает как «имени с AUTH присвоено непустое значение» и краснеет на типе.
export const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * Клиенты, которые обязаны БРОСАТЬ. Ни один тест HTTP-слоя не ходит в апстрим: инструменты
 * здесь фейковые, и попадание в реальный запрос — это дефект теста, который должен быть
 * слышен, а не заметён пустым ответом.
 */
export function stubShm(): ShmClient {
  const boom =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(`stubShm.${name} is not wired`);
    };
  return {
    get: boom('get'),
    getRaw: boom('getRaw'),
    list: boom('list'),
    action: boom('action'),
    sendRaw: boom('sendRaw'),
  };
}

export function stubRemna(): RemnaClient {
  const boom =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(`stubRemna.${name} is not wired`);
    };
  return {
    get: boom('get'),
    getRaw: boom('getRaw'),
    send: boom('send'),
    sendRaw: boom('sendRaw'),
  };
}

/**
 * `probe` и `shmTz` — обязательные поля ToolContext (packages/types), а не украшение:
 * listVisibleTools читает ctx.probe.get() на КАЖДЫЙ листинг, и контекст без стора роняет
 * и /healthz, и /v1/tools. Пустой стор означает «probe ещё не гоняли» — реестр в этом
 * случае ничего не прячет.
 */
export function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    shm: stubShm(),
    remna: stubRemna(),
    backends: { shm: true, remna: true },
    profile: 'bot',
    mode: 'ro',
    now: FIXED_NOW,
    shmTz: 'Europe/Moscow',
    probe: createProbeStore(),
    ...over,
  };
}

export const overviewInput = z.object({ query: z.string().min(1) });

/**
 * Три инструмента, покрывающие все ветки HTTP-слоя:
 *  - client_overview — виден боту, отдаёт данные с кредами/PII (проверка редакции);
 *  - spool_inspect   — виден боту, простое чтение со значением по умолчанию во входе;
 *  - sql_query       — только human, из HTTP не виден и не вызываем.
 */
export function fakeTools(): ToolDef[] {
  const overview: ToolDef = {
    name: 'client_overview',
    description: 'Client 360 across SHM and Remnawave (client.overview)',
    input: overviewInput,
    access: 'ro',
    risk: 'none',
    profiles: ['human', 'bot'],
    handler: async (input) => {
      const { query } = overviewInput.parse(input);
      return {
        query,
        shm: { user_id: 3073, login: 'tg100000001', balance: 120.5, email: 'client@example.com' },
        remna: {
          uuid: 'a1b2c3d4',
          status: 'ACTIVE',
          subscriptionUrl: 'https://sub.example.com/sub/AbCdEf12',
          shortUuid: 'AbCdEf12',
          trojanPassword: 'p@ssw0rd',
        },
        lastIp: '95.24.11.7',
        subLastUserAgent: 'Happ/2.1 iOS',
      };
    },
  };
  const spool: ToolDef = {
    name: 'spool_inspect',
    description: 'Spool queue snapshot (spool.inspect)',
    input: z.object({ limit: z.number().int().min(1).max(100).default(25) }),
    access: 'ro',
    risk: 'none',
    profiles: ['human', 'bot'],
    handler: async () => ({ stuck: 0, failed: 0, items: 0 }),
  };
  const sql: ToolDef = {
    name: 'sql_query',
    description: 'Read-only SQL, human profile only (sql.query)',
    input: z.object({ sql: z.string() }),
    access: 'ro',
    risk: 'medium',
    profiles: ['human'],
    handler: async () => ({ rows: [] }),
  };
  return [overview, spool, sql];
}

export function fakeDeps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    registry: createRegistry(fakeTools()),
    ctx: fakeCtx(),
    budget: new Budget({ limit: 1000, windowMs: 60_000, now: FIXED_NOW }),
    tokens: TEST_TOKENS,
    metrics: new Metrics({ now: FIXED_NOW }),
    version: 'test',
    ...over,
  };
}
