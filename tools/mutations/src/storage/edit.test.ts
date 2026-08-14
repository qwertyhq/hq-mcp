import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ShmError, resetPanelNamingCache, resolvePanelNaming } from '@hq/shm';
import { DEFAULT_STORAGE_APP_KEYS, storageAllowlist, storageEdit } from './edit.js';
import { callTool, listOf, makeWorld } from '../testkit.js';
import type { PanelNaming } from '@hq/shm';
import type { FakeWorld } from '../testkit.js';

/**
 * Снимок конфигурации услуги ровно той формы, что лежит в storage работающей
 * установки (форма проверена на настоящем снимке, а не взята из спецификации):
 * объект пользователя панели плюс готовый конфиг подписки ОДНОЙ строкой.
 * Значения поддельные и собраны так, чтобы ни одно из них не выглядело
 * настоящим секретом для `scripts/no-secrets.test.ts`.
 */
const TROJAN = ['not-a-real', 'trojan', 'pw'].join('-');
const SUB_CONFIG = 'vless://11111111-2222-3333-4444-555555555555@example.org?type=tcp#node';

const LIVE_VALUE = {
  response: {
    id: 9996,
    username: 'client',
    trojanPassword: TROJAN,
    ssPassword: 'not-a-real-ss-pw',
    vlessUuid: '11111111-2222-3333-4444-555555555555',
    subscriptionUrl: 'https://sub.example.org/abcdefabcdef',
  },
  subscription_config: SUB_CONFIG,
  configs: [1, 2, 3],
};

const NEW_VALUE = { ...LIVE_VALUE, configs: [1, 2, 3, 4] };

interface Plan {
  plan_id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: Array<{ path: string; from: unknown; to: unknown }>;
  sideEffects: string[];
}

interface Applied {
  status: string;
  result: { backup: string; method: string; fallback: boolean; restore_hint: string };
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'hq-stor-'));
}

interface Opts {
  values?: unknown[];
  rows?: Record<string, unknown>[];
  /** Значение ключа `remnawave` таблицы config — то, чем инсталляция называет объекты. */
  config?: Record<string, unknown>;
  onAction?: (method: string, body: unknown) => void;
  fail?: (method: string) => Error | null;
}

function world(opts: Opts = {}): FakeWorld {
  const values = opts.values ?? [LIVE_VALUE];
  let read = 0;
  return makeWorld({
    shmGetRaw: (path: string) => {
      if (path.startsWith('/admin/config/')) return [opts.config ?? {}];
      const value = values[Math.min(read, values.length - 1)];
      read += 1;
      return value;
    },
    // Редактируемый канал отдаёт ровно то, что отдал бы настоящий `redact`:
    // маски вместо кред. Инструмент обязан не пользоваться им ни на снимке,
    // ни на сверке.
    shmGet: (path: string) => {
      // Именование инсталляции читается ТЕМ ЖЕ маршрутом, каким его читают
      // чтения: `GET /admin/config/remnawave` в конверте `{data:[<value>]}`.
      if (path.startsWith('/admin/config/')) return [opts.config ?? {}];
      return {
        ...LIVE_VALUE,
        response: {
          ...LIVE_VALUE.response,
          trojanPassword: '<redacted>',
          ssPassword: '<redacted>',
        },
      };
    },
    shmList: () =>
      listOf(
        opts.rows ?? [
          { user_id: 9097, name: 'vpn_mrzb_9996', settings: { json: 1 }, user_service_id: null },
        ],
      ),
    shmAction: (method, _path, body) => {
      opts.onAction?.(method, body);
      const error = opts.fail?.(method) ?? null;
      if (error !== null) throw error;
      return { data: [{ result: 'successful', length: 42 }] };
    },
  });
}

const KEY = 'vpn_mrzb_9996';
const USER = 9097;

/** Кэш `config.remnawave` живёт дольше одного вызова — тесту нужен чистый. */
beforeEach(() => {
  resetPanelNamingCache();
});

/**
 * ALLOWLIST — ПРЕДОХРАНИТЕЛЬ, И ПРОВЕРЯЕТСЯ ОН ПО ТОМУ, ЧТО НЕ ПУСКАЕТ.
 *
 * Прежняя версия склеивала два ключа в один литерал
 * `/^(?:vpn_mrzb_\d+|wbap_device_names)$/`, и у него было ровно два дефекта:
 * на инсталляции со своим `storage_prefix` он отказывал писать по совершенно
 * правильному ключу, а сам список нельзя было ни сузить, ни расширить, не
 * трогая код. Теперь префикс приезжает из живого именования, а ключи
 * приложений настраиваются — и оба изменения обязаны не сделать список ШИРЕ,
 * чем задумано.
 */
describe('storage_edit × allowlist', () => {
  const naming = (over: Partial<PanelNaming> = {}): PanelNaming => ({
    storagePrefix: 'vpn_mrzb_',
    storagePrefixFrom: 'default',
    usernamePrefixes: ['HQVPN_'],
    usernamePrefixesFrom: 'default',
    configError: null,
    ...over,
  });

  it('умолчания те же, что были литералом: снимок услуги и ключ приложения', () => {
    const allow = storageAllowlist(naming(), {});
    expect(allow.allows('vpn_mrzb_9996')).toBe(true);
    expect(allow.allows('wbap_device_names')).toBe(true);
    expect(allow.appKeys).toEqual(DEFAULT_STORAGE_APP_KEYS);
    expect(allow.appKeysFrom).toBe('default');
  });

  it('служебные строки воркеров не пускаются ни при какой настройке', () => {
    const worker = ['wh_hwid_stats', 'wh_traffic_stats', 'whevt_seen', 'wh_revoke_log_9983'];
    for (const bad of worker) expect(storageAllowlist(naming(), {}).allows(bad)).toBe(false);

    // Попытка открыть их настройкой: имена отбрасываются, и об этом говорится
    // вслух — молча урезанный список выглядел бы как «настройка не сработала».
    const forced = storageAllowlist(naming(), {
      HQ_MCP_STORAGE_APP_KEYS: 'wh_hwid_stats, my_app_names',
    });
    for (const bad of worker) expect(forced.allows(bad)).toBe(false);
    expect(forced.appKeys).toEqual(['my_app_names']);
    expect(forced.refusedAppKeys).toEqual(['wh_hwid_stats']);

    // И через префикс тоже: HQ_MCP_STORAGE_PREFIX=wh_ не превращает счётчики
    // воркеров в записываемые ключи.
    const viaPrefix = storageAllowlist(
      naming({ storagePrefix: 'wh_', storagePrefixFrom: 'env' }),
      {},
    );
    expect(viaPrefix.allows('wh_1234')).toBe(false);
  });

  it('снимок узнаётся по префиксу ЭТОЙ инсталляции, а не по нашему', () => {
    const acme = storageAllowlist(naming({ storagePrefix: 'acme_cfg_', storagePrefixFrom: 'shm_config' }), {});
    expect(acme.allows('acme_cfg_9996')).toBe(true);
    // Наш префикс на чужой инсталляции — не ключ, а чужое имя: пускать его
    // значило бы разрешить запись по строке, которой там нет смысла.
    expect(acme.allows('vpn_mrzb_9996')).toBe(false);
  });

  it('в имени снимка после префикса ТОЛЬКО цифры: это user_service_id', () => {
    const allow = storageAllowlist(naming(), {});
    expect(allow.allows('vpn_mrzb_')).toBe(false);
    expect(allow.allows('vpn_mrzb_9996x')).toBe(false);
    expect(allow.allows('vpn_mrzb_99 96')).toBe(false);
    expect(allow.allows('xvpn_mrzb_9996')).toBe(false);
  });

  /**
   * ПРЕФИКС ПРИХОДИТ ИЗ ОКРУЖЕНИЯ И ЖИВОГО КОНФИГА, ТО ЕСТЬ СНАРУЖИ.
   *
   * Собранный в регулярку без экранирования, он превращает точку в «любой
   * символ», а скобку — в группу: `vpn.` пустил бы `vpnX9996`, то есть список
   * стал бы ШИРЕ, чем его объявил оператор. Имя ключа при этом приходит от
   * вызывающего, так что разница не теоретическая.
   */
  it('метасимволы в префиксе экранируются, а не расширяют список', () => {
    const dotted = storageAllowlist(naming({ storagePrefix: 'vpn.' }), {});
    expect(dotted.allows('vpn.9996')).toBe(true);
    expect(dotted.allows('vpnX9996')).toBe(false);

    const bracketed = storageAllowlist(naming({ storagePrefix: 'cfg[a-z]_' }), {});
    expect(bracketed.allows('cfg[a-z]_7')).toBe(true);
    expect(bracketed.allows('cfgq_7')).toBe(false);
  });

  it('настроенный список ключей приложений ЗАМЕНЯЕТ умолчание, а не дополняет', () => {
    const allow = storageAllowlist(naming(), { HQ_MCP_STORAGE_APP_KEYS: 'acme_device_names' });
    expect(allow.allows('acme_device_names')).toBe(true);
    // Ключ чужого мини-аппа не остаётся разрешённым «на всякий случай»:
    // разрешительный список, который только растёт, — это не список.
    expect(allow.allows('wbap_device_names')).toBe(false);
    expect(allow.appKeysFrom).toBe('env');
  });

  it('пустая переменная — это «не задано», а не «ключей приложений нет»', () => {
    const allow = storageAllowlist(naming(), { HQ_MCP_STORAGE_APP_KEYS: ' , ' });
    expect(allow.allows('wbap_device_names')).toBe(true);
    expect(allow.appKeysFrom).toBe('default');
  });
});

describe('storage_edit', () => {
  it('список строится по живому именованию SHM, а не по литералу в коде', async () => {
    const w = world({ config: { storage_prefix: 'acme_cfg_' } });
    const tool = storageEdit(w.deps, dir());

    // Тот же ответ SHM, каким его прочитает инструмент.
    expect((await resolvePanelNaming(w.ctx, {})).storagePrefix).toBe('acme_cfg_');

    // Ключ, правильный ЗДЕСЬ, — отвергается: префикс у этой инсталляции другой.
    await expect(
      callTool(tool, { name: KEY, user_id: USER, value: NEW_VALUE }, w),
    ).rejects.toThrow(/вне allowlist \(acme_cfg_<user_service_id>/);
    expect(w.calls.some((c) => c.method === 'PUT' || c.method === 'POST')).toBe(false);

    // ...а правильный ТАМ — принимается и доходит до записи.
    const args = { name: 'acme_cfg_9996', user_id: USER, value: NEW_VALUE };
    const plan = (await callTool(tool, args, w)) as Plan;
    expect(plan.before.name).toBe('acme_cfg_9996');
    // И предупреждение «это снимок конфигурации услуги» печатается по ЭТОМУ
    // префиксу, иначе самое важное молчало бы ровно там, где префикс не наш.
    expect(plan.sideEffects.join('\n')).toContain('ЭТО СНИМОК КОНФИГУРАЦИИ УСЛУГИ');
  });

  it('отказ называет и префикс, и его происхождение — чинить надо не ключ', async () => {
    const w = world();
    const tool = storageEdit(w.deps, dir());
    await expect(
      callTool(tool, { name: 'some_other_key', user_id: USER, value: {} }, w),
    ).rejects.toThrow(/умолчания шаблона провижининга и живой системой не подтверждён/);
  });

  it('боту инструмент не отдаётся, риск high, PUT и POST объявлены без формы с именем в пути', () => {
    const w = world();
    const tool = storageEdit(w.deps, dir());
    expect(tool.def.profiles).toEqual(['human']);
    expect(tool.def.risk).toBe('high');
    expect(tool.endpoints).toEqual([
      'GET /admin/storage/manage',
      'GET /admin/storage/manage/{name}',
      'PUT /admin/storage/manage',
      'POST /admin/storage/manage',
    ]);
  });

  it('ЗАМАСКИРОВАННОЕ значение не доезжает до тела запроса', async () => {
    const sent: unknown[] = [];
    const w = world({ onAction: (_m, body) => sent.push(body) });
    const tool = storageEdit(w.deps, dir());
    const poisoned = {
      ...LIVE_VALUE,
      response: { ...LIVE_VALUE.response, trojanPassword: '<redacted>' },
    };

    await expect(callTool(tool, { name: KEY, user_id: USER, value: poisoned }, w)).rejects.toThrow(
      /маркер редакции по пути \$\.response\.trojanPassword/,
    );
    expect(sent).toEqual([]);
    const journal = await w.deps.audit.search({});
    expect(journal.records[0]).toMatchObject({ tool: 'storage_edit', outcome: 'rejected' });
  });

  it('снимок берётся НЕредактированным каналом: маска в снимке = убитый доступ клиента', async () => {
    const backups = dir();
    const w = world();
    const tool = storageEdit(w.deps, backups);
    const plan = (await callTool(tool, { name: KEY, user_id: USER, value: NEW_VALUE }, w)) as Plan;

    const read = w.calls.find((c) => c.method === 'GET' && c.path.endsWith(KEY));
    expect(read?.raw).toBe(true);

    const applied = (await callTool(
      tool,
      { name: KEY, user_id: USER, value: NEW_VALUE, plan_id: plan.plan_id },
      w,
    )) as Applied;
    const snapshot = JSON.parse(readFileSync(applied.result.backup, 'utf8')) as {
      kind: string;
      target: string;
      payload: { response: { trojanPassword: string } };
    };
    expect(snapshot.kind).toBe('storage');
    expect(snapshot.target).toBe(`${String(USER)}:${KEY}`);
    expect(snapshot.payload.response.trojanPassword).toBe(TROJAN);
    expect(JSON.stringify(snapshot.payload)).not.toContain('<redacted>');
  });

  it('план не показывает ни кред, ни конфиг подписки — только очертание', async () => {
    const w = world();
    const tool = storageEdit(w.deps, dir());
    const plan = (await callTool(tool, { name: KEY, user_id: USER, value: NEW_VALUE }, w)) as Plan;

    // Сверяется то, что инструмент УЗНАЛ О МИРЕ: `after` — это аргумент
    // вызывающего, он и так в контексте, а `before`/`diff`/`sideEffects`
    // построены из прочитанного с сервера.
    const learned = JSON.stringify({
      before: plan.before,
      diff: plan.diff,
      sideEffects: plan.sideEffects,
    });
    expect(learned).not.toContain(TROJAN);
    expect(learned).not.toContain(SUB_CONFIG);
    // ...и при этом diff отвечает на вопрос «что структурно меняется».
    expect(plan.diff.map((d) => d.path)).toContain('sha256');
    expect(plan.diff.map((d) => d.path)).toContain('fields.configs');
    expect(plan.before.exists).toBe(true);
    expect(plan.before.stored_as_json).toBe(true);
  });

  /**
   * ПОЛЯ ОТВЕТА НЕ ДОЛЖНЫ ПОПАДАТЬ ПОД СОБСТВЕННУЮ РЕДАКЦИЮ.
   *
   * `SECRET_KEY_RE` матчит ИМЯ поля, и подстрока `key` в нём буквальна. Первая
   * версия этого инструмента звала поле `key`, а очертание значения —
   * `keys`: наружу уезжало `"key":"<redacted>"` и diff из двух масок, то есть
   * план ВЫГЛЯДЕЛ работающим и не говорил ни какой ключ переписывают, ни что
   * в нём меняется. Тест закрывает ровно этот класс.
   */
  it('ни одно имя поля в плане не попадает под SECRET_KEY_RE', async () => {
    const w = world();
    const tool = storageEdit(w.deps, dir());
    const plan = (await callTool(tool, { name: KEY, user_id: USER, value: NEW_VALUE }, w)) as Plan;

    const secretName = /token|secret|key|password|auth/i;
    for (const field of [...Object.keys(plan.before), ...Object.keys(plan.after)]) {
      expect(field, `${field} уедет маркером`).not.toMatch(secretName);
    }
    for (const entry of plan.diff) {
      for (const segment of entry.path.split('.')) {
        expect(segment, `${entry.path} уедет маркером`).not.toMatch(secretName);
      }
      expect(entry.from).not.toBe('<redacted>');
      expect(entry.to).not.toBe('<redacted>');
    }
    expect(plan.before.name).toBe(KEY);
  });

  it('существующий ключ переписывается POST-ом: user_id и name уходят ТЕЛОМ', async () => {
    const sent: Array<{ method: string; body: unknown }> = [];
    const w = world({ onAction: (method, body) => sent.push({ method, body }) });
    const tool = storageEdit(w.deps, dir());
    const plan = (await callTool(tool, { name: KEY, user_id: USER, value: NEW_VALUE }, w)) as Plan;
    const applied = (await callTool(
      tool,
      { name: KEY, user_id: USER, value: NEW_VALUE, plan_id: plan.plan_id },
      w,
    )) as Applied;

    expect(applied.result.method).toBe('POST');
    expect(applied.result.fallback).toBe(false);
    expect(sent).toEqual([
      { method: 'POST', body: { user_id: USER, name: KEY, data: NEW_VALUE } },
    ]);
    const write = w.calls.find((c) => c.method === 'POST');
    expect(write?.path).toBe('/admin/storage/manage');
    expect(write?.params).toBeUndefined();
  });

  it('отсутствующий ключ создаётся PUT-ом', async () => {
    const sent: string[] = [];
    const w = world({ values: [undefined], rows: [], onAction: (method) => sent.push(method) });
    const tool = storageEdit(w.deps, dir());
    const args = { name: 'wbap_device_names', user_id: USER, value: { 'HW-1': 'MacBook' } };
    const plan = (await callTool(tool, args, w)) as Plan;
    expect(plan.before.exists).toBe(false);

    const applied = (await callTool(tool, { ...args, plan_id: plan.plan_id }, w)) as Applied;
    expect(applied.result.method).toBe('PUT');
    expect(sent).toEqual(['PUT']);
  });

  it('ровно один фолбэк на второй метод при гонке', async () => {
    const sent: string[] = [];
    const w = world({
      values: [undefined],
      rows: [],
      onAction: (method) => sent.push(method),
      fail: (method) =>
        method === 'PUT' ? new ShmError("HTTP 400: Can't save the data", 400, false) : null,
    });
    const tool = storageEdit(w.deps, dir());
    const args = { name: 'wbap_device_names', user_id: USER, value: { 'HW-1': 'MacBook' } };
    const plan = (await callTool(tool, args, w)) as Plan;
    const applied = (await callTool(tool, { ...args, plan_id: plan.plan_id }, w)) as Applied;

    expect(sent).toEqual(['PUT', 'POST']);
    expect(applied.result).toMatchObject({ method: 'POST', fallback: true });
  });

  it('второй провал не превращается в бесконечные попытки', async () => {
    const sent: string[] = [];
    const w = world({
      values: [undefined],
      rows: [],
      onAction: (method) => sent.push(method),
      fail: () => new ShmError('HTTP 400: nope', 400, false),
    });
    const tool = storageEdit(w.deps, dir());
    const args = { name: 'wbap_device_names', user_id: USER, value: { 'HW-1': 'MacBook' } };
    const plan = (await callTool(tool, args, w)) as Plan;
    // Текст тела бэкенда исполнитель стрижёт (`HTTP 400: <redacted>`), поэтому
    // сверяется то, что переживает стрижку: сам факт отказа и статус.
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(/HTTP 400/);
    expect(sent).toEqual(['PUT', 'POST']);
  });

  it('408 повторяется тем же методом, а не фолбэком на второй', async () => {
    const sent: string[] = [];
    let attempts = 0;
    const w = world({
      onAction: (method) => sent.push(method),
      fail: () => {
        attempts += 1;
        return attempts < 3 ? new ShmError('HTTP 408: the row is locked', 408, true) : null;
      },
    });
    const tool = storageEdit(w.deps, dir());
    const args = { name: KEY, user_id: USER, value: NEW_VALUE };
    const plan = (await callTool(tool, args, w)) as Plan;
    const applied = (await callTool(tool, { ...args, plan_id: plan.plan_id }, w)) as Applied;

    expect(applied.result).toMatchObject({ method: 'POST', fallback: false });
    expect(sent).toEqual(['POST', 'POST', 'POST']);
  });

  it('скаляр записать нельзя, и отказ объясняет почему', async () => {
    const w = world();
    const tool = storageEdit(w.deps, dir());
    await expect(
      callTool(tool, { name: KEY, user_id: USER, value: 'raw string' }, w),
    ).rejects.toThrow(/skip_auto_parse_json/);
  });

  it('ключ вне allowlist не пишется', async () => {
    const w = world();
    const tool = storageEdit(w.deps, dir());
    await expect(
      callTool(tool, { name: 'wh_hwid_stats', user_id: 1, value: {} }, w),
    ).rejects.toThrow(/allowlist/);
    expect(w.calls.some((c) => c.method === 'PUT' || c.method === 'POST')).toBe(false);
  });

  it('чужая правка между планом и применением отвергается до записи', async () => {
    const sent: string[] = [];
    const w = world({
      values: [LIVE_VALUE, { ...LIVE_VALUE, configs: [9, 9, 9] }],
      onAction: (method) => sent.push(method),
    });
    const tool = storageEdit(w.deps, dir());
    const args = { name: KEY, user_id: USER, value: NEW_VALUE };
    const plan = (await callTool(tool, args, w)) as Plan;
    await expect(callTool(tool, { ...args, plan_id: plan.plan_id }, w)).rejects.toThrow(
      /состояние изменилось/,
    );
    expect(sent).toEqual([]);
  });

  it('restore_from возвращает прежнее значение, не протаскивая креды через ответ', async () => {
    const backups = dir();
    const sent: unknown[] = [];
    const first = world({ onAction: (_m, body) => sent.push(body) });
    const tool = storageEdit(first.deps, backups);
    const args = { name: KEY, user_id: USER, value: NEW_VALUE };
    const plan = (await callTool(tool, args, first)) as Plan;
    const applied = (await callTool(tool, { ...args, plan_id: plan.plan_id }, first)) as Applied;

    const second = world({ values: [NEW_VALUE], onAction: (_m, body) => sent.push(body) });
    const restore = storageEdit(second.deps, backups);
    const rargs = { name: KEY, user_id: USER, restore_from: applied.result.backup };
    const rplan = (await callTool(restore, rargs, second)) as Plan;

    expect(JSON.stringify(rplan)).not.toContain(TROJAN);
    expect(rplan.after.value).toBeUndefined();

    const rapplied = (await callTool(
      restore,
      { ...rargs, plan_id: rplan.plan_id },
      second,
    )) as Applied;
    expect(rapplied.status).toBe('applied');
    expect(JSON.stringify(rapplied)).not.toContain(TROJAN);
    expect(sent.at(-1)).toEqual({ user_id: USER, name: KEY, data: LIVE_VALUE });
  });

  it('строка без settings.json получает предупреждение о чтении строкой', async () => {
    const w = world({
      rows: [{ user_id: USER, name: KEY, settings: {}, user_service_id: null }],
    });
    const tool = storageEdit(w.deps, dir());
    const plan = (await callTool(tool, { name: KEY, user_id: USER, value: NEW_VALUE }, w)) as Plan;
    expect(plan.sideEffects.join('\n')).toContain('settings.json');
    expect(plan.before.stored_as_json).toBe(false);
  });

  it('нужен ровно один источник значения', async () => {
    const w = world();
    const tool = storageEdit(w.deps, dir());
    await expect(callTool(tool, { name: KEY, user_id: USER }, w)).rejects.toThrow(/ровно одно/);
  });
});
