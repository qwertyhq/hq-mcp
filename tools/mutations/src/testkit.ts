import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLog } from '@hq/audit';
import { createConfirmStore } from '@hq/confirm';
import { executeTool } from '@hq/exec';
import { redact } from '@hq/redact';
import { MUTATING_GET_PATHS, assertNotForbidden, createProbeStore, createRegistry } from '@hq/registry';
import { unwrapRemna } from '@hq/remna';
import {
  SHM_MAX_LIMIT,
  ShmError,
  dataTruthyGuard,
  renameSafeShmKeys,
  toShmListResult,
  unwrapShm,
} from '@hq/shm';
import type { ExecResult } from '@hq/exec';
import type {
  Access,
  BackendPresence,
  ClientParams,
  ProbeResult,
  Profile,
  RemnaClient,
  ShmClient,
  ShmListResult,
  ToolContext,
  ToolDef,
} from '@hq/types';
import type { MutationDeps, MutationTool } from './kit.js';

/**
 * ЗАЧЕМ ЭТОТ ФАЙЛ ВЫГЛЯДИТ СЛОЖНЕЕ, ЧЕМ «ВЕРНИ ЗАГОТОВЛЕННЫЙ ОТВЕТ».
 *
 * Харнесс, отдающий канонический ответ напрямую, проверяет мутатор в мире,
 * которого в проде нет. Настоящие клиенты пропускают КАЖДЫЙ вызов через
 * `assertNotForbidden`, отказ на мутирующих GET (§6.15), `renameSafeShmKeys`,
 * `redact`, `dataTruthyGuard` и нормализацию списка, и различие между
 * каналами `get`/`getRaw` — не стилистическое: мутатор, собравший тело PATCH
 * из `get()`, отправит в панель `trojanPassword: '<redacted>'` и уничтожит
 * учётку клиента. В харнессе без редакции такой мутатор зелёный.
 *
 * Поэтому заготовленные ответы здесь оборачиваются в ТЕ ЖЕ функции, которыми
 * пользуются `packages/shm/src/client.ts` и `packages/remna/src/index.ts`.
 * Не воспроизводится только сеть (fetch, таймауты, 429 и бюджет): её проверяют
 * тесты самих клиентов, а не тесты мутаторов.
 */

export interface RecordedCall {
  system: 'shm' | 'remna';
  method: string;
  path: string;
  body?: unknown;
  params?: unknown;
  /** true — вызов ушёл в нередактированный канал getRaw/sendRaw. */
  raw?: boolean;
}

export interface FakeRoutes {
  shmGet?: (path: string, params?: ClientParams) => unknown;
  /** Нередактированное чтение. Если не задано — берётся shmGet. */
  shmGetRaw?: (path: string, params?: ClientParams) => unknown;
  shmList?: (path: string, params?: ClientParams) => unknown;
  shmAction?: (method: string, path: string, body?: unknown) => unknown;
  remnaGet?: (path: string, params?: ClientParams) => unknown;
  remnaGetRaw?: (path: string, params?: ClientParams) => unknown;
  remnaSend?: (method: string, path: string, body?: unknown) => unknown;
  remnaSendRaw?: (method: string, path: string, body?: unknown) => unknown;
}

export interface FakeWorld {
  calls: RecordedCall[];
  ctx: ToolContext;
  deps: MutationDeps;
  dir: string;
  auditPath: string;
  snapshotDir: string;
}

export interface FakeOpts {
  mode?: Access;
  profile?: Profile;
  now?: Date;
  /**
   * Потолок денежной операции. Дефолт совпадает с дефолтом `@hq/env`
   * (`HQ_MCP_MAX_OP_AMOUNT`, 5000) — тесты, которым потолок важен, обязаны
   * задавать его явно, а не полагаться на совпадение двух чисел.
   */
  maxOpAmount?: number;
  /**
   * Потолок числа затронутых клиентов. Дефолт совпадает с дефолтом `@hq/env`
   * (`HQ_MCP_MAX_BULK_USERS`, 100) по той же причине, что и денежный: тест, для
   * которого потолок важен, обязан назвать его явно.
   */
  maxBulkUsers?: number;
  shmTz?: string;
  probe?: ProbeResult | null;
  /** Какие системы «настроены»; по умолчанию обе — см. tools/read/src/testkit.ts. */
  backends?: BackendPresence;
}

/** Список ответов по кругу — когда одна ручка читается до и после мутации. */
export function sequence<T>(values: T[]): () => T {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    if (value === undefined) throw new Error('sequence: пустой список ответов');
    return value;
  };
}

export function listOf<T>(items: T[], total?: number): ShmListResult<T> {
  return { items: total ?? items.length, limit: 25, offset: 0, data: items };
}

/** Ровно то, что делает `raw()` клиента SHM до сети: §8 и §6.15. */
function shmGate(method: string, path: string): void {
  assertNotForbidden(path, method);
  if (method === 'GET' && MUTATING_GET_PATHS.some((bad) => path.startsWith(bad))) {
    throw new ShmError(
      `GET ${path} actually mutates state (it grants a promo, changes the tariff or spends the ` +
        'balance). It is refused here on purpose: risk is classified by the route name, never ' +
        'by the HTTP method.',
      400,
      false,
    );
  }
}

export function makeWorld(routes: FakeRoutes = {}, opts: FakeOpts = {}): FakeWorld {
  const calls: RecordedCall[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'hq-mut-'));
  const auditPath = join(dir, 'audit.jsonl');
  const snapshotDir = join(dir, 'plans');
  const fixedNow = opts.now ?? new Date('2026-08-08T12:00:00.000Z');
  const profile: Profile = opts.profile ?? 'human';

  // Переименование ИДЁТ ПЕРВЫМ и только на редактируемом канале — как в клиенте:
  // `uniq_key` не секрет, но попадает под SECRET_KEY_RE, а починить это после
  // redact уже нечем (там маркер, а не значение).
  const cleanShm = (value: unknown): unknown => redact(renameSafeShmKeys(value), profile);
  const cleanRemna = (value: unknown): unknown => redact(value, profile);

  const shm: ShmClient = {
    async get<T>(path: string, params?: ClientParams): Promise<T> {
      shmGate('GET', path);
      calls.push({ system: 'shm', method: 'GET', path, params });
      if (!routes.shmGet) throw new Error(`тест не задал shmGet для ${path}`);
      return cleanShm(unwrapShm(routes.shmGet(path, params))) as T;
    },

    async getRaw<T>(path: string, params?: ClientParams): Promise<T> {
      shmGate('GET', path);
      calls.push({ system: 'shm', method: 'GET', path, params, raw: true });
      const route = routes.shmGetRaw ?? routes.shmGet;
      if (!route) throw new Error(`тест не задал shmGetRaw для ${path}`);
      return unwrapShm(route(path, params)) as T;
    },

    async list<T>(path: string, params?: ClientParams): Promise<ShmListResult<T>> {
      shmGate('GET', path);
      const requested = params?.limit;
      if (requested !== undefined && Number(requested) <= 0) {
        throw new ShmError(
          `limit=${String(requested)} is refused: for an admin SHM treats limit=0 as "no LIMIT" ` +
            'and dumps the whole table. Ask for an explicit positive limit.',
          400,
          false,
        );
      }
      const limit = Math.min(Number(requested ?? 25), SHM_MAX_LIMIT);
      const offset = Number(params?.offset ?? 0);
      const merged: ClientParams = { ...params, limit, offset };
      calls.push({ system: 'shm', method: 'LIST', path, params: merged });
      if (!routes.shmList) throw new Error(`тест не задал shmList для ${path}`);
      return toShmListResult<T>(cleanShm(routes.shmList(path, merged)), limit, offset);
    },

    async action<T>(
      method: 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
      params?: ClientParams,
    ): Promise<T> {
      shmGate(method, path);
      calls.push({ system: 'shm', method, path, body, params });
      if (!routes.shmAction) throw new Error(`тест не задал shmAction для ${method} ${path}`);
      return cleanShm(dataTruthyGuard(routes.shmAction(method, path, body))) as T;
    },

    async sendRaw<T>(
      method: 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
      params?: ClientParams,
    ): Promise<T> {
      shmGate(method, path);
      calls.push({ system: 'shm', method, path, body, params, raw: true });
      if (!routes.shmAction) throw new Error(`тест не задал shmAction для ${method} ${path}`);
      return dataTruthyGuard(routes.shmAction(method, path, body)) as T;
    },
  };

  const remna: RemnaClient = {
    async get<T>(path: string, params?: ClientParams): Promise<T> {
      assertNotForbidden(path, 'GET');
      calls.push({ system: 'remna', method: 'GET', path, params });
      if (!routes.remnaGet) throw new Error(`тест не задал remnaGet для ${path}`);
      return cleanRemna(unwrapRemna(routes.remnaGet(path, params))) as T;
    },

    async getRaw<T>(path: string, params?: ClientParams): Promise<T> {
      assertNotForbidden(path, 'GET');
      calls.push({ system: 'remna', method: 'GET', path, params, raw: true });
      const route = routes.remnaGetRaw ?? routes.remnaGet;
      if (!route) throw new Error(`тест не задал remnaGetRaw для ${path}`);
      return unwrapRemna(route(path, params)) as T;
    },

    async send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
      assertNotForbidden(path, method);
      calls.push({ system: 'remna', method, path, body });
      if (!routes.remnaSend) throw new Error(`тест не задал remnaSend для ${method} ${path}`);
      return cleanRemna(unwrapRemna(routes.remnaSend(method, path, body))) as T;
    },

    async sendRaw<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
      assertNotForbidden(path, method);
      calls.push({ system: 'remna', method, path, body, raw: true });
      const route = routes.remnaSendRaw ?? routes.remnaSend;
      if (!route) throw new Error(`тест не задал remnaSendRaw для ${method} ${path}`);
      return unwrapRemna(route(method, path, body)) as T;
    },
  };

  const ctx: ToolContext = {
    shm,
    remna,
    backends: opts.backends ?? { shm: true, remna: true },
    profile,
    mode: opts.mode ?? 'rw',
    now: () => fixedNow,
    shmTz: opts.shmTz ?? 'Europe/Moscow',
    probe: createProbeStore(opts.probe ?? null),
  };

  const deps: MutationDeps = {
    audit: createAuditLog(auditPath, { now: () => fixedNow }),
    confirm: createConfirmStore(snapshotDir, { now: () => fixedNow }),
    limits: { maxOpAmount: opts.maxOpAmount ?? 5000, maxBulkUsers: opts.maxBulkUsers ?? 100 },
    sleep: async () => {},
  };

  return { calls, ctx, deps, dir, auditPath, snapshotDir };
}

function defOf(tool: MutationTool | ToolDef): ToolDef {
  return 'def' in tool ? tool.def : tool;
}

/**
 * Вызов инструмента ТЕМ ЖЕ путём, что в проде: `executeTool` поверх настоящего
 * реестра. Прямой вызов `def.handler` проверял бы мир, которого нет:
 *
 *  - `Registry.register` отвергает схему без `shape`, а `executeTool` — вход,
 *    не прошедший `parse`;
 *  - фильтр видимости прячет rw-инструменты в режиме `ro`;
 *  - и главное, ответ проходит через `redact`: поле, названное `confirm_token`,
 *    доезжает до модели как '<redacted>', и заметить это можно только здесь.
 */
export async function callToolResult(
  tool: MutationTool | ToolDef,
  raw: unknown,
  world: FakeWorld,
): Promise<ExecResult> {
  const def = defOf(tool);
  return executeTool(def.name, raw, { registry: createRegistry([def]), ctx: world.ctx });
}

/**
 * То же самое, но неуспех — это исключение: тестам про отказы удобнее
 * `rejects.toThrow`, чем разбор конверта. Возвращается ОТРЕДАКТИРОВАННОЕ
 * значение — ровно то, что увидит модель.
 */
export async function callTool(
  tool: MutationTool | ToolDef,
  raw: unknown,
  world: FakeWorld,
): Promise<unknown> {
  const result = await callToolResult(tool, raw, world);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/**
 * Прямой вызов хендлера в обход исполнителя. Нужен ровно для одного класса
 * проверок: защиты ВТОРОЙ линии, до которых `executeTool` не доходит, потому
 * что первая линия отказала раньше (гейт режима ro прячет инструмент из
 * реестра — и проверка внутри хендлера остаётся неисполненной). Для всего
 * остального пользуйтесь `callTool`.
 */
export async function callHandler(
  tool: MutationTool | ToolDef,
  raw: unknown,
  world: FakeWorld,
): Promise<unknown> {
  const def = defOf(tool);
  const parsed = def.input.parse(raw) as never;
  return def.handler(parsed, world.ctx);
}

/** План, затем применение того же вызова с полученным plan_id. */
export async function planThenApply(
  tool: MutationTool,
  raw: Record<string, unknown>,
  world: FakeWorld,
): Promise<unknown> {
  const plan = (await callTool(tool, raw, world)) as { plan_id: string };
  return callTool(tool, { ...raw, plan_id: plan.plan_id }, world);
}
