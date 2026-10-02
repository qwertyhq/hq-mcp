import { beforeEach, describe, expect, it } from 'vitest';
import { REDACTED, redact } from '@hq/redact';
import { executeTool } from '@hq/exec';
import { createRegistry } from '@hq/registry';
import { renameSafeRemnaKeys } from '@hq/remna';
import { renameSafeShmKeys } from '@hq/shm';
import type { Profile, ToolContext, TunnelConfig } from '@hq/types';
import { createReadTools, resetAbuseBudget, resetProbeCache } from './index.js';
import { makeCtx, makeTcpProbe } from './testkit.js';

/**
 * РЕДАКЦИЯ ВИДИТ ТОЛЬКО ИМЕНА ПОЛЕЙ, И ЭТО ЛОВУШКА.
 *
 * `SECRET_KEY_RE` (/token|secret|key|password|auth/i) в @hq/redact проверяется
 * по ИМЕНИ ключа, а не по значению, и слово `key` матчится буквально. Поле,
 * названное `key` или `uniq_key`, приезжает вызывающему как '<redacted>' в
 * КАЖДОМ настоящем ответе — при этом ни один тест инструмента этого не видел:
 * все они зовут `tool.handler(...)` напрямую со стабами, которые не
 * редактируют, а редакция накладывается ДВАЖДЫ и снаружи хендлера —
 * в HTTP-клиентах (@hq/shm, @hq/remna: ответ приходит в инструмент уже
 * маскированным) и в исполнителе (packages/exec/src/index.ts) на выходе. Оба
 * поведения — «поле есть» и «поле съедено» — были одинаково зелёными.
 *
 * Поэтому здесь собран ВЕСЬ настоящий конвейер: стабы отдают то, что отдал бы
 * клиент (те же переименование и redact), инструмент гоняется ЧЕРЕЗ
 * executeTool, а из ответа собираются все пути, где лежит маркер редакции.
 * Список ожиданий ниже — закрытый: новое замаскированное поле роняет тест, и
 * добавить его можно только руками, объяснив, почему маскировка здесь —
 * замысел, а не потеря.
 *
 * Обратной проверки «ключ матчит SECRET_KEY_RE, но не замаскирован» здесь нет
 * намеренно: такого исхода не бывает по построению — `redactField` отдаёт
 * REDACTED до того, как заглянуть в значение, — то есть множество «имя под
 * регуляркой» и множество «значение равно маркеру» совпадают.
 *
 * Профиль — 'human': это рабочий контур stdio и самый широкий срез (видны все
 * 16 инструментов, PII не маскируется). Профиль 'bot' маскирует СТРОГО больше
 * (PII по §7.2), поэтому чистый 'human' — необходимое условие для обоих.
 */

const tunnel: TunnelConfig = {
  abuseUrl: 'http://127.0.0.1:18099',
  postgres: { host: '127.0.0.1', port: 16767 },
  mysql: { host: '127.0.0.1', port: 13306 },
  sshCommand: 'ssh -L 18099:192.0.2.10:8099 jump-host',
  abuseToken: 'guard-secret',
};

/**
 * Имена полей — НАСТОЯЩИЕ, снятые с работающих ручек SHM, а не придуманные под
 * тест (значения выдуманы). Ровно они и решают: `uniq_key` у платежа и
 * `password` у пользователя существуют на самом деле, и правило маскирования по
 * имени встречает их в каждом ответе.
 */
const SHM_USER = {
  user_id: 1,
  login: 'client1',
  login2: 'client1@example.test',
  full_name: 'Test Client',
  block: 0,
  balance: 12.5,
  bonus: 3,
  password: 'not-a-real-hash',
  settings: { telegram: { chat_id: 5000001 } },
};

const SHM_PAY = {
  id: 10,
  user_id: 1,
  date: '2026-08-01 10:00:00',
  money: 100,
  pay_system_id: 'platega',
  uniq_key: 'platega-7f3a',
  comment: 'top up',
};

/**
 * Строка автоплатежа. Ключи — настоящие, вместе с обоими написаниями:
 * комментарий приезжает ОБЪЕКТОМ, то есть redact идёт по нему рекурсивно и
 * маскирует по именам его полей ровно так же, как по полям строки. Без этой
 * фикстуры autopay_inspect проверялся бы на клиенте без автоплатежа, то есть ни
 * одно его поле через редакцию не проходило бы вовсе.
 */
const SHM_AUTOPAY_PAY = {
  id: 11,
  user_id: 1,
  date: '2026-08-12 21:37:02',
  money: 300,
  pay_system_id: 'platega_sub',
  uniq_key: 'platega-sub-9c1',
  comment: {
    amount: 300,
    currency: 'RUB',
    id: 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee',
    nextchargeat: '2026-09-12T18:36:59.8051299Z',
    payload: '',
    paymentmethod: 6,
    status: 'CONFIRMED',
    subscriptionid: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  },
};

const SHM_AUTOPAY_FEE = {
  id: 12,
  user_id: 1,
  date: '2026-08-12 21:38:52',
  money: -27,
  pay_system_id: 'platega_sub-fee',
  uniq_key: 'platega-sub-fee-9c1',
  comment: {
    charge_amount: 300,
    charge_date: '2026-08-12 21:37:02',
    charge_source: 'pays_history',
    charges_count: 1,
    fee_rate: 0.09,
    kind: 'autopay_cancel_fee',
    reason: 'client_cancel',
    subscription_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  },
};

const SHM_SERVICE = {
  user_service_id: 51,
  user_id: 1,
  service_id: 2,
  name: 'VPN',
  status: 'ACTIVE',
  created: '2026-07-01 10:00:00',
  expire: '2026-09-01 10:00:00',
  next: null,
  parent: null,
  settings: {},
  config: {},
  cost: 100,
  withdraws: [],
};

const SHM_WITHDRAW = {
  withdraw_id: 4,
  user_id: 1,
  user_service_id: 51,
  service_id: 2,
  name: 'VPN',
  total: 100,
  cost: 100,
  bonus: 0,
  months: 1,
  qnt: 1,
  discount: 0,
  create_date: '2026-07-01 10:00:00',
  withdraw_date: '2026-07-01 10:00:01',
  end_date: '2026-08-01 10:00:00',
};

const SHM_SPOOL = {
  id: 900,
  user_id: 1,
  user_service_id: 51,
  event: { name: 'create', title: 'Provision' },
  status: 'SUCCESS',
  created: '2026-08-08 11:59:00',
  executed: '2026-08-08 11:59:30',
  delayed: 0,
  prio: 0,
  // Форма настоящей строки истории целиком, включая ветки, которые ни один
  // инструмент отдавать не должен: токен бота лежит в ЗНАЧЕНИИ url, а текст
  // сообщения и chat_id — в content. Редакция их не видит: она смотрит на
  // ИМЕНА полей. Проверку «наружу это не уехало» делают тесты самих
  // инструментов (spool/inspect.test.ts, notify/history.test.ts) — здесь
  // фикстура нужна затем, чтобы конвейер редакции гонялся по настоящей форме.
  response: {
    delivered: true,
    delivery: { code: '200', status: 'DELIVERED', template_id: 'tg_pay_admin' },
    message: 'successful',
    request: {
      content: '{"chat_id":-100100100,"text":"payment received"}',
      headers: null,
      method: 'POST',
      url: 'https://api.telegram.org/bot1111111111:AAtest-not-a-real-token/sendMessage',
    },
    response: { ok: true, result: { chat: { id: -100100100, title: 'notifications' } } },
    server: { host: '192.0.2.10', id: 18, key_id: 'ssh-key-1', port: '22' },
    spool: { duration: 0.09806, finished: 1, pid: 8, started: 1 },
    status: { code: '200', line: '200 OK' },
  },
  settings: { pay_id: 11, user_service_id: 51 },
};

/** Карта пользователя панели: креды в ней живые и ОБЯЗАНЫ маскироваться. */
const REMNA_USER = {
  id: 7,
  username: 'HQVPN_51',
  status: 'ACTIVE',
  telegramId: 5000001,
  tag: null,
  expireAt: '2026-09-01T10:00:00.000Z',
  trafficLimitBytes: 0,
  description: 'user_id: 1',
  trojanPassword: 'trojan-secret-value',
  vlessUuid: '11111111-2222-3333-4444-555555555555',
  subscriptionUrl: 'https://sub.example.test/aaaabbbbccccdddd',
  userTraffic: { usedTrafficBytes: 1024, lifetimeUsedTrafficBytes: 2048, onlineAt: null },
  activeInternalSquads: [{ uuid: 'sq-1', name: 'de' }],
};

/**
 * Строка панели, не связанная ни с одной услугой: имя без user_service_id,
 * а telegram id и `US_ID:` в описании не принадлежат ни одному известному
 * клиенту. Нужна ровно затем, чтобы sync_audit наполнил корзину
 * `orphanPanelUser` — иначе поле, которым она объясняет находку, ни одним
 * прогоном не проверяется.
 */
const REMNA_ORPHAN = {
  id: 8,
  username: 'legacy-account',
  status: 'DISABLED',
  telegramId: 5999999,
  description: 'SHM_info- @5999999, Ghost Client, US_ID: 4242',
};

/**
 * Живые подключения приезжают НЕ значением, а задачей: POST отдаёт `{jobId}`,
 * GET по этому id — `{isCompleted, isFailed, progress, result}`. Форма снята с
 * работающей панели 3.2.3 (адреса выдуманы, поля — настоящие): у адреса
 * ровно два ключа, `ip` и `lastSeen`, и именно `ip` — то единственное имя, по
 * которому @hq/redact вообще способна замаскировать адрес.
 */
const REMNA_JOB = { jobId: '12' };

const REMNA_CONNECTIONS_BY_USER = {
  isCompleted: true,
  isFailed: false,
  progress: { total: 1, completed: 1, percent: 100 },
  result: {
    success: true,
    userId: 7,
    nodes: [
      {
        nodeUuid: '99999999-8888-7777-6666-555555555555',
        nodeName: 'DE-1',
        countryCode: 'DE',
        ips: [
          { ip: '203.0.113.11', lastSeen: '2026-08-08T11:59:00.000Z' },
          { ip: '198.51.100.22', lastSeen: '2026-08-08T11:58:00.000Z' },
        ],
      },
    ],
  },
};

const REMNA_CONNECTIONS_BY_NODE = {
  isCompleted: true,
  isFailed: false,
  result: {
    success: true,
    nodeUuid: '99999999-8888-7777-6666-555555555555',
    users: [{ userId: 7, ips: [{ ip: '203.0.113.11', lastSeen: '2026-08-08T11:59:00.000Z' }] }],
  },
};

/** График трафика клиента: `series` — ряд по дням на каждую ноду. */
const REMNA_USER_USAGE = {
  categories: ['2026-08-01', '2026-08-02'],
  sparklineData: [10, 20],
  topNodes: [
    {
      uuid: '99999999-8888-7777-6666-555555555555',
      color: '#000000',
      name: 'DE-1',
      countryCode: 'DE',
      total: 30,
    },
  ],
  series: [
    {
      uuid: '99999999-8888-7777-6666-555555555555',
      name: 'DE-1',
      color: '#000000',
      countryCode: 'DE',
      total: 30,
      data: [10, 20],
    },
  ],
};

const REMNA_SQUAD_USER_USAGE = {
  days: [
    { date: '2026-08-01', nodes: [{ uuid: '99999999-8888-7777-6666-555555555555', totalBytes: 10 }] },
    { date: '2026-08-02', nodes: [{ uuid: '99999999-8888-7777-6666-555555555555', totalBytes: 20 }] },
  ],
};

const REMNA_DEVICES = {
  total: 2,
  devices: [
    { hwid: 'hw-1', platform: 'ios', deviceModel: 'iPhone', createdAt: '2026-08-01T00:00:00.000Z' },
    { hwid: 'hw-2', platform: 'android', deviceModel: 'Pixel', createdAt: '2026-08-02T00:00:00.000Z' },
  ],
};

const REMNA_NODE = {
  uuid: '99999999-8888-7777-6666-555555555555',
  name: 'DE-1',
  countryCode: 'DE',
  isConnected: true,
  isDisabled: false,
  usersOnline: 3,
  integrationUuids: ['11111111-1111-4111-8111-111111111111'],
  activePluginUuid: 'plugin-1',
  configProfile: { activeConfigProfileUuid: 'cp-1', activeInbounds: [{ uuid: 'in-1' }] },
};

const REMNA_HOST = {
  uuid: 'host-1',
  remark: 'DE reality',
  address: 'de1.example.test',
  port: 443,
  isDisabled: false,
  inbound: { configProfileInboundUuid: 'in-1' },
};

/**
 * Строка /admin/server НАСТОЯЩЕЙ ФОРМЫ: `settings` несёт пароль и заголовок с
 * ключом (их редакция маскирует по имени), а `host` — токен бота ВНУТРИ
 * значения, где никакого имени над ним нет. Нужна здесь затем, чтобы
 * server_inventory прогонялся через настоящий конвейер редакции на данных, где
 * редакции заведомо недостаточно.
 */
const SHM_SERVER = {
  server_id: 13,
  server_gid: 10,
  name: 'telegram-http',
  transport: 'http',
  host: 'https://api.telegram.org/bot1111111111:AAtest-not-a-real-token/sendMessage',
  ip: null,
  enabled: 1,
  weight: 100,
  services_count: 0,
  settings: {
    headers: { 'api-key': 'not-a-real-api-key' },
    key_id: 'ssh-key-1',
    max_services: 0,
    template_id: 'http',
  },
};

/**
 * Промокод и одно его применение. Строк ДВЕ намеренно: у промокодов «сам код»
 * и «факт применения» — разные строки одной таблицы, и инструмент обязан
 * пройти редакцией по обеим.
 */
const SHM_PROMO = [
  {
    id: 'FREEWORM',
    created: '2026-07-29 20:18:23',
    expire: null,
    used: null,
    used_by: null,
    user_id: 1,
    template_id: 'add_bonus',
    settings: { amount: 150, prefix: 'PROMO_', quantity: 937, reusable: 1, status: 1 },
  },
  {
    id: 'FREEWORM',
    created: '2026-08-10 12:06:51',
    expire: null,
    used: '2026-08-10 12:06:51',
    used_by: 1,
    user_id: 1,
    template_id: 'add_bonus',
    settings: { amount: 150, quantity: 938, reusable: 1, status: 1 },
  },
];

/**
 * Строка шаблона. Тело собрано СКЛЕЙКОЙ, а не литералом: `scripts/no-secrets`
 * не пускает JWT в трекаемый файл, и фикстура, ради которой пришлось бы
 * ослабить этот запрет, доказывала бы ровно не то. `settings` пуст, как у
 * большинства настоящих шаблонов.
 */
const SHM_TEMPLATE = {
  id: 'hwid_blocker',
  settings: {},
  data: [
    '{{ # блокировка по HWID }}',
    `{{ REMNA_TOKEN = "${['eyJ', 'hbGciOiJIUzI1NiJ9'].join('')}.${['eyJ', 'zdWIiOiJhYmMifQ'].join('')}.Sfl5c1TJSMeKKF2QT4fwpMeJf36POk6yJVadQssw6AB" }}`,
    '{{ http.post("$API_URL/api/hwid/devices/delete") }}',
  ].join('\n'),
};

/**
 * КЛИЕНТСКАЯ ЧАСТЬ API SHM — ТА, ГДЕ СЕКРЕТ ЛЕЖИТ ВНУТРИ ЗНАЧЕНИЯ.
 *
 * Формы сняты с работающей SHM 2.19.4 (значения выдуманы, имена полей
 * настоящие). Каждая фикстура здесь несёт то, чего редакция по ИМЕНИ поля не
 * видит по построению:
 *  - `shm_url` предложенного способа оплаты — готовая ссылка, создающая платёж,
 *    с user_id и меткой времени в query;
 *  - `name` способа оплаты и `name` ключа доступа — свободный текст из
 *    конфигурации и от клиента, то есть место, куда непрозрачная строка
 *    попадает без всякого «секретного» имени над ней;
 *  - значения записи о рекуррентном методе — идентификатор подписки, маска
 *    карты и то, чем с неё списывают;
 *  - `credentials[].id` — тот самый аргумент, которым удаляется чужой второй
 *    фактор.
 * Ни одно из перечисленного @hq/redact не трогает, поэтому проверка ниже идёт
 * по СОДЕРЖИМОМУ ответа, а не по списку замаскированных полей.
 */
const CLIENT_PAYSYSTEM_OPAQUE = 'kQ7ZpL2mNv8XcR4tY1wS6dF0gH5jB9nM';
const CLIENT_PASSKEY_OPAQUE = 'W4hT8eR2qA6zX1cV5bN9mK3jL7pD0sG2';
const CLIENT_PAY_URL =
  'https://billing.example.test/shm/pay_systems/platega.cgi' +
  '?action=create&user_id=1&ts=1786609528&ps=platega_ru_card&amount=300';

const CLIENT_FORECAST = [
  {
    balance: 12.5,
    bonuses: 3,
    total: 300,
    items: [
      {
        name: 'VPN',
        service_id: '2',
        usi: '51',
        user_service_id: '51',
        status: 'ACTIVE',
        expire: '2026-09-01 10:00:00',
        cost: 100,
        months: 1,
        qnt: 1,
        discount: 0,
        total: 100,
        next: {
          name: 'VPN',
          service_id: 2,
          cost: 300,
          months: 1,
          qnt: 1,
          discount: 0,
          bonus: 3,
          total: 297,
        },
      },
    ],
  },
];

const CLIENT_PAYSYSTEMS = [
  {
    paysystem: 'platega',
    name: `RU cards ${CLIENT_PAYSYSTEM_OPAQUE}`,
    weight: 1,
    recurring: 0,
    internal: 0,
    allow_deletion: 0,
    forecast: 300,
    amount: 300,
    user_id: 1,
    shm_url: CLIENT_PAY_URL,
  },
];

const CLIENT_AUTOPAY = [
  {
    platega_sub: {
      subscription_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      card: '552461******7890',
      rebill: ['rebill', CLIENT_PAYSYSTEM_OPAQUE].join('-'),
    },
  },
];

const CLIENT_PASSKEYS = [
  {
    enabled: 1,
    credentials: [
      { id: CLIENT_PASSKEY_OPAQUE, name: `iPhone ${CLIENT_PASSKEY_OPAQUE}`, created_at: '2026-07-01 10:00:00' },
    ],
  },
];

const CLIENT_OFFER = {
  service_id: 2,
  name: 'VPN',
  category: 'vpn',
  period: 1,
  cost: 100,
  discount: 0,
  cost_discount: 0,
  cost_bonus: 3,
  real_cost: 100,
  real_cost_with_bonuses: 97,
  allow_to_order: 1,
  deleted: 0,
};

const CLIENT_PROMO = [
  {
    promo_code: 'FREEWORM',
    created: '2026-07-29 20:18:23',
    expire: null,
    reusable: 1,
    status: 1,
    used: 0,
    used_date: null,
    used_by: null,
    settings: { public: { note: CLIENT_PASSKEY_OPAQUE } },
  },
];

function shmList(path: string): unknown {
  if (path === '/admin/promo') return SHM_PROMO;
  // Клиентская часть: списочные маршруты.
  if (path === '/user/pay') return [SHM_PAY];
  if (path === '/user/withdraw') return [SHM_WITHDRAW];
  if (path === '/service/order' || path === '/admin/service/order') return [CLIENT_OFFER];
  if (path === '/service') return [CLIENT_OFFER];
  if (path === '/promo') return CLIENT_PROMO;
  if (path === '/admin/user' || path === '/admin/user/search') return [SHM_USER];
  if (path === '/admin/user/pay') return [SHM_AUTOPAY_FEE, SHM_AUTOPAY_PAY, SHM_PAY];
  if (path === '/admin/user/bonus') {
    return [{ id: 3, user_id: 1, date: '2026-07-01 10:00:00', bonus: 3, comment: 'promo' }];
  }
  if (path === '/admin/user/service/withdraw') return [SHM_WITHDRAW];
  if (path === '/admin/user/service') return [SHM_SERVICE];
  if (path === '/admin/spool' || path === '/admin/spool/history') return [SHM_SPOOL];
  if (path === '/admin/service') {
    return [{ service_id: 2, name: 'VPN', cost: 100, period: 1, category: 'vpn', children: [] }];
  }
  if (path === '/admin/server') return [SHM_SERVER];
  if (path === '/admin/server/group') {
    return [{ group_id: 10, name: 'http', type: 'random', transport: 'http', settings: '{}' }];
  }
  // Шаблон приезжает ОДНИМ полем `data` — гигантской строкой. Никакое имя в
  // этой строке редакции не видно, поэтому именно здесь проверяется, что
  // страховочная редакция исполнителя тело НЕ ТРОГАЕТ вовсе: вычистить его
  // может только чистка по форме внутри инструмента.
  if (path === '/admin/template') return [SHM_TEMPLATE];
  return [];
}

/**
 * Плагин ноды и одна строка отчёта блокировщика торрентов. Форма настоящая
 * целиком, включая то, что инструмент отдавать НЕ должен: `ignoreLists.ip`
 * (массив под именем, которое профиль bot маскирует, — значит счёт по нему
 * обязан стать null, а не единицей) и `xrayReport.source`, где адрес клиента
 * лежит в ЗНАЧЕНИИ под безобидным именем.
 */
const TORRENT_CLIENT_IP = '203.0.113.77';

const REMNA_PLUGIN = {
  uuid: 'plugin-1',
  viewPosition: 1,
  name: 'Torrent block',
  pluginConfig: {
    torrentBlocker: {
      enabled: true,
      blockDuration: 3600,
      ignoreLists: { ip: ['198.51.100.5', '198.51.100.6'], userId: [4440] },
    },
    connectionDrop: { enabled: false, whitelistIps: [] },
  },
};

const REMNA_TORRENT_REPORT = {
  id: 12911,
  userId: 7,
  nodeId: 5,
  user: { username: 'HQVPN_51' },
  node: { uuid: REMNA_NODE.uuid, name: 'DE-1', countryCode: 'DE' },
  report: {
    actionReport: {
      blocked: true,
      ip: TORRENT_CLIENT_IP,
      blockDuration: 3600,
      willUnblockAt: '2026-08-13T09:30:44.259Z',
      userId: '7',
      processedAt: '2026-08-13T08:30:44.259Z',
    },
    xrayReport: {
      email: '7',
      level: 0,
      protocol: 'bittorrent',
      network: 'tcp',
      source: `${TORRENT_CLIENT_IP}:50069`,
      destination: '104.28.163.196:50000',
      routeTarget: null,
      originalTarget: 'tcp:104.28.163.196:50000',
      inboundTag: 'VLESS',
      inboundName: 'vless',
      inboundLocal: '[::]:8446',
      outboundTag: 'RW_TB_OUTBOUND_BLOCK',
      ts: 1784622644,
    },
  },
  createdAt: '2026-08-13T08:30:50.298Z',
};

const REMNA_TORRENT_STATS = {
  stats: { distinctNodes: 1, distinctUsers: 1, totalReports: 3, reportsLast24Hours: 3 },
  topUsers: [{ userId: 7, color: '#6ae3bd', username: 'HQVPN_51', total: 3 }],
  topNodes: [{ uuid: REMNA_NODE.uuid, countryCode: 'DE', color: '#a1', name: 'DE-1', total: 3 }],
};

function shmGet(path: string): unknown {
  if (path === '/admin/spool/statuses') {
    return [
      { status: 'NEW', cnt: 1 },
      { status: 'SUCCESS', cnt: 2 },
    ];
  }
  if (path === '/admin/config/_shm') return [{ version: '1.2.34' }];
  if (path === '/admin/config/telegram') return [{ bot_token: '1234:secret', channel: '@hq' }];
  // Клиентская часть: скалярные маршруты (объект в конверте `data`).
  if (path === '/user/pay/forecast') return CLIENT_FORECAST;
  if (path === '/user/pay/paysystems') return CLIENT_PAYSYSTEMS;
  if (path === '/user/autopayment') return CLIENT_AUTOPAY;
  if (path === '/user/email') return [{ email: 'client1@example.test', email_verified: 1 }];
  if (path === '/user/otp') {
    return [{ enabled: 1, verified: 1, required: 0, last_verified: '2026-08-08 09:00:00' }];
  }
  if (path === '/user/passkey') return CLIENT_PASSKEYS;
  if (path === '/user/password-auth') {
    // Родные имена: конвейер стабов применит те же переименование и редакцию,
    // что настоящий клиент, — иначе проверка гоняла бы уже починенные имена.
    return [
      { password_auth_disabled: 0, password_set_by_user: 1, passkey_enabled: 1, otp_enabled: 1 },
    ];
  }
  if (path === '/user/referrals') return [{ total: 2 }];
  if (path.startsWith('/admin/storage/manage/')) {
    return [{ user_id: 1, name: 'vpn_mrzb_51', data: { id: 7, username: 'HQVPN_51' } }];
  }
  return [];
}

function remnaGet(path: string): unknown {
  if (path === '/api/system/metadata') return { app: { version: '3.2.3' } };
  if (path === '/api/node-integrations') return { total: 1, nodeIntegrations: [{
    uuid: '11111111-1111-4111-8111-111111111111', name: 'diagnostic-integration',
    config: { telemetry: { endpoint: 'short-private-value' } },
  }] };
  if (path === '/api/node-plugins/shared-lists') return { total: 1, sharedLists: [{
    name: 'diagnostic_list', type: 'ipList', itemsCount: 1,
  }] };
  if (path === '/api/node-plugins/shared-lists/diagnostic_list') return {
    name: 'diagnostic_list', config: { type: 'ipList', items: ['192.0.2.201'] },
  };
  if (path === '/api/connections/geocheck/12') return {
    isCompleted: true, isFailed: false,
    result: {
      nodeUuid: '11111111-1111-4111-8111-111111111112', success: true, message: null,
      rawReport: {
        schema: 1, tool: 'GeoCheck', duration_ms: 100,
        identity: { ipv4: '192.0.2.202', asn: 64512, as_name: 'Test AS', as_country: 'DE' },
        connectivity: { score: 90, targets: [{ id: 'target-1', name: 'Test', verdict: 'direct', score: 90 }] },
        image: '<svg>short-private-value</svg>', details: { value: 'short-private-value' },
      },
    },
  };
  // Порядок важен: сначала точные маршруты torrent-blocker, потом карточка
  // плагина по uuid — иначе '/api/node-plugins/' startsWith проглотил бы оба.
  if (path === '/api/node-plugins') {
    // pluginConfig в СПИСКЕ панель отдаёт null всегда — это её настоящая форма.
    return { total: 1, nodePlugins: [{ ...REMNA_PLUGIN, pluginConfig: null }] };
  }
  if (path === '/api/node-plugins/torrent-blocker/stats') return REMNA_TORRENT_STATS;
  if (path === '/api/node-plugins/torrent-blocker') {
    return { total: 1, records: [REMNA_TORRENT_REPORT] };
  }
  if (path.startsWith('/api/node-plugins/')) return REMNA_PLUGIN;
  if (path === `/api/connections/by-user/${REMNA_JOB.jobId}`) return REMNA_CONNECTIONS_BY_USER;
  if (path === `/api/connections/by-node/${REMNA_JOB.jobId}`) return REMNA_CONNECTIONS_BY_NODE;
  if (path.startsWith('/api/bandwidth-stats/internal-squads/')) return REMNA_SQUAD_USER_USAGE;
  if (path.startsWith('/api/bandwidth-stats/users/')) return REMNA_USER_USAGE;
  if (path === '/api/users') return { users: [REMNA_USER, REMNA_ORPHAN], total: 2 };
  if (path === '/api/users/stream') return { users: [REMNA_USER], hasMore: false };
  if (path.startsWith('/api/users/') && path.endsWith('/subscription-request-history')) {
    return { total: 1, records: [{ requestAt: '2026-08-08T11:00:00.000Z', userAgent: 'Happ/1.0' }] };
  }
  if (path.startsWith('/api/users/')) return REMNA_USER;
  if (path === '/api/hwid/devices/top-users') return { users: [{ id: 7, devicesCount: 2 }] };
  if (path.startsWith('/api/hwid/devices/')) return REMNA_DEVICES;
  if (path === '/api/nodes') return [REMNA_NODE];
  if (path === '/api/hosts') return [REMNA_HOST];
  if (path === '/api/config-profiles') {
    return { configProfiles: [{ uuid: 'cp-1', name: 'main', inbounds: [{ uuid: 'in-1', tag: 'VLESS' }] }] };
  }
  if (path === '/api/config-profiles/inbounds') {
    return { inbounds: [{ uuid: 'in-1', tag: 'VLESS', type: 'vless' }] };
  }
  if (path === '/api/internal-squads') {
    return {
      internalSquads: [
        {
          uuid: 'sq-1',
          name: 'de',
          info: { membersCount: 3, inboundsCount: 1 },
          // rawInbound панель кладёт в каждый инбаунд сквада, и в нём приватный
          // ключ Reality — фикстура обязана его нести, иначе проверка на утечку
          // проходит впустую.
          inbounds: [
            {
              uuid: 'in-1',
              tag: 'VLESS',
              type: 'vless',
              port: 443,
              rawInbound: { streamSettings: { realitySettings: { privateKey: 'reality-secret' } } },
            },
          ],
        },
      ],
    };
  }
  if (path === '/api/internal-squads/sq-1/accessible-nodes') {
    return {
      squadUuid: 'sq-1',
      accessibleNodes: [
        {
          uuid: REMNA_NODE.uuid,
          nodeName: 'DE-1',
          countryCode: 'DE',
          configProfileUuid: 'cp-1',
          configProfileName: 'main',
          activeInbounds: ['VLESS'],
        },
      ],
    };
  }
  if (path === '/api/external-squads') {
    return {
      total: 1,
      externalSquads: [
        {
          uuid: 'ex-1',
          name: 'Special',
          info: { membersCount: 0 },
          templates: [],
          subscriptionSettings: null,
          hostOverrides: null,
          hwidSettings: null,
          subpageConfigUuid: null,
        },
      ],
    };
  }
  if (path === '/api/infra-billing/providers') {
    return {
      total: 1,
      providers: [
        {
          uuid: 'pr-1',
          name: 'Hoster',
          faviconLink: null,
          loginUrl: 'https://panel.hoster.test/login/not-a-real-magic-link',
          billingHistory: { totalAmount: 300, totalBills: 3 },
          billingNodes: [{ name: 'DE-1', details: { nodeUuid: REMNA_NODE.uuid, countryCode: 'DE' } }],
        },
      ],
    };
  }
  if (path === '/api/infra-billing/nodes') {
    return {
      totalBillingNodes: 1,
      totalAvailableBillingNodes: 0,
      billingNodes: [
        {
          uuid: 'bn-1',
          nodeUuid: REMNA_NODE.uuid,
          name: 'DE-1',
          providerUuid: 'pr-1',
          provider: { uuid: 'pr-1', name: 'Hoster' },
          node: { uuid: REMNA_NODE.uuid, name: 'DE-1', countryCode: 'DE' },
          nextBillingAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      availableBillingNodes: [],
      stats: { upcomingNodesCount: 1, currentMonthPayments: 100, totalSpent: 300 },
    };
  }
  if (path === '/api/infra-billing/history') {
    return {
      total: 1,
      records: [
        {
          uuid: 'h-1',
          providerUuid: 'pr-1',
          amount: 100,
          billedAt: '2026-08-01T00:00:00.000Z',
          provider: { uuid: 'pr-1', name: 'Hoster', faviconLink: null },
        },
      ],
    };
  }
  /**
   * ПЯТЬ КОНТРОЛЛЕРОВ АУДИТА ПОВЕРХНОСТИ. Формы сняты с работающей панели
   * 3.2.3, значения выдуманы, но ИМЕНА ПОЛЕЙ — настоящие: именно на именах и
   * срабатывает редакция, и подставить сюда удобные означало бы проверять не
   * тот конвейер.
   */
  if (path === '/api/subscription-page-configs') {
    return { total: 1, configs: [{ uuid: SUBPAGE_UUID, viewPosition: 1, name: 'My-Sub', config: null }] };
  }
  if (path.startsWith('/api/subscription-page-configs/')) {
    return {
      uuid: SUBPAGE_UUID,
      name: 'My-Sub',
      config: {
        version: '1',
        locales: ['en', 'ru'],
        brandingSettings: { title: 'HQ', logoUrl: 'https://example.test/logo.png' },
        // ИМЯ НАСТОЯЩЕЕ: `showConnectionKeys` матчит /key/i и уезжало маркером
        // из настоящего ответа панели, пока это поле не появилось в стабе.
        baseSettings: { metaTitle: 'HQ', showConnectionKeys: false },
        svgLibrary: { Happ: '<svg/>' },
        platforms: { ios: { apps: [{ name: 'Incy', blocks: [] }] } },
      },
    };
  }
  if (path === '/api/snippets') return { total: 0, snippets: [] };
  if (path === '/api/config-profiles') {
    return {
      total: 1,
      configProfiles: [
        {
          uuid: PROFILE_UUID,
          name: 'PL',
          viewPosition: 1,
          // Приватный ключ Reality лежит ВНУТРИ конфига — как в работающей
          // установке.
          config: {
            inbounds: [
              {
                tag: 'PL_VLESS',
                port: 443,
                listen: '0.0.0.0',
                protocol: 'vless',
                settings: { seed: 'xhttp-r3mna-s33d-7k2pQ' },
                streamSettings: {
                  network: 'xhttp',
                  security: 'reality',
                  realitySettings: { privateKey: REALITY_KEY, shortIds: ['a1b2c3d4e5f60789'] },
                },
              },
            ],
          },
          inbounds: [{ uuid: 'i-1', tag: 'PL_VLESS' }],
          nodes: [{ uuid: REMNA_NODE.uuid, name: 'DE-1' }],
        },
      ],
    };
  }
  if (path.endsWith('/computed-config')) {
    return { uuid: PROFILE_UUID, config: { inbounds: [{ tag: 'PL_VLESS', port: 443 }] } };
  }
  if (path === '/api/nodes/tags') return { tags: [] };
  if (path === '/api/users/tags') return { tags: ['SHM'] };
  if (path.endsWith('/accessible-nodes')) {
    return {
      userId: 7,
      activeNodes: [
        {
          uuid: REMNA_NODE.uuid,
          nodeName: 'DE-1',
          countryCode: 'DE',
          configProfileName: 'PL',
          activeSquads: [{ squadName: 'Main', activeInbounds: ['PL_VLESS'] }],
        },
      ],
    };
  }
  if (path === '/api/hwid/devices/stats') {
    return {
      byPlatform: [{ platform: 'iOS', count: 2, byApp: [{ app: 'Happ', count: 2 }] }],
      stats: { totalUniqueDevices: 2, totalHwidDevices: 2, averageHwidDevicesPerUser: 1 },
    };
  }
  if (path === '/api/hwid/devices/top-users') {
    return { users: [{ username: 'client1', id: 7, devicesCount: 2 }], total: 1 };
  }
  if (path === '/api/hwid/devices') {
    return {
      total: 1,
      devices: [
        {
          hwid: 'HW-1',
          userId: 7,
          platform: 'iOS',
          osVersion: '17.0',
          deviceModel: 'iPhone',
          userAgent: 'Happ/1.0',
          requestIp: '203.0.113.9',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    };
  }
  if (path === '/api/system/stats/recap') {
    return { thisMonth: { users: 1 }, total: { users: 1, nodes: 1 }, version: '3.2.3', initDate: 'x' };
  }
  if (path === '/api/system/stats/digest') {
    return { users: { createdCount: 1 }, traffic: { totalBytes: '1' }, hwidDevices: { createdCount: 1 } };
  }
  if (path === '/api/system/stats/http') {
    return { total: 1, routes: [{ method: 'GET', route: '/api/users', count: 1 }] };
  }
  if (path === '/api/subscription-request-history/stats') {
    return { byParsedApp: [{ app: 'Happ', count: 1 }], hourlyRequestStats: [{ dateTime: 'x', requestCount: 1 }] };
  }
  if (path === '/api/subscription-request-history') {
    return {
      total: 1,
      records: [
        {
          id: 1,
          userId: 7,
          requestAt: '2026-08-01T00:00:00.000Z',
          requestIp: '203.0.113.9',
          userAgent: 'Happ/1.0',
          srrRuleName: 'Fallback Base64',
          srrResponseType: 'XRAY_BASE64',
        },
      ],
    };
  }
  if (path === '/api/system/stats') return { users: { totalUsers: 1 }, memory: { total: 1 } };
  if (path === '/api/system/nodes/metrics') {
    return { nodes: [{ nodeUuid: REMNA_NODE.uuid, usersOnline: 3 }] };
  }
  if (path === '/api/bandwidth-stats/nodes') {
    return { nodes: [{ nodeUuid: REMNA_NODE.uuid, totalBytes: 1024 }] };
  }
  if (path === '/api/bandwidth-stats/nodes/realtime') {
    return [{ nodeUuid: REMNA_NODE.uuid, downloadBytes: 1, uploadBytes: 1 }];
  }
  return [];
}

/**
 * Приватный ключ Reality в форме, которую отдаёт работающая панель. Живёт
 * константой, чтобы тест мог потребовать его отсутствия в ответе ПО ЗНАЧЕНИЮ,
 * а не только по имени поля.
 */
const REALITY_KEY = 'ZmFrZVJlYWxpdHlLZXlGb3JUZXN0c09ubHlfMDAwMDA';
const PROFILE_UUID = '6410d334-fb9c-4eb3-83c2-80385ffe5c7d';
const SUBPAGE_UUID = '00000000-0000-0000-0000-000000000000';

const abuseFetch = (async () =>
  new Response(
    JSON.stringify({ shared_devices: [{ login: 'client1', ip: '203.0.113.7', devices: 2 }] }),
    { status: 200 },
  )) as unknown as typeof fetch;

/**
 * POST, который на самом деле чтение: контроллер connections ставит задачу
 * методом POST и отвечает только идентификатором. Без этого стаба обе ветки
 * connections_inspect уходили бы в `degraded`, то есть через редакцию не
 * проезжал бы НИ ОДИН адрес — а именно они здесь и проверяются.
 */
function remnaSend(path: string): unknown {
  if (path.startsWith('/api/connections/')) return REMNA_JOB;
  return {};
}

/**
 * Стабы отдают ровно то, что отдал бы настоящий клиент: @hq/shm переименовывает
 * столкнувшиеся с маской имена (`uniq_key` → `uniq_id`) и редактирует тело САМ,
 * до того как его увидит инструмент (packages/shm/src/client.ts:87), @hq/remna
 * — так же (packages/remna/src/index.ts:153). Без этого шага тест проверял бы
 * только вторую редакцию, страховочную, и не заметил бы поле, съеденное первой:
 * именно так `uniq_key` и доезжал вызывающему маркером в работающей установке.
 *
 * Профиль параметром, а не зашитый: первая редакция зависит от него, и на
 * 'bot' инструмент видит PII уже маскированной — то есть поведение бот-контура
 * нельзя проверить, подменив профиль только на выходе.
 */
function makeToolCtx(profile: Profile = 'human'): ToolContext {
  const clean = (value: unknown): unknown => redact(renameSafeShmKeys(value), profile);
  return makeCtx({
    shmList: (path) => clean(shmList(path)),
    shmGet: (path) => clean(shmGet(path)),
    // Клиент @hq/remna переименовывает столкнувшиеся с маской имена ДО
    // редакции (REMNA_SAFE_RENAMES) — стаб обязан делать ровно то же, иначе
    // тест проверяет не тот конвейер.
    remnaGet: (path) => redact(renameSafeRemnaKeys(remnaGet(path)), profile),
    remnaSend: (path) => redact(renameSafeRemnaKeys(remnaSend(path)), profile),
    profile,
  });
}

/**
 * Все пути, где после исполнителя лежит маркер редакции. Индекс массива
 * схлопывается в `[]`: место находки — это поле, а не строка.
 */
function maskedPaths(value: unknown, path = ''): string[] {
  if (value === REDACTED) return [path === '' ? '(root)' : path];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => maskedPaths(item, `${path}[]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    maskedPaths(item, path === '' ? key : `${path}.${key}`),
  );
}

/**
 * Замысел, а не потеря. Каждая строка здесь — поле, которое ОБЯЗАНО уезжать
 * маркером; всё остальное, что всплывёт в этом списке, — поле, которое
 * инструмент собирался отдать, а редакция съела по имени.
 */
const DELIBERATE: Record<string, string[]> = {
  // Карта пользователя панели отдаётся целиком: креды в ней настоящие.
  client_overview: ['remna.user.trojanPassword', 'remna.user.vlessUuid'],
  subscription_inspect: [],
  // Ключ конфига читается ради значения, а маскирование по имени поля — это и
  // есть опубликованный контракт инструмента: он перечисляет замаскированное
  // в предупреждении `masked`, чтобы вызывающий не принял маркер за значение.
  config_read: ['value.bot_token'],
};

interface Case {
  name: string;
  input: unknown;
}

const CASES: Case[] = [
  { name: 'platform_probe', input: { refresh: true } },
  { name: 'client_resolve', input: { query: '5000001' } },
  { name: 'client_overview', input: { shm_user_id: 1, remna_user_id: 7 } },
  { name: 'client_search', input: { text: 'client1', include_blocked: true } },
  { name: 'billing_ledger', input: { shm_user_id: 1 } },
  { name: 'autopay_inspect', input: { shm_user_id: 1 } },
  { name: 'service_inspect', input: { shm_user_id: 1, user_service_id: 51 } },
  { name: 'catalog_read', input: { section: 'services' } },
  { name: 'provisioning_diagnose', input: { shm_user_id: 1, user_service_id: 51 } },
  { name: 'subscription_inspect', input: { user_id: 7 } },
  { name: 'sync_audit', input: { limit: 100 } },
  { name: 'country_health', input: { country_code: 'DE' } },
  { name: 'server_status', input: { country: 'DE' } },
  { name: 'connections_inspect', input: { user_id: 7 } },
  { name: 'traffic_stats', input: { user_id: 7 } },
  { name: 'infra_map', input: {} },
  { name: 'squads_read', input: {} },
  { name: 'server_inventory', input: {} },
  { name: 'infra_costs', input: { limit: 50 } },
  { name: 'abuse_report', input: {} },
  { name: 'torrent_reports', input: {} },
  { name: 'promo_read', input: {} },
  { name: 'spool_inspect', input: { limit: 10 } },
  { name: 'notify_history', input: { shm_user_id: 1, limit: 10 } },
  { name: 'template_read', input: { id: 'hwid_blocker' } },
  { name: 'config_read', input: { name: 'telegram' } },
  { name: 'subpage_read', input: {} },
  { name: 'node_config_audit', input: {} },
  { name: 'node_integrations_read', input: {} },
  { name: 'shared_lists_read', input: {} },
  { name: 'node_geocheck', input: { action: 'result', job_id: '12' } },
  { name: 'client_reach', input: { user_id: 7 } },
  { name: 'device_inventory', input: {} },
  { name: 'panel_activity', input: {} },
  { name: 'client_billing_view', input: { shm_user_id: 1 } },
  { name: 'client_account_state', input: { shm_user_id: 1 } },
  { name: 'client_catalog_view', input: { shm_user_id: 1, service_id: 2 } },
  // sql_query отсутствует намеренно: успешного ответа у него в плане 1 нет
  // вовсе — он преflight и заканчивается отказом с объяснением, поэтому
  // маскировать в нём нечего.
];

describe('tool output survives the executor redaction', () => {
  beforeEach(() => {
    resetProbeCache();
    resetAbuseBudget();
  });

  it('covers every read tool that answers with a value', () => {
    const registry = createRegistry(
      createReadTools({ tunnel, fetchImpl: abuseFetch, probeTcp: makeTcpProbe(true) }),
    );
    const published = registry.list({ mode: 'ro', profile: 'human' }).map((def) => def.name);
    expect([...CASES.map((one) => one.name), 'sql_query'].sort()).toEqual(published);
  });

  for (const one of CASES) {
    it(`${one.name}: no field is masked except by design`, async () => {
      const registry = createRegistry(
        createReadTools({ tunnel, fetchImpl: abuseFetch, probeTcp: makeTcpProbe(true) }),
      );
      const result = await executeTool(one.name, one.input, { registry, ctx: makeToolCtx() });
      if (!result.ok) throw new Error(`${one.name} did not answer: ${result.message}`);
      expect([...new Set(maskedPaths(result.value))].sort()).toEqual(
        [...(DELIBERATE[one.name] ?? [])].sort(),
      );
      if (['node_integrations_read', 'shared_lists_read', 'node_geocheck'].includes(one.name)) {
        expect(result.value).toMatchObject({ degraded: [] });
        expect(JSON.stringify(result.value)).not.toContain('short-private-value');
        expect(JSON.stringify(result.value)).not.toContain('192.0.2.201');
      }
    });
  }
});

/**
 * СВЕРХ ПРОВЕРКИ ПО ИМЕНАМ ПОЛЕЙ — ПРОВЕРКА ПО ЗНАЧЕНИЯМ.
 *
 * Блок выше спрашивает «какое поле съедено редакцией» и делает это на профиле
 * human, где PII не маскируется вовсе. Живые подключения этим не закрываются:
 * их содержимое — адреса клиентов, то есть ровно тот класс данных, который
 * профилю bot видеть нельзя, и ровно тот способ утечки, каким настоящий токен
 * бота уехал в контекст модели строкой спула — @hq/redact смотрит на ИМЯ
 * ключа и внутрь значения не заглядывает.
 *
 * Поэтому здесь ответ сериализуется целиком и в нём ищется сам адрес — где бы
 * он ни лежал: в поле с безобидным именем, внутри строки предупреждения, в
 * тексте ошибки из `degraded`. Обратная проверка на human обязательна: тест,
 * который лишь требует отсутствия адреса, зеленеет и на инструменте, который
 * не отдаёт адресов НИКОМУ и потому бесполезен.
 */
describe('connection addresses never reach the bot profile in any form', () => {
  const IPS = ['203.0.113.11', '198.51.100.22'];
  const NODE = '99999999-8888-7777-6666-555555555555';

  async function answer(name: string, input: unknown, profile: Profile): Promise<unknown> {
    const registry = createRegistry(
      createReadTools({ tunnel, fetchImpl: abuseFetch, probeTcp: makeTcpProbe(true) }),
    );
    const result = await executeTool(name, input, { registry, ctx: makeToolCtx(profile) });
    if (!result.ok) throw new Error(`${name} did not answer: ${result.message}`);
    return result.value;
  }

  const CONNECTION_CASES: Case[] = [
    { name: 'connections_inspect', input: { user_id: 7 } },
    { name: 'connections_inspect', input: { node_uuid: NODE } },
  ];

  for (const one of CONNECTION_CASES) {
    const scope = (one.input as { user_id?: number }).user_id === undefined ? 'node' : 'user';

    it(`${one.name} (${scope} scope): human sees the addresses, so the bot check is not vacuous`, async () => {
      const text = JSON.stringify(await answer(one.name, one.input, 'human'));
      for (const ip of IPS.slice(0, 1)) expect(text).toContain(ip);
    });

    it(`${one.name} (${scope} scope): no address survives anywhere in the bot answer`, async () => {
      const value = await answer(one.name, one.input, 'bot');
      const text = JSON.stringify(value);
      for (const ip of IPS) expect(text).not.toContain(ip);
      // Маскировано именно поле адреса, а не выброшено вместе со строкой:
      // пустой список подключений прошёл бы проверку выше и не значил бы ничего.
      expect(maskedPaths(value).filter((path) => path.endsWith('.ip'))).not.toEqual([]);
      // Счёт РАЗНЫХ адресов на маскированном входе неисчислим, и наивная
      // реализация вернула бы 1 (все маркеры равны друг другу) — то есть
      // «клиент сидит с одного адреса» на любом клиенте.
      const totals = (value as { totals?: { distinctAddresses?: unknown } }).totals;
      expect(totals?.distinctAddresses).toBeNull();
    });
  }

  it('traffic_stats carries no address at all, in either profile', async () => {
    for (const profile of ['human', 'bot'] as Profile[]) {
      const text = JSON.stringify(await answer('traffic_stats', { user_id: 7 }, profile));
      for (const ip of IPS) expect(text).not.toContain(ip);
    }
  });
});

/**
 * ЧТО РЕДАКЦИЯ ДЕЛАЕТ С КАЖДЫМ ПОЛЕМ torrent_reports НА ПРОФИЛЕ bot.
 *
 * Отчёт блокировщика называет КЛИЕНТА: его адрес, имя его пользователя в
 * панели, ноду и время. Половина этого — та самая PII, которую §7.2 боту не
 * отдаёт, и «половина» здесь не фигура речи: `actionReport.ip` маскируется по
 * имени поля, а `xrayReport.source` — тот же адрес плюс порт — НЕ маскируется
 * ничем, потому что @hq/redact смотрит на имя ключа и внутрь значения не
 * заглядывает. Инструмент поэтому `source` наружу не выносит вовсе, и
 * проверяется это здесь по СОДЕРЖИМОМУ ответа, а не по списку полей.
 *
 * Ожидания ниже закрытые и в обе стороны: на human адрес обязан быть виден
 * (иначе проверка на bot зеленела бы на инструменте, который не отдаёт ничего
 * никому), на bot — обязан отсутствовать в любом виде, а замаскированным
 * должно оказаться РОВНО одно поле.
 */
describe('torrent_reports under the bot profile', () => {
  beforeEach(() => {
    resetProbeCache();
    resetAbuseBudget();
  });

  async function answer(profile: Profile): Promise<unknown> {
    const registry = createRegistry(
      createReadTools({ tunnel, fetchImpl: abuseFetch, probeTcp: makeTcpProbe(true) }),
    );
    const result = await executeTool('torrent_reports', {}, { registry, ctx: makeToolCtx(profile) });
    if (!result.ok) throw new Error(`torrent_reports did not answer: ${result.message}`);
    return result.value;
  }

  it('shows the human the address, so the bot check below is not vacuous', async () => {
    const value = await answer('human');
    expect(JSON.stringify(value)).toContain(TORRENT_CLIENT_IP);
    expect(maskedPaths(value)).toEqual([]);
  });

  it('masks exactly one field for the bot, and it is the client address', async () => {
    const value = await answer('bot');
    expect([...new Set(maskedPaths(value))]).toEqual(['reports.data[].ip']);
  });

  it('lets no form of the address through — not the source tuple, not the xray email', async () => {
    const text = JSON.stringify(await answer('bot'));
    expect(text).not.toContain(TORRENT_CLIENT_IP);
    expect(text).not.toContain('50069');
    expect(text).not.toContain('outboundTag');
  });

  it('keeps the fields the finding is made of: node, username, verdict, destination', async () => {
    const value = (await answer('bot')) as {
      reports: { data: Array<Record<string, unknown>> };
      plugin: { ignoredIpCount: number | null; torrentBlockerEnabled: boolean | null };
    };
    const row = value.reports.data[0];
    expect(row?.username).toBe('HQVPN_51');
    expect(row?.nodeCountry).toBe('DE');
    expect(row?.blocked).toBe(true);
    expect(row?.destination).toBe('104.28.163.196:50000');
    expect(value.plugin.torrentBlockerEnabled).toBe(true);
    // Список игнорируемых адресов приезжает боту маркером под именем `ip`, и
    // его длина неисчислима. Наивный asArray дал бы 1 — «в игноре один адрес»
    // на любом их числе.
    expect(value.plugin.ignoredIpCount).toBeNull();
  });

  it('counts the ignore list for the human, where the array is intact', async () => {
    const value = (await answer('human')) as { plugin: { ignoredIpCount: number | null } };
    expect(value.plugin.ignoredIpCount).toBe(2);
  });
});

/**
 * promo_read на профиле bot: маскировать в нём нечего, и это утверждение, а не
 * умолчание. Идентификатор кода, даты, суммы и id применивших не попадают ни
 * под одно правило @hq/redact — а значит, если завтра поле переименуют в
 * что-нибудь с `key` внутри, ответ инструмента молча опустеет, и поймать это
 * должен именно этот тест.
 */
describe('promo_read under the bot profile', () => {
  it('masks nothing, in either profile', async () => {
    for (const profile of ['human', 'bot'] as Profile[]) {
      const registry = createRegistry(
        createReadTools({ tunnel, fetchImpl: abuseFetch, probeTcp: makeTcpProbe(true) }),
      );
      const result = await executeTool('promo_read', {}, { registry, ctx: makeToolCtx(profile) });
      if (!result.ok) throw new Error(`promo_read did not answer: ${result.message}`);
      expect(maskedPaths(result.value)).toEqual([]);
      const value = result.value as { codes: Array<{ id: string; remaining: number | null }> };
      expect(value.codes[0]?.id).toBe('FREEWORM');
      expect(value.codes[0]?.remaining).toBe(937);
    }
  });
});

/**
 * server_status — ИНСТРУМЕНТ, ЧЕЙ ОТВЕТ БОТ ПЕРЕСКАЗЫВАЕТ КЛИЕНТУ ПОЧТИ ДОСЛОВНО.
 *
 * Он читает ноды, хосты и сквады — то есть ровно те ответы панели, где лежат
 * адрес хоста, uuid ноды, тег и приватный ключ Reality инбаунда, — и обязан
 * вынести из них только имена, коды стран и счётчики. Проверка по значениям в
 * обоих профилях: маскирование по имени поля здесь ни при чём, полей с такими
 * именами в ответе быть не должно вовсе. И в обе стороны: имя хоста и ноды
 * видны, иначе тест зеленел бы на пустом ответе.
 */
describe('server_status gives names and counts, never an address', () => {
  for (const profile of ['human', 'bot'] as Profile[]) {
    it(`masks nothing and leaks nothing (${profile})`, async () => {
      const registry = createRegistry(
        createReadTools({ tunnel, fetchImpl: abuseFetch, probeTcp: makeTcpProbe(true) }),
      );
      const result = await executeTool('server_status', {}, { registry, ctx: makeToolCtx(profile) });
      if (!result.ok) throw new Error(`server_status did not answer: ${result.message}`);
      expect(maskedPaths(result.value)).toEqual([]);
      const value = result.value as {
        countries: Array<{ countryCode: string; nodes: Array<{ name: string }> }>;
        subscription: { hostsByClient: { base64: string[] } };
      };
      expect(value.countries[0]?.nodes[0]?.name).toBe(REMNA_NODE.name);
      expect(value.subscription.hostsByClient.base64).toEqual([REMNA_HOST.remark]);
      const text = JSON.stringify(result.value);
      for (const leak of [
        REMNA_HOST.address,
        REMNA_HOST.uuid,
        REMNA_NODE.uuid,
        'in-1',
        'reality-secret',
        'VLESS',
        'Main',
      ]) {
        expect(text).not.toContain(leak);
      }
    });
  }
});

/**
 * КЛИЕНТСКАЯ ПОВЕРХНОСТЬ: ПРОВЕРКА ПО ЗНАЧЕНИЯМ, А НЕ ПО ИМЕНАМ ПОЛЕЙ.
 *
 * Блок выше спрашивает «какое поле съела редакция». На клиентских маршрутах
 * этого мало ровно по той причине, по которой настоящий токен бота уехал в
 * контекст модели строкой спула: @hq/redact смотрит на ИМЯ ключа и внутрь
 * значения не заглядывает, а здесь опасное лежит именно в значениях —
 * в ссылке оплаты, в свободном тексте названия способа оплаты, в записи
 * платёжной системы о сохранённом методе и в идентификаторе ключа доступа.
 * Поэтому ответ сериализуется целиком и в нём ищется само содержимое: где бы
 * оно ни лежало — в поле с безобидным именем, в тексте предупреждения, в
 * сообщении из `degraded`.
 *
 * Проверки закрытые и в обе стороны: то, ради чего инструмент написан, обязано
 * быть видно (иначе тест зеленел бы на инструменте, который не отдаёт ничего),
 * а то, что вынести нельзя, обязано отсутствовать в любом виде.
 */
describe('the SHM client surface never carries a value out with it', () => {
  beforeEach(() => {
    resetProbeCache();
    resetAbuseBudget();
  });

  async function answer(name: string, input: unknown, profile: Profile = 'human'): Promise<unknown> {
    const registry = createRegistry(
      createReadTools({ tunnel, fetchImpl: abuseFetch, probeTcp: makeTcpProbe(true) }),
    );
    const result = await executeTool(name, input, { registry, ctx: makeToolCtx(profile) });
    if (!result.ok) throw new Error(`${name} did not answer: ${result.message}`);
    return result.value;
  }

  it('client_billing_view drops the payment link and keeps the method identifier', async () => {
    const value = await answer('client_billing_view', { shm_user_id: 1 });
    const text = JSON.stringify(value);
    // Ссылка создаёт платёж этому клиенту одним GET. Ни она, ни её части.
    expect(text).not.toContain(CLIENT_PAY_URL);
    expect(text).not.toContain('pay_systems/platega.cgi');
    expect(text).not.toContain('action=create');
    expect(text).not.toContain('1786609528');
    // ...а разобранное из неё — на месте, иначе проверка выше ничего не стоит.
    const offered = (value as { paysystems: { offered: Array<Record<string, unknown>> } }).paysystems
      .offered;
    expect(offered[0]?.paysystemId).toBe('platega_ru_card');
    expect(offered[0]?.action).toBe('create');
    expect(offered[0]?.endpoint).toBe('https://billing.example.test');
  });

  it('client_billing_view scrubs an opaque run inside a payment-method name', async () => {
    const value = await answer('client_billing_view', { shm_user_id: 1 });
    const text = JSON.stringify(value);
    // Название способа оплаты — свободный текст из конфигурации, и никакого
    // «секретного» имени над ним нет. Чистится по ФОРМЕ значения.
    expect(text).not.toContain(CLIENT_PAYSYSTEM_OPAQUE);
    const offered = (value as { paysystems: { offered: Array<{ label: string }> } }).paysystems
      .offered;
    expect(offered[0]?.label).toBe('RU cards <redacted:opaque>');
  });

  it('client_billing_view reports a stored recurring method by field name only', async () => {
    const value = await answer('client_billing_view', { shm_user_id: 1 });
    const text = JSON.stringify(value);
    expect(text).not.toContain('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
    expect(text).not.toContain('552461******7890');
    expect(text).not.toContain(`rebill-${CLIENT_PAYSYSTEM_OPAQUE}`);
    const autopay = (value as {
      autopay: { recordedMethods: Array<{ paysystem: string; fieldsPresent: string[] }> };
    }).autopay;
    expect(autopay.recordedMethods).toEqual([
      { paysystem: 'platega_sub', fieldsPresent: ['card', 'rebill', 'subscription_id'] },
    ]);
  });

  it('client_account_state answers about the sign-in flags instead of showing markers', async () => {
    const value = await answer('client_account_state', { shm_user_id: 1 });
    // Ровно тот случай, ради которого поля переименовываются на входе, а блоки
    // ответа называются `signIn`/`fido`: под родными именами оба конца
    // конвейера — редакция клиента и страховочная редакция исполнителя —
    // съедали бы их по слову `password`/`key`.
    expect((value as { signIn: unknown }).signIn).toEqual({
      pwdLoginPossible: true,
      pwdSetByUser: true,
      otpEnabled: true,
    });
    expect(maskedPaths(value)).toEqual([]);
  });

  it('client_account_state withholds the credential id and scrubs the credential name', async () => {
    const value = await answer('client_account_state', { shm_user_id: 1 });
    const text = JSON.stringify(value);
    // Идентификатор — аргумент DELETE /user/passkey, то есть кнопка «снять
    // второй фактор с чужого аккаунта». Наружу не идёт ни как id, ни в имени.
    expect(text).not.toContain(CLIENT_PASSKEY_OPAQUE);
    const fido = (value as { fido: { enabled: boolean; count: number; credentials: Array<Record<string, unknown>> } })
      .fido;
    expect(fido.enabled).toBe(true);
    expect(fido.count).toBe(1);
    expect(fido.credentials[0]).toEqual({
      name: 'iPhone <redacted:opaque>',
      createdAt: '2026-07-01 10:00:00',
    });
  });

  it('client_catalog_view carries no promo settings blob out of the row', async () => {
    const value = await answer('client_catalog_view', { shm_user_id: 1, service_id: 2 });
    const text = JSON.stringify(value);
    // Содержимое `settings.public` задаёт тот, кто выпускал код: формы у него
    // нет, схемы тоже, и белый список полей — единственная защита.
    expect(text).not.toContain(CLIENT_PASSKEY_OPAQUE);
    const promo = (value as { promo: { data: Array<Record<string, unknown>> } }).promo;
    expect(promo.data[0]?.code).toBe('FREEWORM');
    expect(promo.data[0]?.settings).toBeUndefined();
  });

  it('client_billing_view keeps working for the bot, where PII is masked harder', async () => {
    const value = await answer('client_billing_view', { shm_user_id: 1 }, 'bot');
    const text = JSON.stringify(value);
    expect(text).not.toContain(CLIENT_PAY_URL);
    expect(text).not.toContain(CLIENT_PAYSYSTEM_OPAQUE);
    // Ответ про деньги на профиле бота обязан остаться ОТВЕТОМ, а не пустышкой.
    expect((value as { forecast: { amountDue: number } }).forecast.amountDue).toBe(300);
  });
});
