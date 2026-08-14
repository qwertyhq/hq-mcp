import { createProbeStore } from '@hq/registry';
import type {
  Access,
  BackendPresence,
  Profile,
  ProbeStore,
  RemnaClient,
  ShmClient,
  ShmListResult,
  TcpProbe,
  ToolContext,
} from '@hq/types';

type Params = Record<string, string | number | undefined>;
type Stub = (path: string, params?: Params, body?: unknown) => unknown;

export interface StubCall {
  system: 'shm' | 'remna';
  method: string;
  path: string;
  params: Record<string, unknown> | undefined;
  body: unknown;
}

export interface MakeCtxOptions {
  shmGet?: Stub;
  shmList?: Stub;
  shmAction?: Stub;
  remnaGet?: Stub;
  remnaSend?: Stub;
  profile?: Profile;
  mode?: Access;
  now?: Date;
  /** Зона «голых» дат SHM; по умолчанию та же, в которой живут стенды. */
  shmTz?: string;
  calls?: StubCall[];
  probe?: ProbeStore;
  /**
   * Какие системы «настроены». По умолчанию обе — тест, который об этом молчит,
   * проверяет обычную установку. Тесты про одну систему называют её явно, и
   * тогда стабы второй остаются на месте: они и есть проверка того, что
   * инструмент туда не пошёл.
   */
  backends?: BackendPresence;
}

function run(stub: Stub | undefined, label: string, path: string, params?: Params, body?: unknown): unknown {
  if (stub === undefined) throw new Error(`no stub configured for ${label} ${path}`);
  return stub(path, params, body);
}

/** Детерминированный ToolContext: стабы вместо HTTP, фиксированное время, журнал вызовов. */
export function makeCtx(opts: MakeCtxOptions = {}): ToolContext {
  const calls = opts.calls ?? [];
  const at = opts.now ?? new Date('2026-08-08T12:00:00.000Z');

  const shm: ShmClient = {
    get: async <T>(path: string, params?: Params): Promise<T> => {
      calls.push({ system: 'shm', method: 'GET', path, params, body: undefined });
      return run(opts.shmGet, 'shm.get', path, params) as T;
    },
    list: async <T>(path: string, params?: Params): Promise<ShmListResult<T>> => {
      calls.push({ system: 'shm', method: 'LIST', path, params, body: undefined });
      const value = run(opts.shmList, 'shm.list', path, params);
      return (
        Array.isArray(value)
          ? { items: value.length, limit: 25, offset: 0, data: value }
          : value
      ) as ShmListResult<T>;
    },
    action: async <T>(
      method: 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
      params?: Params,
    ): Promise<T> => {
      calls.push({ system: 'shm', method, path, params, body });
      return run(opts.shmAction, 'shm.action', path, params, body) as T;
    },
    // Нередактированный канал: в стабе он ведёт к тем же данным, потому что
    // редакции в стабах нет вовсе. Отдельный метод нужен, чтобы инструменты
    // плана 2 могли его вызвать и чтобы вызов был виден в журнале calls.
    getRaw: async <T>(path: string, params?: Params): Promise<T> => {
      calls.push({ system: 'shm', method: 'GET_RAW', path, params, body: undefined });
      return run(opts.shmGet, 'shm.getRaw', path, params) as T;
    },
    sendRaw: async <T>(
      method: 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
      params?: Params,
    ): Promise<T> => {
      calls.push({ system: 'shm', method: `${method}_RAW`, path, params, body });
      return run(opts.shmAction, 'shm.sendRaw', path, params, body) as T;
    },
  };

  const remna: RemnaClient = {
    get: async <T>(path: string, params?: Params): Promise<T> => {
      calls.push({ system: 'remna', method: 'GET', path, params, body: undefined });
      return run(opts.remnaGet, 'remna.get', path, params) as T;
    },
    send: async <T>(
      method: 'POST' | 'PATCH' | 'DELETE',
      path: string,
      body?: unknown,
    ): Promise<T> => {
      calls.push({ system: 'remna', method, path, params: undefined, body });
      return run(opts.remnaSend, 'remna.send', path, undefined, body) as T;
    },
    getRaw: async <T>(path: string, params?: Params): Promise<T> => {
      calls.push({ system: 'remna', method: 'GET_RAW', path, params, body: undefined });
      return run(opts.remnaGet, 'remna.getRaw', path, params) as T;
    },
    sendRaw: async <T>(
      method: 'POST' | 'PATCH' | 'DELETE',
      path: string,
      body?: unknown,
    ): Promise<T> => {
      calls.push({ system: 'remna', method: `${method}_RAW`, path, params: undefined, body });
      return run(opts.remnaSend, 'remna.sendRaw', path, undefined, body) as T;
    },
  };

  return {
    shm,
    remna,
    backends: opts.backends ?? { shm: true, remna: true },
    profile: opts.profile ?? 'human',
    mode: opts.mode ?? 'ro',
    now: () => at,
    shmTz: opts.shmTz ?? 'Europe/Moscow',
    probe: opts.probe ?? createProbeStore(),
  };
}

/** Стаб TCP-проверки для инструментов, гейтящихся по туннелю. */
export function makeTcpProbe(open: boolean | ((port: number) => boolean)): TcpProbe {
  return async (_host, port) => (typeof open === 'boolean' ? open : open(port));
}
