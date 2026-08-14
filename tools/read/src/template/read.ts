import { assertSafeTemplateName, defineTool, templateKind } from '@hq/registry';
import { scrubSecretShapes } from '@hq/redact';
import { z } from 'zod';
import type { SecretShapeHit } from '@hq/redact';
import type { TemplateKind } from '@hq/registry';
import type { Degraded, ToolWarning } from '@hq/types';
import { EMPTY_LIST, asRecord, assertHumanOnly, capLimit, settle, str, take, warn } from '../kit.js';

const MAX_LIMIT = 300;
const DEFAULT_LIMIT = 60;

/**
 * ЕДИНСТВЕННЫЙ путь, которым этот инструмент ходит за шаблоном. Ровно один
 * маршрут и на список, и на тело — и это не экономия, а три факта, измеренных
 * на работающей SHM 2.19.4:
 *
 *  1. `GET /admin/template/{id}` отдаёт `Content-Type: text/plain` и голое тело
 *     файла. `ShmClient` парсит ответ как JSON и на таком теле бросает
 *     «returned a non-JSON body» — то есть штатный клиент этим маршрутом
 *     воспользоваться НЕ МОЖЕТ вовсе. `GET /admin/template?id=<имя>` отдаёт то
 *     же тело внутри обычного конверта `{data:[{id, data, settings}]}`.
 *  2. Имя шаблона законно содержит `/`: в работающей установке встречаются и
 *     `.DAV/<имя>`, и `bak-<метка>/<имя>`. Подставленное в ПУТЬ такое имя даёт
 *     другой маршрут, а не другой шаблон.
 *  3. Имя уезжает в `sprintf("%s/%s.tpl", $dir, $id)` БЕЗ САНИТАЙЗА
 *     (app/lib/Core/Template.pm:324-334). Единственная преграда на пути
 *     `../../` — проверка в этом файле, чужой её нет.
 *
 * Литерал стоит открыто: правило §8 на `/admin/template` сужено до PUT/DELETE
 * (создать и удалить), поэтому скан запрещённых литералов его не считает
 * нарушением, а рантайм-гейт по-прежнему ловит создание и удаление. Перезапись
 * существующего шаблона умеет ровно один инструмент — `template_edit`.
 */
const TEMPLATE_PATH = '/admin/template';

/**
 * Различать исполняемый шаблон и копию обязательно: копий в списке набирается
 * заметная часть, они ОТЛИЧАЮТСЯ по содержимому от исполняемых (в них те же
 * секреты и старая логика), и диагноз, поставленный по `.DAV/<имя>` вместо
 * `<имя>`, будет про шаблон, который не исполняется.
 *
 * И это правило, и отказ на небезопасном имени (`refuseUnsafeId` → теперь
 * `assertSafeTemplateName`) переехали в `@hq/registry`, когда у них появился
 * ВТОРОЙ потребитель — `template_edit`. Две копии проверки, одна из которых
 * стоит на записи, разъезжаются молча и всегда в худшую сторону.
 */
const kindOf = templateKind;

/**
 * ИМЕНА ПОЛЕЙ ЗДЕСЬ ВЫБРАНЫ ТАК, ЧТОБЫ ИХ НЕ СЪЕЛА РЕДАКЦИЯ.
 *
 * `SECRET_KEY_RE` в @hq/redact — это /token|secret|key|password|auth/i по ИМЕНИ
 * ключа, и подстрока `secret` матчится буквально. Первая версия этой сводки
 * называлась `secrets` с ветками `jwt/assigned_secret/opaque_run`, и исполнитель
 * возвращал `secrets: "<redacted>"` — то есть отчёт о вырезанных секретах сам
 * уезжал маркером, а инструмент выглядел работающим. Ровно так же уезжал
 * маркером `uniq_key` у платежей. Поймал это redaction-contract.test.ts,
 * который гоняет ответ через настоящий executeTool; тесты, зовущие хендлер
 * напрямую, были зелены.
 */
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

interface TemplateSummary {
  id: string;
  kind: TemplateKind;
  /** Настройки шаблона (`<имя>.tpls`). Пусты почти везде; непустые — редкость, которую стоит видеть. */
  settings: unknown;
}

function toSummary(row: Record<string, unknown>): TemplateSummary | null {
  const id = str(row.id);
  if (id === null) return null;
  return { id, kind: kindOf(id), settings: row.settings ?? null };
}

export const templateRead = defineTool({
  name: 'template_read',
  description:
    'Read SHM templates — the file that actually produces a notification, a provisioning script ' +
    'or a payment handler. WITHOUT `id` it LISTS templates (name, live-or-backup, settings) and ' +
    'returns no bodies at all; WITH `id` it returns ONE body. That split is forced by the route: ' +
    'the list endpoint carries no body field, so "all bodies" would be one request per template. ' +
    'This is the tool for "the task says SUCCESS but the client got nothing" — a template that ' +
    'renders empty sends nothing and still reports success, and the cause is only visible in the ' +
    'file. An existing but ZERO-BYTE template is reported as exactly that, never as "not found": ' +
    'the difference between "no such file" and "the file is there and empty" is the whole ' +
    'diagnosis. Creating and deleting a template are refused everywhere and always; overwriting ' +
    'an existing one is template_edit, which snapshots the previous bytes first — this tool never ' +
    'writes anything. ' +
    'BODIES ARE SCRUBBED BY SHAPE BEFORE THEY LEAVE. Templates contain literal credentials in ' +
    'their text — a hardcoded Remnawave API JWT, a sudo password, webhook secrets — and field-name ' +
    'redaction cannot see them, because they are bare substrings inside one big string. JWTs, ' +
    'values assigned to secret-shaped names and long opaque runs are replaced with ' +
    '<redacted:...> markers and counted in `scrubbed`. That is a filter on SHAPE, not a boundary: ' +
    'a password written in prose has no shape and survives. ' +
    'Pagination does not exist on this route — SHM serves templates from files and ignores limit ' +
    'and offset entirely, and reports items=0 no matter how many rows it sent — so any narrowing ' +
    'you see was done here, not by the server. Names ending up under .DAV/ or bak-*/ are editor ' +
    'and hand-made BACKUP copies that are never executed; diagnosing from one is diagnosing the ' +
    'wrong file.',
  input: z.object({
    id: z
      .string()
      .nullable()
      .default(null)
      .describe('Exact template name to read the body of; omit to list templates without bodies'),
    search: z
      .string()
      .nullable()
      .default(null)
      .describe('Case-insensitive substring of the name; narrows the LIST, ignored when id is set'),
    include_backups: z
      .boolean()
      .default(false)
      .describe('Include .DAV/ and bak-*/ copies in the list; they are never executed'),
    limit: z.number().int().default(DEFAULT_LIMIT).describe('Listed names, capped at 300'),
  }),
  access: 'ro',
  risk: 'medium',
  /**
   * ТОЛЬКО human, и это решение по СОДЕРЖИМОМУ, а не осторожность по инерции.
   *
   * Баланс клиента — один факт известной формы; тело шаблона — вся бизнес-логика
   * биллинга разом: скрипты провижининга, разбор платежей, внутренние адреса и,
   * как показала проверка на работающей установке, литеральные креды в заметной
   * части файлов. Чистка по форме поймала все находки проверенного среза, но
   * она по построению неполна — секрет, написанный словами, формы не имеет.
   * У профиля bot (HTTP-канал плана 3, который пишем не мы) каждый такой
   * промах становится публичным; у human он
   * остаётся у оператора за терминалом, который и так может открыть панель.
   */
  profiles: ['human'],
  backends: ['shm'],
  handler: async ({ id, search, include_backups, limit }, ctx) => {
    assertHumanOnly(
      ctx,
      'template_read is available to the human profile only: a template body is the billing ' +
        "logic itself and carries literal credentials in its text, and this tool's shape-based " +
        'scrubber is a filter, not a boundary.',
    );

    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];
    const cap = capLimit(limit, DEFAULT_LIMIT, MAX_LIMIT);

    if (id !== null) {
      const wanted = id.trim();
      if (wanted === '') {
        throw new Error(
          'An empty template name is refused: SHM would read it as "no id given" and answer with ' +
            'the whole listing instead of a body. Omit `id` if a listing is what you want.',
        );
      }
      assertSafeTemplateName(wanted);

      const fetched = await settle(
        ctx.shm.list<Record<string, unknown>>(TEMPLATE_PATH, { id: wanted, limit: 1 }),
      );
      const row = asRecord(take(fetched, 'shm', degraded, EMPTY_LIST).data[0]);
      /**
       * `str()` СОЗНАТЕЛЬНО НЕ ИСПОЛЬЗУЕТСЯ: он отдаёт null и на отсутствующем
       * поле, и на пустой строке, а это два разных факта — «такого файла нет»
       * и «файл есть и он пустой». Второй и есть та поломка, ради которой
       * инструмент существует: пустой шаблон рендерится в ничто, функции
       * отправки нечего отправлять, а задача спула всё равно рапортует SUCCESS.
       * Проверено на работающей установке, а не по спецификации: шаблоны
       * ровно в 0 байт там действительно встречаются — и первая версия этого
       * хендлера объявляла их несуществующими.
       */
      const body = typeof row.data === 'string' ? row.data : null;

      if (body === null) {
        if (fetched.ok) {
          warnings.push(
            warn(
              'template_not_found',
              `SHM returned no body for template "${wanted}". On this deployment templates are ` +
                'FILES under data/templates, so this means no such file — not an empty template. ' +
                'List without `id` to see the names that do exist; note that names are ' +
                'case-sensitive and that backups live under .DAV/ and bak-*/ prefixes.',
            ),
          );
        }
        warnings.push(...partialWarning(degraded, false));
        return {
          template: null,
          list: null,
          warnings,
          degraded,
        };
      }

      const { text, hits } = scrubSecretShapes(body);
      const scrubbed = summarise(hits);
      if (body.trim() === '') {
        warnings.push(
          warn(
            'template_body_empty',
            `Template "${wanted}" exists and is ${String(body.length)} bytes — the file is ` +
              'there and has nothing in it. This is not a read failure and not a missing ' +
              'template: it is the silent-mailer shape at its source. An empty template renders ' +
              'to nothing, the send call has nothing to send, and the spool task still finishes ' +
              'SUCCESS, so the only trace is a delivery row marked SKIPPED / EMPTY_RENDER. ' +
              'Anything that fires this template notifies nobody.',
          ),
        );
      }
      if (scrubbed.removed > 0) {
        warnings.push(
          warn(
            'secrets_scrubbed',
            `${String(scrubbed.removed)} literal secret(s) were removed from this body before it ` +
              `left the tool (jwt: ${String(scrubbed.by_shape.jwt)}, assigned to a ` +
              `secret-shaped name: ${String(scrubbed.by_shape.named_assignment)}, long opaque ` +
              `run: ${String(scrubbed.by_shape.opaque_run)}). Each is a <redacted:...> marker ` +
              'in place, ' +
              'so the surrounding logic still reads correctly — but the template as executed has ' +
              'a real value there. Two consequences worth acting on rather than noting: the ' +
              'credential is hardcoded in a file with no git history, and it is in whatever ' +
              'backup copies of that file exist alongside it.',
          ),
        );
      }
      if (kindOf(wanted) === 'backup') {
        warnings.push(
          warn(
            'backup_copies_listed',
            `"${wanted}" sits under a backup prefix (.DAV/ or bak-*/). SHM never executes it: ` +
              'the worker resolves the name without the prefix. Anything concluded from this ' +
              'body is about a copy, not about what runs.',
          ),
        );
      }
      warnings.push(...partialWarning(degraded, false));

      return {
        template: {
          id: wanted,
          kind: kindOf(wanted),
          settings: row.settings ?? null,
          bytes: body.length,
          lines: body.split('\n').length,
          scrubbed,
          body: text,
        },
        list: null,
        warnings,
        degraded,
      };
    }

    const listed = await settle(
      // limit уезжает ради конверта и бюджета, а не ради сужения: этот маршрут
      // его игнорирует (см. предупреждение pagination_not_supported ниже).
      ctx.shm.list<Record<string, unknown>>(TEMPLATE_PATH, { limit: MAX_LIMIT }),
    );
    const page = take(listed, 'shm', degraded, EMPTY_LIST);
    const all = page.data.map(asRecord).map(toSummary).filter(isSummary);

    const needle = search === null ? null : search.trim().toLowerCase();
    const matched = all.filter((one) => {
      if (!include_backups && one.kind === 'backup') return false;
      if (needle === null || needle === '') return true;
      return one.id.toLowerCase().includes(needle);
    });
    const templates = matched.slice(0, cap);

    if (listed.ok && all.length > 0) {
      warnings.push(
        warn(
          'pagination_not_supported',
          `SHM returned all ${String(all.length)} template names in one answer and declared ` +
            `items=${String(page.items)}. Neither number is a paging cursor: on this deployment ` +
            'templates are files, so Core::Template::_list walks the directory and applies ' +
            'neither limit nor offset, and the declared count stays 0 however many rows it sent. ' +
            'Asking for a different offset returns the same list. Every narrowing below — the ' +
            'backup filter, the search, the limit — was applied here, in the tool.',
        ),
      );
    }
    if (matched.length > templates.length) {
      warnings.push(
        warn(
          'truncated',
          `${String(templates.length)} of ${String(matched.length)} matching names are shown ` +
            `(limit ${String(cap)}). "There is no such template" cannot be concluded from this ` +
            'slice — narrow with `search` or raise `limit`.',
        ),
      );
    }
    const backups = all.filter((one) => one.kind === 'backup').length;
    if (listed.ok && backups > 0 && !include_backups) {
      warnings.push(
        warn(
          'backup_copies_listed',
          `${String(backups)} of ${String(all.length)} names are backup copies under .DAV/ or ` +
            'bak-*/ and were left out. They are real files that a name lookup can hit, they hold ' +
            'the same hardcoded credentials as the originals, and SHM never executes them. Pass ' +
            'include_backups to see them — for an audit of where a secret got copied, that is ' +
            'exactly what you want.',
        ),
      );
    }
    warnings.push(...partialWarning(degraded, true));

    return {
      template: null,
      list: {
        /** Что сказал сервер. Ноль — не «шаблонов нет», а «эта ручка счётчик не считает». */
        declared_items: page.items,
        total_names: all.length,
        backups,
        matched: matched.length,
        returned: templates.length,
        templates,
      },
      warnings,
      degraded,
    };
  },
});

function isSummary(value: TemplateSummary | null): value is TemplateSummary {
  return value !== null;
}

function partialWarning(degraded: Degraded[], listing: boolean): ToolWarning[] {
  if (degraded.length === 0) return [];
  return [
    warn(
      'partial_result',
      'SHM did not answer (see `degraded`). ' +
        (listing
          ? 'The listing is empty rather than short: read it as "unknown", not as "no templates".'
          : 'No body was read, so nothing here says the template is missing or empty.'),
    ),
  ];
}
