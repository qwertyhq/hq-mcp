import { describe, expect, it } from 'vitest';
import type { TunnelConfig } from '@hq/types';
import { createRegistry } from '@hq/registry';
import { makeCtx } from './testkit.js';
import {
  UNKNOWN_CAPABILITIES,
  assertReadOnlySql,
  createAbuseReportTool,
  createPlatformProbeTool,
  createReadTools,
  createSqlQueryTool,
  probeTcp,
  resetAbuseBudget,
  resetProbeCache,
} from './index.js';

const tunnel: TunnelConfig = {
  abuseUrl: 'http://127.0.0.1:18099',
  postgres: { host: '127.0.0.1', port: 16767 },
  mysql: null,
  sshCommand: 'ssh -L 18099:192.0.2.10:8099 -L 16767:192.0.2.20:6767 jump-host',
};

describe('createReadTools', () => {
  it('builds exactly 38 read tools including the Remnawave 3.3 diagnostics', () => {
    const names = createReadTools({ tunnel })
      .map((def) => def.name)
      .sort();
    expect(names).toEqual([
      'abuse_report',
      'autopay_inspect',
      'billing_ledger',
      'catalog_read',
      'client_account_state',
      'client_billing_view',
      'client_catalog_view',
      'client_overview',
      'client_reach',
      'client_resolve',
      'client_search',
      'config_read',
      'connections_inspect',
      'country_health',
      'device_inventory',
      'infra_costs',
      'infra_map',
      'node_config_audit',
      'node_geocheck',
      'node_integrations_read',
      'notify_history',
      'panel_activity',
      'platform_probe',
      'promo_read',
      'provisioning_diagnose',
      'server_inventory',
      'server_status',
      'service_inspect',
      'shared_lists_read',
      'spool_inspect',
      'sql_query',
      'squads_read',
      'subpage_read',
      'subscription_inspect',
      'sync_audit',
      'template_read',
      'torrent_reports',
      'traffic_stats',
    ]);
  });

  it('gives every tool a name Messages API accepts after the mcp__ prefix', () => {
    // Имя доезжает до модели как mcp__hq-mcp__<name> и обязано матчить
    // ^[a-zA-Z0-9_-]{1,64}$. Точка сломала бы ВЕСЬ реестр разом, а сырой
    // JSON-RPC этого не ловит.
    for (const def of createReadTools({ tunnel })) {
      const exposed = `mcp__hq-mcp__${def.name}`;
      expect(exposed).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('registers all of them without a name or duplicate complaint', () => {
    const registry = createRegistry(createReadTools({ tunnel }));
    expect(registry.list({ mode: 'ro', profile: 'human' })).toHaveLength(38);
  });

  it('shows the bot exactly the 21 tools of its allowlist and nothing else', () => {
    // Этот список — контракт между тремя планами: BOT_ALLOWLIST плана 3 обязан
    // совпасть с ним строка в строку, иначе HTTP-профиль и stdio разъедутся.
    const registry = createRegistry(createReadTools({ tunnel }));
    const botNames = registry.list({ mode: 'ro', profile: 'bot' }).map((d) => d.name);
    expect(botNames).toEqual([
      'autopay_inspect',
      'billing_ledger',
      'catalog_read',
      'client_billing_view',
      'client_catalog_view',
      'client_overview',
      'client_resolve',
      'client_search',
      'connections_inspect',
      'country_health',
      'notify_history',
      'platform_probe',
      'promo_read',
      'provisioning_diagnose',
      // server_status: доступность серверов и имена в приложении — без адресов.
      'server_status',
      'service_inspect',
      'spool_inspect',
      'subpage_read',
      'subscription_inspect',
      'torrent_reports',
      'traffic_stats',
    ]);
    // Сырой доступ, топология, деньги и массовые выгрузки — только human.
    expect(botNames).not.toContain('sql_query');
    expect(botNames).not.toContain('abuse_report');
    expect(botNames).not.toContain('config_read');
    expect(botNames).not.toContain('infra_map');
    expect(botNames).not.toContain('sync_audit');
    // Инвентарь транспортов и расходы на инфраструктуру — не ответ на вопрос
    // клиента ни в одной формулировке.
    expect(botNames).not.toContain('server_inventory');
    expect(botNames).not.toContain('infra_costs');
    expect(botNames).not.toContain('client_account_state');
    expect(botNames).toHaveLength(21);
  });

  it('makes every human-only tool refuse the bot profile in its own handler', async () => {
    // Политика едина, а не «у трёх из пяти». Ни одна из этих проверок сегодня
    // сработать не может: executeTool выбирает инструмент ТОЛЬКО из
    // listVisibleTools, и вызов бота по имени человеческого инструмента
    // заканчивается «not found» до хендлера. Они стоят как защита второго слоя
    // для плана 3, где вызывающего пишем не мы, — и именно поэтому обязаны
    // стоять у ВСЕХ пятерых: выборочная защита читается как «этим двум она не
    // нужна», а разница между sync_audit и config_read не в этом.
    const inputs: Record<string, unknown> = {
      abuse_report: {},
      // client_account_state: перечень факторов входа — это карта того, каким
      // из них аккаунт НЕ защищён, плюс адрес почты. Соседний
      // client_billing_view боту открыт: деньги клиента — законный ответ
      // клиенту, способы входа в его аккаунт — нет.
      client_account_state: { shm_user_id: 1 },
      // client_reach: досягаемость клиента названа нодами, странами и тегами
      // инбаундов — та же топология, за которую human-only стоит squads_read,
      // только спрошенная с другого конца.
      client_reach: { user_id: 7 },
      config_read: { name: 'telegram' },
      // device_inventory: выгрузка привязок всего флота с адресами и
      // user-agent'ами. Не форма данных решает, а объём.
      device_inventory: { limit: 10 },
      // infra_costs: расходы компании и карта аренды — операторское знание, не
      // ответ на вопрос клиента.
      infra_costs: { limit: 50 },
      infra_map: {},
      // node_config_audit: вычисленный конфиг, имена профилей и теги инбаундов
      // — карта того, из чего собрана сеть.
      node_config_audit: { compare_computed: false },
      node_geocheck: { action: 'result', job_id: 'job-123' },
      node_integrations_read: {},
      shared_lists_read: {},
      // panel_activity: история обращений — поток адресов всей базы, остальное
      // — операторская картина самой панели.
      panel_activity: { include_requests: false },
      // server_inventory: как биллинг дотягивается до мира — SMTP-хосты, адреса
      // вебхуков, ёмкость провижининга и перечень заведённых кредов.
      server_inventory: {},
      sql_query: { target: 'postgres', sql: 'select 1' },
      // squads_read: сквады раскрывают топологию — ноды, страны, теги
      // инбаундов, — то есть тот же класс, что infra_map.
      squads_read: { accessible_nodes: false },
      // template_read: тело шаблона — живая логика биллинга и адреса хуков.
      template_read: {},
      sync_audit: { limit: 100 },
    };
    const humanOnly = createReadTools({ tunnel }).filter((def) => !def.profiles.includes('bot'));
    expect(humanOnly.map((def) => def.name).sort()).toEqual(Object.keys(inputs).sort());

    const ctx = makeCtx({
      profile: 'bot',
      shmList: () => [],
      shmGet: () => [],
      remnaGet: () => [],
    });
    for (const def of humanOnly) {
      await expect(def.handler(def.input.parse(inputs[def.name]), ctx)).rejects.toThrow(
        /human profile only/,
      );
    }
  });

  it('declares every read tool as ro so ro mode shows all of them', () => {
    expect(createReadTools({ tunnel }).every((def) => def.access === 'ro')).toBe(true);
  });

  it('gates no read tool behind a capability, and that is the design', () => {
    // Ни один читающий инструмент НЕ объявляет requires, и это решение, а не
    // недосмотр. platform_probe ставит tunnel.abuse/tunnel.postgres в жёсткий
    // false, когда TCP-проба не прошла, а Registry.list выбрасывает инструмент
    // с проверенно-ложной возможностью (packages/registry/src/index.ts:92-97).
    // Закрытый туннель — штатное состояние, поэтому abuse_report и sql_query
    // исчезали бы из tools/list ровно тогда, когда весь их смысл — сказать
    // «открой туннель вот такой командой»; исчезнувший инструмент учит модель,
    // что возможности нет вовсе. Гейт здесь допустим только у инструмента, чьё
    // отсутствие объясняет себя само, — а такого среди этих шестнадцати нет.
    const gated = createReadTools({ tunnel }).filter((def) => (def.requires ?? []).length > 0);
    expect(gated.map((def) => def.name)).toEqual([]);
  });

  it('re-exports the reset of every module-level state a rebuilt runtime shares', () => {
    // Барьер один на процесс: и кэш platform_probe, и бюджет abuse_report —
    // модульное состояние, переживающее пересборку рантайма. Тест, строящий
    // рантайм второй раз, наследует счётчик первого на живых часах, если
    // сбросить его нечем, и падает не там, где сломано.
    expect(typeof resetProbeCache).toBe('function');
    expect(typeof resetAbuseBudget).toBe('function');
  });

  it('keeps the whole documented surface exported, not just createReadTools', () => {
    // Реэкспорты — не украшение барреля: три фабрики нужны тестам, которые
    // строят один инструмент без остальных пятнадцати, probeTcp — сборке
    // рантайма, assertReadOnlySql и UNKNOWN_CAPABILITIES — планам 2 и 3.
    // Импорт наверху ловит удаление строки реэкспорта, а эти проверки —
    // подмену её на пустышку не того рода.
    expect(typeof createPlatformProbeTool).toBe('function');
    expect(typeof createAbuseReportTool).toBe('function');
    expect(typeof createSqlQueryTool).toBe('function');
    expect(typeof assertReadOnlySql).toBe('function');
    expect(typeof probeTcp).toBe('function');
    // Ничего не проверено — это НЕ «возможности нет»: значения обязаны быть
    // 'unknown', и никогда false.
    expect(Object.values(UNKNOWN_CAPABILITIES).every((value) => value === 'unknown')).toBe(true);
  });
});
