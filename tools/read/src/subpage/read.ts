import { defineTool } from '@hq/registry';
import { scrubSecretShapesDeep } from '@hq/redact';
import { z } from 'zod';
import type { SecretShapeHit } from '@hq/redact';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  asArray,
  asRecord,
  capLimit,
  declaredTotal,
  envelope,
  num,
  settle,
  str,
  take,
  warn,
} from '../kit.js';

/**
 * Контроллер subscription-page-configs панели 3.2.3 объявляет восемь маршрутов;
 * читающих из них два — GET_ALL и GET(uuid). Остальные шесть (create/update/
 * delete/reorder/clone) — запись, и её здесь нет и не будет: страница подписки
 * это то, что видит КАЖДЫЙ клиент, и одна плохая правка ломает установку
 * приложения всем сразу.
 *
 * ОБА МАРШРУТА ОБЯЗАТЕЛЬНЫ, И ЭТО НЕ ИЗБЫТОЧНОСТЬ. Список отдаёт `config: null`
 * ВСЕГДА — проверено на работающей панели: `{uuid, viewPosition, name,
 * config: null}`. Тело живёт только в карточке. То есть «что страница
 * показывает клиенту» из списка узнать нельзя в принципе, и поштучное чтение
 * здесь — единственный источник, а не оптимизация. Ровно та же форма, что у
 * node-plugins (`pluginConfig: null` в списке), и это уже второй контроллер
 * панели с таким поведением.
 */
const CONFIGS_PATH = '/api/subscription-page-configs';

/**
 * Сниппеты панели: `{name, snippet}`, где `snippet` объявлен `z.unknown()` —
 * то есть форма содержимого контрактом не задана вовсе, и разбирать её по
 * известным полям нельзя. Поэтому тело сниппета уезжает как есть, пройдя
 * скруббер по форме, а не разбирается.
 */
const SNIPPETS_PATH = '/api/snippets';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

/**
 * Сколько карточек читается поштучно, когда конкретный uuid не назван. Каждая
 * карточка — отдельный запрос, и потолок существует ради панели, где конфигов
 * много: обычно он один, но рассчитывать на это нельзя.
 */
const MAX_BODIES = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ScrubSummary {
  removed: number;
  by_shape: {
    jwt: number;
    named_assignment: number;
    opaque_run: number;
    telegram_bot: number;
    url_credentials: number;
  };
}

const SHAPE_FIELD: Record<SecretShapeHit['shape'], keyof ScrubSummary['by_shape']> = {
  jwt: 'jwt',
  assigned_secret: 'named_assignment',
  opaque_run: 'opaque_run',
  // Имя поля — `telegram_bot`, а не `bot_token`: подстрока `token` матчит
  // SECRET_KEY_RE, и счётчик вырезанных токенов уехал бы маркером сам.
  bot_token: 'telegram_bot',
  url_credentials: 'url_credentials',
};

/**
 * Имя поля выбрано так, чтобы его НЕ съела редакция по имени: `SECRET_KEY_RE`
 * — это /token|secret|key|password|auth/i, и сводка, названная `secrets`,
 * уехала бы вызывающему маркером '<redacted>', а инструмент при этом выглядел
 * бы работающим. Такое уже случалось в этом репозитории дважды.
 */
function summarise(hits: SecretShapeHit[]): ScrubSummary {
  const by_shape = {
    jwt: 0,
    named_assignment: 0,
    opaque_run: 0,
    telegram_bot: 0,
    url_credentials: 0,
  };
  for (const hit of hits) by_shape[SHAPE_FIELD[hit.shape]] += 1;
  return { removed: hits.length, by_shape };
}

interface AppBlock {
  title: string | null;
  buttons: { text: string | null; link: string | null; type: string | null }[];
}

interface PlatformApp {
  name: string | null;
  blocks: AppBlock[];
}

interface PageSummary {
  version: string | null;
  locales: string[];
  uiConfig: Record<string, unknown>;
  baseSettings: Record<string, unknown>;
  branding: Record<string, unknown>;
  /** Платформа → приложения, которые страница предлагает клиенту установить. */
  platforms: { platform: string; apps: PlatformApp[] }[];
  /**
   * ТОЛЬКО ИМЕНА. Значения `svgLibrary` — сырая разметка иконок, до 6.8 КБ на
   * запись, а записей в библиотеке десятки: сотня-другая килобайт картинок,
   * которые не отвечают ни на один вопрос поддержки и вытеснили бы из контекста
   * всё остальное. Имена оставлены, потому что на них ССЫЛАЮТСЯ кнопки
   * (`svgIconKey`), и «иконка есть в библиотеке» — проверяемый факт.
   *
   * ПОЛЕ НАЗЫВАЕТСЯ `svgLibraryNames`, А НЕ `...Keys`, И ЭТО НЕ ВКУСОВЩИНА.
   * `SECRET_KEY_RE` в @hq/redact — это /token|secret|key|password|auth/i по
   * ИМЕНИ поля, и подстрока `Keys` матчится буквально: первая версия называлась
   * `svgLibraryKeys`, и исполнитель возвращал '<redacted>' вместо списка имён —
   * инструмент при этом выглядел работающим. Поймал это redaction-contract,
   * гоняющий ответ через настоящий executeTool. То же самое случилось здесь же
   * с `translationKeys` (стало `translationCount`) и в node_config_audit с
   * `changedKeys`.
   */
  svgLibraryNames: string[];
  translationCount: number;
}

function buildBlocks(value: unknown): AppBlock[] {
  return asArray(value)
    .map(asRecord)
    .map((block) => ({
      // Заголовки и подписи локализованы объектом {en, ru}: берём английский,
      // а если его нет — первое непустое значение. Возвращать объект целиком
      // значило бы удвоить ответ ради второго перевода той же фразы.
      title: firstText(block.title),
      buttons: asArray(block.buttons)
        .map(asRecord)
        .map((button) => ({
          text: firstText(button.text),
          link: str(button.link),
          type: str(button.type),
        })),
    }));
}

function firstText(value: unknown): string | null {
  if (typeof value === 'string') return str(value);
  const record = asRecord(value);
  const english = str(record.en);
  if (english !== null) return english;
  for (const item of Object.values(record)) {
    const text = str(item);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Тело конфига → сводка. Собирается БЕЛЫМ СПИСКОМ полей, а не чисткой лишнего:
 * страница подписки — чужая структура, растущая от версии к версии, и
 * denylist пропустил бы первое же новое поле. Скруббер по форме стоит вторым
 * слоем у вызывающего и считает то, что просочилось.
 */
function summarisePage(config: Record<string, unknown>): PageSummary {
  const platforms = asRecord(config.platforms);
  return {
    version: str(config.version),
    locales: asArray(config.locales)
      .map((one) => str(one))
      .filter((one): one is string => one !== null),
    uiConfig: asRecord(config.uiConfig),
    /**
     * Проходит как есть. Поле `showConnectionKeys` — булев переключатель, чьё
     * ИМЯ матчит /key/i и который иначе уехал бы маркером; переименование
     * стоит в клиенте @hq/remna (REMNA_SAFE_RENAMES), а не здесь, потому что
     * клиент редактирует тело РАНЬШЕ хендлера — на выходе переименовывать уже
     * нечего. Наружу оно приезжает как `showConnectionCreds`.
     */
    baseSettings: asRecord(config.baseSettings),
    branding: asRecord(config.brandingSettings),
    platforms: Object.entries(platforms).map(([platform, value]) => ({
      platform,
      apps: asArray(asRecord(value).apps)
        .map(asRecord)
        .map((app) => ({ name: str(app.name), blocks: buildBlocks(app.blocks) })),
    })),
    svgLibraryNames: Object.keys(asRecord(config.svgLibrary)),
    translationCount: Object.keys(asRecord(config.baseTranslations)).length,
  };
}

interface PageConfig {
  uuid: string | null;
  name: string | null;
  viewPosition: number | null;
  /** Прочитана ли карточка. false — тела нет, потому что его не спрашивали или карточка не ответила. */
  bodyRead: boolean;
  summary: PageSummary | null;
}

export const subpageRead = defineTool({
  name: 'subpage_read',
  description:
    'What the Remnawave subscription page actually shows a client, plus the panel snippets. ' +
    'This is the tool for "the client says the app link does not work" or "which app do we tell ' +
    'iPhone users to install" — the answer is configuration, not code, and until now nothing ' +
    'here could read it. Returns, per page config: the platforms it advertises, the apps under ' +
    'each, every install step and every button link the client is offered, the branding block ' +
    '(title, logo, support URL) and the locales. ' +
    'THE LIST ROUTE NEVER CARRIES A BODY — the panel returns `config: null` in the listing and ' +
    'serves the real thing only from the per-uuid card, so a body here means one extra request ' +
    'per config and a config without `bodyRead` is one nobody asked about, not an empty one. ' +
    'SVG icon library values are deliberately not returned (raw markup, up to 6.8 KB each, 22 ' +
    'of them on this deployment); their names are, because buttons reference them. ' +
    'Bodies pass through the shape scrubber before they leave and anything removed is counted ' +
    'in `scrubbed` — that is a filter on shape, not a boundary. ' +
    'Creating, updating, deleting, cloning and reordering page configs and snippets are ' +
    'deliberately absent: this page is what every client sees, and one bad edit breaks ' +
    'installation for all of them at once.',
  input: z.object({
    uuid: z
      .string()
      .nullable()
      .default(null)
      .describe('Read one page config by uuid; omit to list them and read the first few bodies'),
    include_bodies: z
      .boolean()
      .default(true)
      .describe('Fetch the per-uuid card for each listed config (one request each). Off = names only'),
    include_snippets: z.boolean().default(true).describe('Also read the panel snippet list'),
    limit: z.number().int().default(DEFAULT_LIMIT).describe('Page configs listed, capped at 50'),
  }),
  access: 'ro',
  risk: 'none',
  /**
   * ОБА ПРОФИЛЯ, и это решение по СОДЕРЖИМОМУ, а не послабление. Здесь нет ни
   * одного ключа, ни одного адреса ноды и ни одного имени инбаунда — это текст,
   * который панель и так показывает КАЖДОМУ клиенту, открывшему свою ссылку.
   * Прятать от бота то, что клиент видит в браузере, значило бы запретить ему
   * ответить «поставьте Happ, вот кнопка» — а это ровно тот вопрос, ради
   * которого бот и существует. Граница §7.2 проходит по топологии и кредам, а
   * не по «панельное — значит операторское».
   */
  profiles: ['human', 'bot'],
  backends: ['remna'],
  handler: async ({ uuid, include_bodies, include_snippets, limit }, ctx) => {
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const cap = capLimit(limit, DEFAULT_LIMIT, MAX_LIMIT);
    const wanted = str(uuid);

    if (wanted !== null && !UUID_RE.test(wanted)) {
      // Панель валидирует uuid строго и отвечает 400 — то есть отказ источника
      // встал бы на место ответа «такого конфига нет». Отвечаем сами.
      warnings.push(
        warn(
          'subpage_uuid_malformed',
          `"${wanted}" is not a uuid, so it cannot name a page config. These are addressed by ` +
            'uuid only — there is no by-name route. Call without `uuid` to list them and pick ' +
            'from the names there.',
        ),
      );
    }

    const [listed, snippets] = await Promise.all([
      settle(ctx.remna.get<unknown>(CONFIGS_PATH)),
      include_snippets
        ? settle(ctx.remna.get<unknown>(SNIPPETS_PATH))
        : Promise.resolve({ ok: true as const, value: null }),
    ]);

    // Строки — из `envelope`, «сервер назвал число» — из `declaredTotal`:
    // первый подставляет длину списка, когда `total` в теле нет, и «панель
    // промолчала» становится неотличимо от «столько их и есть».
    const listedBody = take(listed, 'remna', degraded, null);
    const listing = envelope(listedBody, 'configs');
    const all = listing.rows;
    const selected =
      wanted === null
        ? all.slice(0, cap)
        : all.filter((row) => (str(row.uuid) ?? '').toLowerCase() === wanted.toLowerCase());

    if (wanted !== null && listed.ok && selected.length === 0 && UUID_RE.test(wanted)) {
      warnings.push(
        warn(
          'subpage_config_not_found',
          `No page config with uuid ${wanted} exists on this panel. The listing holds ` +
            `${String(all.length)} config(s); their uuids are the only way to address one.`,
        ),
      );
    }

    const bodyBudget = wanted === null ? MAX_BODIES : selected.length;
    const configs: PageConfig[] = [];
    const hits: SecretShapeHit[] = [];
    let bodiesRead = 0;
    for (const row of selected) {
      const id = str(row.uuid);
      const base = {
        uuid: id,
        name: str(row.name),
        viewPosition: optionalNumber(row.viewPosition),
      };
      if (!include_bodies || id === null || configs.length >= bodyBudget) {
        configs.push({ ...base, bodyRead: false, summary: null });
        continue;
      }
      const card = await settle(ctx.remna.get<unknown>(`${CONFIGS_PATH}/${id}`));
      if (!card.ok) {
        degraded.push({ system: 'remna', error: card.error });
        configs.push({ ...base, bodyRead: false, summary: null });
        continue;
      }
      bodiesRead += 1;
      const scrubbed = scrubSecretShapesDeep(summarisePage(asRecord(asRecord(card.value).config)));
      hits.push(...scrubbed.hits);
      configs.push({ ...base, bodyRead: true, summary: scrubbed.value });
    }

    const snippetsBody = take(snippets, 'remna', degraded, null);
    const snippetList = include_snippets
      ? envelope(snippetsBody, 'snippets')
      : { rows: [], total: 0 };
    const snippetScrub = scrubSecretShapesDeep(
      snippetList.rows.map((row) => ({ name: str(row.name), snippet: row.snippet })),
    );
    hits.push(...snippetScrub.hits);
    const scrubbed = summarise(hits);

    if (listed.ok && all.length > 0 && all.every((row) => row.config === null)) {
      warnings.push(
        warn(
          'subpage_body_absent_from_listing',
          'Every config in the listing carries `config: null`. That is how this route always ' +
            'answers — the body exists only in the per-uuid card — so it is not evidence that ' +
            'the page is unconfigured. Anything below marked `bodyRead: false` was simply not ' +
            'fetched.',
        ),
      );
    }
    if (include_snippets && snippets.ok && snippetList.rows.length === 0) {
      warnings.push(
        warn(
          'feature_present_but_unused',
          'The snippets controller answered normally and holds nothing: the feature is installed ' +
            'on this panel and nobody has created a snippet. That is a different fact from a ' +
            'missing route, and it means no template on this panel can reference a snippet by ' +
            'name — a reference that looks broken is broken because the target was never made.',
        ),
      );
    }
    if (wanted === null && all.length > selected.length) {
      warnings.push(
        warn(
          'truncated',
          `${String(selected.length)} of ${String(all.length)} page configs are shown (limit ` +
            `${String(cap)}). "There is no such page config" cannot be concluded from this slice.`,
        ),
      );
    }
    if (include_bodies && selected.length > bodiesRead) {
      warnings.push(
        warn(
          'subpage_bodies_not_all_read',
          `${String(bodiesRead)} of ${String(selected.length)} bodies were read (cap ` +
            `${String(MAX_BODIES)} per call, plus any card that failed — see \`degraded\`). ` +
            'The configs without a summary are unread, not empty; name one with `uuid` to read it.',
        ),
      );
    }
    if (scrubbed.removed > 0) {
      warnings.push(
        warn(
          'secrets_scrubbed',
          `${String(scrubbed.removed)} value(s) matching a secret shape were removed from this ` +
            `answer (jwt: ${String(scrubbed.by_shape.jwt)}, assigned to a secret-shaped name: ` +
            `${String(scrubbed.by_shape.named_assignment)}, long opaque run: ` +
            `${String(scrubbed.by_shape.opaque_run)}). A page config is client-facing text and ` +
            'should contain none of these, so each one is worth looking at rather than noting: ' +
            'a credential pasted into an install instruction is published to every subscriber.',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'At least one call did not answer (see `degraded`). Read a missing body as unknown, ' +
            'not as an unconfigured page: this tool cannot tell the two apart when the panel ' +
            'stays silent.',
        ),
      );
    }

    return {
      configs: {
        /** Что сказал сервер, а не длина показанного куска. */
        declared_total: listed.ok ? declaredTotal(listedBody) : null,
        listed: all.length,
        returned: configs.length,
        bodiesRead,
        items: configs,
      },
      snippets: include_snippets
        ? {
            declared_total: snippets.ok ? declaredTotal(snippetsBody) : null,
            returned: snippetScrub.value.length,
            items: snippetScrub.value,
          }
        : null,
      scrubbed,
      warnings,
      degraded,
    };
  },
});

function optionalNumber(value: unknown): number | null {
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}
