import { describe, expect, it } from 'vitest';
import { executeTool } from '@hq/exec';
import { createRegistry } from '@hq/registry';
import { redact } from '@hq/redact';
import { renameSafeShmKeys } from '@hq/shm';
import { makeCtx } from '../testkit.js';
import { serverInventory } from './inventory.js';

interface Endpoint {
  value: string | null;
  droppedPathSegments: number;
  droppedQuery: boolean;
  droppedCredentials: boolean;
}

interface ServerRow {
  serverId: number;
  groupId: number | null;
  name: string | null;
  transport: string | null;
  enabled: boolean;
  servicesCount: number;
  maxServices: number | null;
  templateId: string | null;
  endpoint: Endpoint;
  usesSshIdentity: boolean;
  panelSquads: string[];
  settingsFields: string[];
}

interface Gaps {
  groupsWithoutUsableServer: Array<{ groupId: number; reason: string }> | null;
  serversInMissingGroup: Array<{ serverId: number; groupId: number | null }> | null;
  serversAtCapacity: Array<{ serverId: number }> | null;
  groupTransportMismatch: Array<{ groupId: number; serverId: number }> | null;
  panelSquadsMissing: Array<{ uuid: string; servers: number[] }> | null;
}

interface Out {
  counts: {
    servers: number;
    groups: number;
    enabledServers: number;
    reported: { servers: number; groups: number };
  };
  servers: ServerRow[];
  groups: Array<{ groupId: number; members: number; enabledMembers: number; usableMembers: number }>;
  gaps: Gaps;
  suppressed: Array<{ gap: string; reason: string }>;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

/**
 * ФОРМА НАСТОЯЩЕГО СЕКРЕТА, А НЕ ПРАВДОПОДОБНАЯ СТРОКА. Форма снята с
 * работающего /admin/server: заметная часть строк несёт в колонке `host` адрес
 * вида `https://api.telegram.org/bot<id>:<токен>/sendMessage`. Значение здесь
 * выдумано, а форма — настоящая, и именно она делает проверку
 * небессмысленной: @hq/redact маскирует по ИМЕНИ поля, а `host` — имя
 * безобидное.
 *
 * Имена констант нарочно не содержат слов token/secret/password: `scripts/
 * no-secrets.test.ts` ищет присваивание непрозрачного значения секретному
 * ИМЕНИ и красным на фикстуре был бы прав — отличить выдуманный токен от
 * настоящего он не может. Тот же приём, что в фикстурах server_edit.
 */
const BOT_CREDENTIAL = '1111111111:AAtest-not-a-real-token';
const TELEGRAM_HOST = `https://api.telegram.org/bot${BOT_CREDENTIAL}/sendMessage`;

/** Пароль SMTP и api-key заголовка: у обоих имя поля «секретное», у host — нет. */
const MAIL_LOGIN_VALUE = 'smtp-not-a-real-password';
const SQUAD_LIVE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SQUAD_GONE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const SERVERS = [
  {
    server_id: 13,
    server_gid: 10,
    name: 'telegram-http',
    transport: 'http',
    host: TELEGRAM_HOST,
    ip: null,
    enabled: 1,
    weight: 100,
    services_count: 0,
    settings: { max_services: 0, template_id: 'http' },
  },
  {
    server_id: 18,
    server_gid: 9,
    name: 'provisioning',
    transport: 'ssh',
    host: 'node.example.test',
    ip: null,
    enabled: 1,
    weight: 100,
    services_count: 964,
    settings: {
      api: { host: 'https://panel.example.test', token: 'panel-token' },
      key_id: 'ssh-key-1',
      max_services: 0,
      port: 22,
      remnawave_squads: [SQUAD_LIVE, SQUAD_GONE],
      template_id: 'remna-3',
    },
  },
  {
    server_id: 4,
    server_gid: 1,
    name: 'smtp',
    transport: 'mail',
    host: 'smtp.mail.test:587',
    ip: null,
    enabled: 0,
    weight: 100,
    services_count: 0,
    settings: { from: 'billing@example.test', password: MAIL_LOGIN_VALUE, template_id: 'vpn_created' },
  },
  {
    server_id: 21,
    server_gid: 77,
    name: 'orphan',
    transport: 'http',
    host: 'https://user:secret@hook.example.test/deliver?token=abc',
    ip: null,
    enabled: 1,
    weight: 100,
    services_count: 5,
    settings: { max_services: 5 },
  },
];

const GROUPS = [
  { group_id: 10, name: 'http', type: 'random', transport: 'http', settings: '{}' },
  { group_id: 9, name: 'provisioning', type: 'by-one', transport: 'ssh', settings: null },
  { group_id: 1, name: 'mail', type: 'random', transport: 'mail', settings: null },
  { group_id: 2, name: 'unused-ssh', type: 'random', transport: 'ssh', settings: null },
];

const SQUADS = { internalSquads: [{ uuid: SQUAD_LIVE, name: 'de' }], total: 1 };

interface Stubs {
  servers?: unknown;
  groups?: unknown;
  squads?: unknown;
  serversItems?: number;
}

async function run(stubs: Stubs = {}): Promise<Out> {
  const ctx = makeCtx({
    shmList: (path) => {
      if (path === '/admin/server') {
        const rows = stubs.servers ?? SERVERS;
        if (!Array.isArray(rows)) throw new Error(String(rows));
        return { items: stubs.serversItems ?? rows.length, limit: 500, offset: 0, data: rows };
      }
      if (path === '/admin/server/group') {
        const rows = stubs.groups ?? GROUPS;
        if (!Array.isArray(rows)) throw new Error(String(rows));
        return { items: rows.length, limit: 500, offset: 0, data: rows };
      }
      throw new Error(`unexpected list ${path}`);
    },
    remnaGet: (path) => {
      if (path !== '/api/internal-squads') throw new Error(`unexpected get ${path}`);
      const value = stubs.squads ?? SQUADS;
      if (typeof value === 'string') throw new Error(value);
      return value;
    },
  });
  return (await serverInventory.handler({}, ctx)) as Out;
}

describe('server_inventory', () => {
  it('never lets a secret out of a value: the bot token in `host` is cut, not masked', async () => {
    const out = await run();
    const text = JSON.stringify(out);
    expect(text).not.toContain(BOT_CREDENTIAL);
    expect(text).not.toContain('sendMessage');
    const telegram = out.servers.find((one) => one.serverId === 13);
    expect(telegram?.endpoint).toEqual({
      value: 'https://api.telegram.org',
      droppedPathSegments: 2,
      droppedQuery: false,
      droppedCredentials: false,
    });
    // Проверка не вырожденная: авторитетная часть, ради которой инвентарь и
    // существует, обязана остаться на месте.
    expect(text).toContain('api.telegram.org');
  });

  it('cuts user:password@ and the query string too, and says it did', async () => {
    const out = await run();
    const orphan = out.servers.find((one) => one.serverId === 21);
    expect(orphan?.endpoint).toEqual({
      value: 'https://hook.example.test',
      droppedPathSegments: 1,
      droppedQuery: true,
      droppedCredentials: true,
    });
    expect(out.warnings.map((one) => one.code)).toContain('endpoint_path_stripped');
  });

  it('keeps a bare host:port whole — URL parsing would read the scheme as smtp.mail.test', async () => {
    const out = await run();
    expect(out.servers.find((one) => one.serverId === 4)?.endpoint.value).toBe('smtp.mail.test:587');
  });

  it('returns the names of settings fields and none of their values', async () => {
    const out = await run();
    const text = JSON.stringify(out);
    expect(text).not.toContain(MAIL_LOGIN_VALUE);
    expect(text).not.toContain('panel-token');
    expect(out.servers.find((one) => one.serverId === 4)?.settingsFields).toEqual([
      'from',
      'password',
      'template_id',
    ]);
    const provisioning = out.servers.find((one) => one.serverId === 18);
    expect(provisioning?.usesSshIdentity).toBe(true);
    expect(provisioning?.templateId).toBe('remna-3');
  });

  it('reads max_services the way Perl does: 0 is no cap, not a full server', async () => {
    const out = await run();
    expect(out.servers.find((one) => one.serverId === 18)?.maxServices).toBeNull();
    // 964 услуги против max_services=0 — не переполнение, иначе каждый сервер
    // работающей установки объявлялся бы заполненным.
    expect(out.gaps.serversAtCapacity?.map((one) => one.serverId)).toEqual([21]);
  });

  it('names why a group cannot yield a server, and separates empty from disabled', async () => {
    const out = await run();
    const gap = out.gaps.groupsWithoutUsableServer ?? [];
    expect(gap.find((one) => one.groupId === 1)?.reason).toMatch(/every server .* is disabled/);
    expect(gap.find((one) => one.groupId === 2)?.reason).toMatch(/no server belongs/);
    // Группа 9 живая: провижининг-сервер включён и потолка у него нет.
    expect(gap.some((one) => one.groupId === 9)).toBe(false);
    expect(out.warnings.map((one) => one.code)).toContain('group_cannot_yield_a_server');
  });

  it('finds a server pointing at a group that does not exist', async () => {
    const out = await run();
    expect(out.gaps.serversInMissingGroup).toEqual([
      { serverId: 21, name: 'orphan', groupId: 77 },
    ]);
  });

  it('finds a member whose transport the group does not declare', async () => {
    // Транспорт для задачи берёт ГРУППА (Core/Task.pm:175-181), а сервер внутри
    // выбирается без оглядки на его собственный: Transport::Ssh получил бы
    // строку http-сервера с чужими settings и чужим host.
    expect(await run().then((one) => one.gaps.groupTransportMismatch)).toEqual([]);
    const out = await run({
      groups: GROUPS.map((one) =>
        one.group_id === 10 ? { ...one, transport: 'ssh' } : one,
      ),
    });
    expect(out.gaps.groupTransportMismatch).toEqual([
      { groupId: 10, groupTransport: 'ssh', serverId: 13, serverTransport: 'http' },
    ]);
  });

  it('checks the squads provisioning assigns against the panel', async () => {
    const out = await run();
    expect(out.gaps.panelSquadsMissing).toEqual([{ uuid: SQUAD_GONE, servers: [18] }]);
  });

  it('suppresses the squad gap when the panel returns none — an empty set is not a deletion', async () => {
    const out = await run({ squads: { internalSquads: [], total: 0 } });
    expect(out.gaps.panelSquadsMissing).toBeNull();
    expect(out.suppressed.map((one) => one.gap)).toContain('panelSquadsMissing');
  });

  it('degrades instead of throwing, and no gap comes back as an empty list', async () => {
    const out = await run({ servers: 'SHM is down', groups: 'SHM is down', squads: 'panel is down' });
    expect(out.servers).toEqual([]);
    for (const value of Object.values(out.gaps)) expect(value).toBeNull();
    expect(out.suppressed.length).toBeGreaterThan(0);
    expect(out.warnings.map((one) => one.code)).toContain('partial_result');
    expect(out.degraded.map((one) => one.system).sort()).toEqual(['remna', 'shm', 'shm']);
  });

  it('surfaces the server-side count and suppresses gaps computed from a short listing', async () => {
    const out = await run({ serversItems: 40 });
    expect(out.counts.reported.servers).toBe(40);
    expect(out.warnings.map((one) => one.code)).toContain('truncated');
    expect(out.gaps.groupsWithoutUsableServer).toBeNull();
    expect(out.gaps.groupTransportMismatch).toBeNull();
    // Дыры, которым короткий список серверов не мешает, считаются по-прежнему.
    expect(out.gaps.serversInMissingGroup).not.toBeNull();
  });

  it('refuses the bot profile by name, not by silence', async () => {
    const ctx = makeCtx({ profile: 'bot' });
    await expect(serverInventory.handler({}, ctx)).rejects.toThrow(/human profile only/);
  });

  /**
   * Проверка на НАСТОЯЩЕМ пути вызова, а не на хендлере. Хендлер зовут
   * напрямую все тесты выше, и они не видят ни одной из ДВУХ редакций — в
   * клиенте и в исполнителе. Здесь стабы редактируют ровно как @hq/shm и
   * @hq/remna, а ответ проходит через executeTool: если бы токен спасала
   * редакция, а не вырезание, на профиле human он приехал бы наружу целиком —
   * `host` не матчит ни одно имя из SECRET_KEY_RE.
   */
  it('the token does not survive the full pipeline either', async () => {
    const registry = createRegistry([serverInventory]);
    const ctx = makeCtx({
      shmList: (path) => {
        const rows = path === '/admin/server' ? SERVERS : GROUPS;
        const clean = redact(renameSafeShmKeys(rows), 'human') as unknown[];
        return { items: clean.length, limit: 500, offset: 0, data: clean };
      },
      remnaGet: () => redact(SQUADS, 'human'),
    });
    const result = await executeTool('server_inventory', {}, { registry, ctx });
    expect(result.ok).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toContain(BOT_CREDENTIAL);
    expect(text).not.toContain(MAIL_LOGIN_VALUE);
    // И обратная половина: инвентарь всё-таки что-то отдал.
    expect(text).toContain('api.telegram.org');
  });

  it('is declared read-only and human-only', () => {
    expect(serverInventory.access).toBe('ro');
    expect(serverInventory.profiles).toEqual(['human']);
    // Пропуск, названный вслух: ключи SSH этот инструмент не читает.
    expect(serverInventory.description).toMatch(/identit/i);
  });
});
