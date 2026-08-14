import { describe, expect, it } from 'vitest';
import { REDACTED } from '@hq/redact';
import {
  FORBIDDEN_SETTINGS_KEYS,
  GROUP_FIELDS,
  SERVER_FIELDS,
  assertNoMaskedValues,
  serverEdit,
} from './edit.js';
import { opsConfirm } from '../ops.js';
import { callTool, callToolResult, makeWorld, planThenApply } from '../testkit.js';
import type { FakeWorld, FakeRoutes } from '../testkit.js';

/**
 * ФОРМА НАСТОЯЩЕГО СЕКРЕТА, А НЕ ПРАВДОПОДОБНАЯ СТРОКА. Форма снята с работающего
 * /admin/server: часть строк несёт в колонке `host` адрес вида
 * `https://api.telegram.org/bot<id>:<токен>/sendMessage`. Значение выдумано,
 * форма настоящая — и именно она делает проверки небессмысленными: @hq/redact
 * маскирует по ИМЕНИ поля, а `host` — имя безобидное.
 */
const BOT_CREDENTIAL = '7331234567:AAF9kZq2xWvBn4TcMdLpQr8sYh3JgEuVwXy';
const TELEGRAM_HOST = `https://api.telegram.org/bot${BOT_CREDENTIAL}/sendMessage`;
/**
 * Имена констант нарочно не содержат слов token/secret/password: `scripts/
 * no-secrets.test.ts` ищет присваивание непрозрачного значения секретному ИМЕНИ
 * и красным на фикстуре был бы прав — отличить выдуманный токен от настоящего он не
 * может. Форма значений при этом настоящая, и именно она проверяется ниже.
 */
const MAIL_LOGIN_VALUE = 'smtp-not-a-real-passwd';

const HTTP_SERVER = {
  server_id: 13,
  server_gid: 10,
  name: 'telegram-http',
  transport: 'http',
  host: TELEGRAM_HOST,
  ip: null,
  enabled: 1,
  weight: 100,
  services_count: 0,
  settings: { max_services: 0, template_id: 'http', headers: { 'api-key': 'k'.repeat(40) } },
};

const SSH_SERVER = {
  server_id: 7,
  server_gid: 11,
  name: 'remna-provisioning',
  transport: 'ssh',
  host: 'ssh://192.0.2.20:22',
  ip: '192.0.2.20',
  enabled: 1,
  weight: 1,
  services_count: 700,
  settings: { key_id: 3, template_id: 'remna-3' },
};

const MAIL_SERVER = {
  server_id: 4,
  server_gid: 1,
  name: 'smtp',
  transport: 'mail',
  host: 'smtp.mail.ru:587',
  ip: null,
  enabled: 0,
  weight: 1,
  services_count: 0,
  settings: { login: 'noreply@example.com', password: MAIL_LOGIN_VALUE },
};

const GROUPS = [
  { group_id: 1, name: 'рассылка', type: 'random', transport: 'mail' },
  { group_id: 10, name: 'telegram', type: 'random', transport: 'http' },
  { group_id: 11, name: 'remna-group', type: 'by-one', transport: 'ssh' },
];

interface Plan {
  plan_id: string;
  diff: Array<{ path: string; from: unknown; to: unknown }>;
  before: Record<string, unknown>;
  after: { call: { method: string; path: string; body: Record<string, unknown> } };
  sideEffects: string[];
  rollback?: { method: string; path: string; body: Record<string, unknown> };
}

function world(over: FakeRoutes = {}, servers = [HTTP_SERVER, SSH_SERVER, MAIL_SERVER]): FakeWorld {
  return makeWorld({
    // ВАЖНО: раздельные каналы. `shmGetRaw` отдаёт настоящие значения, а
    // `shmGet` (редактируемый) вернул бы то же самое через redact — если
    // инструмент однажды прочитает не тем каналом, тесты ниже это увидят.
    shmGetRaw: (path: string) => (path === '/admin/server' ? servers : GROUPS),
    shmGet: (path: string) => (path === '/admin/server' ? servers : GROUPS),
    shmAction: () => [{ server_id: 13, enabled: 0 }],
    ...over,
  });
}

describe('server_edit: форма инструмента', () => {
  it('только human и rw, риск высокий', () => {
    const tool = serverEdit(world().deps);
    expect(tool.def.profiles).toEqual(['human']);
    expect(tool.def.access).toBe('rw');
    expect(tool.def.risk).toBe('high');
  });

  /**
   * Маршрут ssh-ключей запрещён целиком правилом-префиксом в @hq/registry: тот
   * GET отдаёт приватный ключ в теле. Здесь проверяется, что инструмент не
   * может дотянуться до него НИ ОДНИМ действием — все пути константны.
   */
  it('объявляет ровно два пути и ни один не ведёт к ssh-ключам', () => {
    const tool = serverEdit(world().deps);
    const paths = new Set(tool.endpoints.map((one) => one.split(' ')[1]));
    expect([...paths].sort()).toEqual(['/admin/server', '/admin/server/group']);
    for (const endpoint of tool.endpoints) {
      expect(endpoint).not.toContain('identity');
    }
  });

  it('счётчики и ключ таблицы вне whitelist', () => {
    for (const field of ['server_id', 'services_count', 'success_count', 'fail_count', 'settings']) {
      expect(SERVER_FIELDS as readonly string[]).not.toContain(field);
    }
    expect(GROUP_FIELDS as readonly string[]).toEqual(['name', 'type', 'transport']);
    expect(Object.keys(FORBIDDEN_SETTINGS_KEYS)).toContain('key_id');
  });
});

describe('server_edit: секреты не уезжают наружу', () => {
  it('читает строки ТОЛЬКО нередактированным каналом', async () => {
    const w = world();
    await callTool(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 13, fields: { enabled: 0 } },
      w,
    );
    const reads = w.calls.filter((one) => one.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    for (const call of reads) expect(call.raw, `${call.path} прочитан редактируемым каналом`).toBe(true);
  });

  it('в плане нет ни токена бота, ни пароля SMTP, ни пути вебхука', async () => {
    const w = world();
    const plan = (await callTool(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 13, fields: { weight: 50 } },
      w,
    )) as Plan;

    const text = JSON.stringify(plan);
    expect(text).not.toContain(BOT_CREDENTIAL);
    expect(text).not.toContain('sendMessage');
    expect(text).not.toContain(MAIL_LOGIN_VALUE);
    // Проверка не вырожденная: адрес на месте, вырезан ровно путь.
    expect(text).toContain('api.telegram.org');
    expect(plan.before.host).toBe('https://api.telegram.org');
  });

  /**
   * Отпечаток существует не для красоты: без него ротация токена ВНУТРИ пути
   * дала бы пустой diff (адрес-то не изменился), а каркас справедливо
   * отказывается подтверждать план, который ничего не меняет.
   */
  it('смена только секретной части host даёт непустой diff и не показывает секрет', async () => {
    const w = world();
    const rotated = `https://api.telegram.org/bot7331234567:BBnewtokenvalue9876543210abcdefgh/sendMessage`;
    const plan = (await callTool(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 13, fields: { host: rotated } },
      w,
    )) as Plan;

    const host = plan.diff.find((one) => one.path === 'host');
    expect(host).toBeDefined();
    expect(String(host?.from)).not.toBe(String(host?.to));
    expect(String(host?.from)).not.toContain(BOT_CREDENTIAL);
    expect(String(host?.from)).toContain('https://api.telegram.org [#');
    // Новое значение оператор прислал сам, но и оно показывается отпечатком.
    expect(String(host?.to)).not.toContain('BBnewtokenvalue9876543210abcdefgh');
    expect(plan.sideEffects.join(' ')).toContain('Прежнее значение host');
    // Отката для смены host не предлагается: он унёс бы старое значение в ответ.
    expect(plan.rollback).toBeUndefined();
  });

  it('значения настроек наружу не отдаются — только имена ключей и отпечаток', async () => {
    const w = world();
    const plan = (await callTool(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 4, fields: { enabled: 1 } },
      w,
    )) as Plan;

    expect(plan.before.settingsFields).toEqual(['login', 'password']);
    expect(JSON.stringify(plan)).not.toContain(MAIL_LOGIN_VALUE);
  });

  it('изменение секретного ключа настроек показывается в diff маркером, а пишется значением', async () => {
    const w = world();
    const tool = serverEdit(w.deps);
    const args = {
      action: 'update_server',
      server_id: 4,
      settings: { password: 'new-smtp-password-value' },
    };
    const plan = (await callTool(tool, args, w)) as Plan;

    const entry = plan.diff.find((one) => one.path === 'settings.password');
    expect(entry).toEqual({ path: 'settings.password', from: REDACTED, to: REDACTED });
    expect(JSON.stringify(plan.diff)).not.toContain('new-smtp-password-value');

    await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    const write = w.calls.find((one) => one.method === 'POST');
    // В SHM уехало НАСТОЯЩЕЕ значение, а соседний ключ пережил слияние целым.
    expect(write?.body).toEqual({
      server_id: 4,
      settings: { login: 'noreply@example.com', password: 'new-smtp-password-value' },
    });
  });
});

/**
 * ГЛАВНАЯ ПРОВЕРКА ЭТОГО ФАЙЛА. Read-modify-write, собранный из
 * ОТРЕДАКТИРОВАННОГО чтения, записывает '<redacted>' поверх работающего
 * секрета — SHM отвечает 200, а транспорт перестаёт работать молча.
 */
describe('server_edit: маскированное значение не имеет права уехать в SHM', () => {
  it('план отказывает, если прочитанные настройки пришли маскированными', async () => {
    // Мир, в котором «сырой» канал ведёт себя как редактируемый: ровно то, что
    // случится, если инструмент однажды прочитает не тем методом.
    const masked = { ...MAIL_SERVER, settings: { login: 'noreply@example.com', password: REDACTED } };
    const w = world({ shmGetRaw: () => [masked] }, [masked]);

    const res = await callToolResult(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 4, settings: { login: 'other@example.com' } },
      w,
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/маскированные значения|маскированн/);
    expect(w.calls.some((one) => one.method === 'POST')).toBe(false);
  });

  it('маркер в присланном значении тоже отбивается', async () => {
    const w = world();
    const res = await callToolResult(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 13, fields: { host: `https://x/${REDACTED}` } },
      w,
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/маскированные значения/);
  });

  it('проверка ловит маркер на любой глубине тела', () => {
    expect(() => {
      assertNoMaskedValues({ settings: { headers: { 'api-key': REDACTED } } }, 'x');
    }).toThrow(/settings\.headers\.api-key/);
    expect(() => {
      assertNoMaskedValues({ settings: { list: ['ok', '<redacted:jwt>'] } }, 'x');
    }).toThrow(/settings\.list\[1\]/);
    expect(() => {
      assertNoMaskedValues({ server_id: 13, enabled: 0 }, 'x');
    }).not.toThrow();
  });
});

describe('server_edit: запись', () => {
  it('выключает транспорт и пишет ровно перечисленные поля', async () => {
    const w = world();
    const tool = serverEdit(w.deps);
    const args = { action: 'update_server', server_id: 13, fields: { enabled: 0 } };
    const plan = (await callTool(tool, args, w)) as Plan;

    expect(plan.diff).toContainEqual({ path: 'enabled', from: 1, to: 0 });
    expect(plan.after.call).toMatchObject({
      method: 'POST',
      path: '/admin/server',
      body: { server_id: 13, enabled: 0 },
    });
    expect(plan.rollback).toEqual({
      method: 'POST',
      path: '/admin/server',
      body: { server_id: 13, enabled: 1 },
    });

    await callTool(tool, { ...args, plan_id: plan.plan_id }, w);
    const write = w.calls.find((one) => one.method === 'POST');
    expect(write?.body).toEqual({ server_id: 13, enabled: 0 });
  });

  it('выключение объясняет, что группа замолчит, а не откажет', async () => {
    const w = world();
    const plan = (await callTool(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 7, fields: { enabled: 0 } },
      w,
    )) as Plan;
    const text = plan.sideEffects.join(' ');
    expect(text).toContain('No servers found in the group');
    expect(text).toContain('700');
  });

  it('создание сервера идёт PUT и требует группу, имя и транспорт', async () => {
    const w = world({ shmAction: () => 42 });
    const tool = serverEdit(w.deps);

    const bad = await callToolResult(
      tool,
      { action: 'create_server', fields: { name: 'new', transport: 'http' } },
      w,
    );
    expect(bad.ok).toBe(false);
    expect(bad.ok ? '' : bad.message).toMatch(/требует server_gid/);

    const args = {
      action: 'create_server',
      fields: { name: 'new-webhook', transport: 'http', server_gid: 10, host: 'https://example.org/hook' },
    };
    const applied = (await planThenApply(tool, args, w)) as { result: { server_id: number } };
    expect(applied.result.server_id).toBe(42);
    const write = w.calls.find((one) => one.method === 'PUT');
    expect(write?.path).toBe('/admin/server');
    expect(write?.body).toEqual(args.fields);
  });

  it('создание в несуществующую группу отбивается на плане', async () => {
    const w = world();
    const res = await callToolResult(
      serverEdit(w.deps),
      { action: 'create_server', fields: { name: 'x', transport: 'http', server_gid: 99 } },
      w,
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/группы server_gid=99 в SHM нет/);
  });

  it('удаляет группу без участников и отказывается удалять группу с ними', async () => {
    const w = world({ shmAction: () => 1 });
    const tool = serverEdit(w.deps);

    const busy = await callToolResult(tool, { action: 'delete_group', group_id: 10 }, w);
    expect(busy.ok).toBe(false);
    expect(busy.ok ? '' : busy.message).toMatch(/ссылается серверов: 1/);

    const protectedGroup = await callToolResult(tool, { action: 'delete_group', group_id: 1 }, w);
    expect(protectedGroup.ok).toBe(false);
    expect(protectedGroup.ok ? '' : protectedGroup.message).toMatch(/GROUP_ID_LOCAL|LOCAL/);
  });

  it('отказывается удалять сервер, на котором числятся услуги', async () => {
    const w = world();
    const res = await callToolResult(serverEdit(w.deps), { action: 'delete_server', server_id: 7 }, w);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/числится 700 услуг/);
    expect(res.ok ? '' : res.message).toMatch(/enabled=0/);
  });

  it('удаление свободного сервера уходит DELETE и проверяется перечитыванием', async () => {
    let rows: Record<string, unknown>[] = [HTTP_SERVER, SSH_SERVER, MAIL_SERVER];
    const w = makeWorld({
      shmGetRaw: (path: string) => (path === '/admin/server' ? rows : GROUPS),
      shmAction: () => {
        rows = rows.filter((one) => one.server_id !== 13);
        return 1;
      },
    });
    const applied = (await planThenApply(
      serverEdit(w.deps),
      { action: 'delete_server', server_id: 13 },
      w,
    )) as { result: { state: { exists: boolean } | null; drift?: unknown } };

    expect(w.calls.find((one) => one.method === 'DELETE')?.body).toEqual({ server_id: 13 });
    expect(applied.result.state?.exists).toBe(false);
    expect(applied.result.drift).toBeUndefined();
  });

  it('SHM ответил успехом, а строка на месте — это drift, а не молчаливый успех', async () => {
    const w = world({ shmAction: () => 1 });
    const applied = (await planThenApply(
      serverEdit(w.deps),
      { action: 'delete_server', server_id: 13 },
      w,
    )) as { result: { drift?: { field: string } } };
    expect(applied.result.drift?.field).toBe('exists');
  });
});

describe('server_edit × ops_confirm', () => {
  it('план применяется вторым инструментом — тем же телом и с той же сверкой мира', async () => {
    const w = world();
    const tool = serverEdit(w.deps);
    const plan = (await callTool(
      tool,
      { action: 'update_server', server_id: 13, fields: { weight: 50 } },
      w,
    )) as Plan;

    const applied = (await callTool(opsConfirm(w.deps, [tool]), { plan_id: plan.plan_id }, w)) as {
      status: string;
      tool: string;
    };
    expect(applied).toMatchObject({ status: 'applied', tool: 'server_edit' });
    expect(w.calls.find((one) => one.method === 'POST')?.body).toEqual({
      server_id: 13,
      weight: 50,
    });
  });
});

describe('server_edit: отказы и предусловия', () => {
  it('поле вне whitelist объясняется, а не молча выбрасывается', async () => {
    const w = world();
    const res = await callToolResult(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 13, fields: { services_count: 0 } },
      w,
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/счётчик услуг ведёт сам SHM/);
  });

  it('settings.key_id запрещён: проверить ключ нечем, а сломает он каждую ssh-задачу', async () => {
    const w = world();
    const res = await callToolResult(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 7, settings: { key_id: 9 } },
      w,
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/settings\.key_id запрещён/);
  });

  it('чужой enum транспорта и типа выборки отбиваются с перечислением допустимых', async () => {
    const w = world();
    const tool = serverEdit(w.deps);
    const transport = await callToolResult(
      tool,
      { action: 'update_server', server_id: 13, fields: { transport: 'grpc' } },
      w,
    );
    expect(transport.ok ? '' : transport.message).toMatch(/ssh, http, telegram, mail, local/);

    const type = await callToolResult(
      tool,
      { action: 'update_group', group_id: 10, fields: { type: 'round-robin' } },
      w,
    );
    expect(type.ok ? '' : type.message).toMatch(/random, by-one, evenly/);
  });

  it('у групп нет json-настроек — просьба их поправить объясняется, а не игнорируется', async () => {
    const w = world();
    const res = await callToolResult(
      serverEdit(w.deps),
      { action: 'update_group', group_id: 10, settings: { max_services: 1 } },
      w,
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/у групп серверов нет json-настроек/);
  });

  it('несуществующий id — отказ, а не правка первой попавшейся строки', async () => {
    const w = world();
    const res = await callToolResult(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 999, fields: { enabled: 0 } },
      w,
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/server_id=999 в SHM не найден/);
  });

  /**
   * Серверный фильтр — это ВОЗМОЖНОСТЬ, а не данность. Сборка, которая его
   * игнорирует, вернула бы на ?server_id=13 все строки, и правка по позиции
   * уехала бы в чужой транспорт.
   */
  it('строка ищется по ключу, а не берётся первой из списка', async () => {
    const w = makeWorld({
      // Фильтр демонстративно проигнорирован: список приходит целиком.
      shmGetRaw: (path: string) => (path === '/admin/server' ? [SSH_SERVER, HTTP_SERVER] : GROUPS),
      shmAction: () => [{ server_id: 13 }],
    });
    const plan = (await callTool(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 13, fields: { weight: 7 } },
      w,
    )) as Plan;
    expect(plan.before.name).toBe('telegram-http');
    expect(plan.after.call.body).toEqual({ server_id: 13, weight: 7 });
  });

  it('пустая правка не превращается в план', async () => {
    const w = world();
    const res = await callToolResult(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 13, fields: {} },
      w,
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/не передано ни одного поля/);
  });

  it('правка, не меняющая ничего, отбивается каркасом', async () => {
    const w = world();
    const res = await callToolResult(
      serverEdit(w.deps),
      { action: 'update_server', server_id: 13, fields: { enabled: 1 } },
      w,
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/ничего не меняет/);
  });

  it('уехавший мир между планом и применением останавливает запись', async () => {
    let rows: Record<string, unknown>[] = [HTTP_SERVER, SSH_SERVER, MAIL_SERVER];
    const w = makeWorld({
      shmGetRaw: (path: string) => (path === '/admin/server' ? rows : GROUPS),
      shmAction: () => [{ server_id: 13 }],
    });
    const tool = serverEdit(w.deps);
    const args = { action: 'update_server', server_id: 13, fields: { weight: 50 } };
    const plan = (await callTool(tool, args, w)) as Plan;

    // Кто-то поменял настройки той же строки — отпечаток разошёлся.
    rows = rows.map((one) =>
      one.server_id === 13 ? { ...one, settings: { template_id: 'другой шаблон' } } : one,
    );
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(
      /состояние изменилось/,
    );
    expect(w.calls.some((one) => one.method === 'POST')).toBe(false);
  });

  it('второй create между планом и применением ловится водяным знаком', async () => {
    let rows: Record<string, unknown>[] = [HTTP_SERVER];
    const w = makeWorld({
      shmGetRaw: (path: string) => (path === '/admin/server' ? rows : GROUPS),
      shmAction: () => 99,
    });
    const tool = serverEdit(w.deps);
    const args = {
      action: 'create_server',
      fields: { name: 'new', transport: 'http', server_gid: 10 },
    };
    const plan = (await callTool(tool, args, w)) as Plan;

    rows = [...rows, { ...HTTP_SERVER, server_id: 77, name: 'кто-то создал раньше нас' }];
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(
      /состояние изменилось/,
    );
  });
});
