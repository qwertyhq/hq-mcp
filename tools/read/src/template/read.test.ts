import { describe, expect, it } from 'vitest';
import { JWT_MASK } from '@hq/redact';
import { MUTATING_GET_PATHS, assertNotForbidden } from '@hq/registry';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { templateRead } from './read.js';

/**
 * Форма ответа снята с работающей SHM 2.19.4, значения выдуманы:
 *  - список несёт ТОЛЬКО `id` и `settings`, никакого `data`;
 *  - `items` приезжает НУЛЁМ при полном списке отданных строк;
 *  - `limit`/`offset` эхом возвращаются в конверте и на выборку не влияют;
 *  - тело приезжает только у запроса с `?id=`, полем `data` внутри строки.
 */
const NAMES = [
  'hwid_blocker',
  'brevo_payment_received',
  'tg_autopay_charge',
  '.DAV/hwid_blocker',
  'bak-deeplinks-20240101-0000/brevo_payment_received',
];

const BODY = [
  '{{ # провижининг HWID }}',
  `{{ REMNA_TOKEN = "${['eyJ', 'hbGciOiJIUzI1NiJ9'].join('')}.${['eyJ', 'zdWIiOiJhYmMifQ'].join('')}.Sfl5c1TJSMeKKF2QT4fwpMeJf36POk6yJVadQssw6AB" }}`,
  '{{ http.post("$API_URL/api/hwid/devices/delete") }}',
].join('\n');

function listEnvelope(): unknown {
  return {
    // Ровно то, что отдаёт работающая SHM: счётчик нулевой, страница «полная».
    items: 0,
    limit: 500,
    offset: 0,
    data: NAMES.map((id) => ({ id, settings: {} })),
  };
}

function makeShm(calls: StubCall[] = []) {
  return makeCtx({
    calls,
    shmList: (path, params) => {
      if (path !== '/admin/template') throw new Error(`unexpected path ${path}`);
      const id = params?.id;
      if (id === undefined) return listEnvelope();
      if (!NAMES.includes(String(id))) return { items: 0, limit: 1, offset: 0, data: [] };
      return { items: 0, limit: 1, offset: 0, data: [{ id, settings: {}, data: BODY }] };
    },
  });
}

type Answer = Awaited<ReturnType<typeof templateRead.handler>>;

async function call(input: unknown, calls: StubCall[] = []): Promise<Answer> {
  return (await templateRead.handler(
    templateRead.input.parse(input),
    makeShm(calls),
  )) as Answer;
}

function codes(answer: Answer): string[] {
  return (answer as { warnings: { code: string }[] }).warnings.map((one) => one.code);
}

describe('template_read', () => {
  it('lists names without a single body when no id is given', async () => {
    const answer = (await call({})) as {
      template: unknown;
      list: { templates: { id: string }[]; total_names: number; declared_items: number };
    };
    expect(answer.template).toBeNull();
    expect(answer.list.total_names).toBe(NAMES.length);
    // Тела в списке нет НИ У ОДНОГО имени — маршрут его не отдаёт, и
    // инструмент не делает вид, что отдаёт.
    expect(JSON.stringify(answer.list.templates)).not.toContain('REMNA_TOKEN');
  });

  it('hides backup copies by default and says how many it hid', async () => {
    const answer = (await call({})) as { list: { templates: { id: string }[]; backups: number } };
    expect(answer.list.templates.map((one) => one.id)).toEqual([
      'hwid_blocker',
      'brevo_payment_received',
      'tg_autopay_charge',
    ]);
    expect(answer.list.backups).toBe(2);
    expect(codes(answer as unknown as Answer)).toContain('backup_copies_listed');
  });

  it('includes the backup copies when asked, because that is the leak audit', async () => {
    const answer = (await call({ include_backups: true })) as {
      list: { templates: { id: string; kind: string }[] };
    };
    expect(answer.list.templates).toHaveLength(NAMES.length);
    expect(answer.list.templates.filter((one) => one.kind === 'backup')).toHaveLength(2);
  });

  it('warns that the server applies neither limit nor offset on this route', async () => {
    // Это НЕ косметика: `items: 0` при пяти отданных строках — то, что сервер
    // отвечает на самом деле, и вызывающий, прочитавший ноль как «шаблонов
    // нет», получил бы прямо противоположный факт.
    const answer = (await call({})) as { list: { declared_items: number } };
    expect(answer.list.declared_items).toBe(0);
    expect(codes(answer as unknown as Answer)).toContain('pagination_not_supported');
  });

  it('narrows by search here, not on the server', async () => {
    const answer = (await call({ search: 'AUTOPAY' })) as { list: { templates: { id: string }[] } };
    expect(answer.list.templates.map((one) => one.id)).toEqual(['tg_autopay_charge']);
  });

  it('says a slice is a slice when the limit cuts the list', async () => {
    const answer = (await call({ limit: 1 })) as { list: { returned: number; matched: number } };
    expect(answer.list.returned).toBe(1);
    expect(answer.list.matched).toBe(3);
    expect(codes(answer as unknown as Answer)).toContain('truncated');
  });

  it('returns one body, scrubbed, and counts what it removed', async () => {
    const answer = (await call({ id: 'hwid_blocker' })) as {
      template: { body: string; scrubbed: { removed: number }; bytes: number; lines: number };
    };
    expect(answer.template.body).toContain(JWT_MASK);
    expect(answer.template.body).not.toContain('Sfl5c1TJSMeKKF2QT4fwpMeJf36POk6yJVadQssw6AB');
    expect(answer.template.scrubbed.removed).toBe(1);
    // Логика остаётся читаемой — ради неё тело и отдают.
    expect(answer.template.body).toContain('REMNA_TOKEN');
    expect(answer.template.body).toContain('/api/hwid/devices/delete');
    // Размер — от ИСХОДНОГО тела: усечённая длина врала бы про файл.
    expect(answer.template.bytes).toBe(BODY.length);
    expect(answer.template.lines).toBe(3);
    expect(codes(answer as unknown as Answer)).toContain('secrets_scrubbed');
  });

  it('names the scrub summary so field-name redaction cannot eat it', async () => {
    // `SECRET_KEY_RE` (/token|secret|key|password|auth/i) матчит имя ПОЛЯ, и
    // сводка, названная `secrets`, уезжала бы вызывающему как '<redacted>' —
    // отчёт о вырезанных секретах пропадал бы целиком, а инструмент выглядел
    // бы работающим. Полный конвейер это ловит в redaction-contract.test.ts;
    // здесь то же требование записано там, где живёт имя.
    const answer = (await call({ id: 'hwid_blocker' })) as { template: Record<string, unknown> };
    const fields = Object.keys(answer.template);
    expect(fields).toContain('scrubbed');
    expect(fields.filter((one) => /token|secret|key|password|auth/i.test(one))).toEqual([]);
  });

  it('asks SHM by query parameter, never by putting the name in the path', async () => {
    // Три причины разом: маршрут `/{id}` отдаёт text/plain, который клиент не
    // разбирает; имя законно содержит `/`; и подстановка имени в путь — это
    // единственный способ дотянуться до чужого файла.
    const calls: StubCall[] = [];
    await call({ id: '.DAV/hwid_blocker' }, calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/admin/template');
    expect(calls[0]?.params?.id).toBe('.DAV/hwid_blocker');
  });

  it('refuses a name that walks out of the templates directory', async () => {
    // Бэкенд склеивает путь строкой и не проверяет ничего
    // (Core::Template::read_template_from_file), поэтому отказ обязан жить тут.
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/../../b', 'x\\y']) {
      await expect(call({ id: bad })).rejects.toThrow(/refused before it reaches SHM/);
    }
  });

  it('refuses an empty name instead of silently listing everything', async () => {
    await expect(call({ id: '   ' })).rejects.toThrow(/empty template name/i);
  });

  it('marks a backup body as never executed', async () => {
    const answer = (await call({ id: '.DAV/hwid_blocker' })) as { template: { kind: string } };
    expect(answer.template.kind).toBe('backup');
    expect(codes(answer as unknown as Answer)).toContain('backup_copies_listed');
  });

  it('reports a missing template as missing, not as an empty one', async () => {
    const answer = (await call({ id: 'no_such_template' })) as { template: unknown };
    expect(answer.template).toBeNull();
    expect(codes(answer as unknown as Answer)).toContain('template_not_found');
  });

  /**
   * ДВА РАЗНЫХ ФАКТА, КОТОРЫЕ ЛЕГКО СЛИТЬ В ОДИН — и первая версия хендлера
   * их слила: `str()` отдаёт null и на пустой строке, и на отсутствующем поле,
   * поэтому шаблон в НОЛЬ БАЙТ объявлялся несуществующим. На работающей
   * установке такие есть (`public_price_list`, `remna_my`, оба по 0 байт), и
   * это ровно та поломка, ради которой чтение шаблонов и открыли: пустой файл
   * рендерится в ничто, а задача рапортует SUCCESS.
   */
  it('reports a zero-byte template as empty, not as missing', async () => {
    const ctx = makeCtx({
      shmList: (path, params) =>
        params?.id === undefined
          ? listEnvelope()
          : { items: 0, limit: 1, offset: 0, data: [{ id: params.id, settings: {}, data: '' }] },
    });
    const answer = (await templateRead.handler(
      templateRead.input.parse({ id: 'public_price_list' }),
      ctx,
    )) as { template: { bytes: number; body: string } | null; warnings: { code: string }[] };

    expect(answer.template).not.toBeNull();
    expect(answer.template?.bytes).toBe(0);
    const found = answer.warnings.map((one) => one.code);
    expect(found).toContain('template_body_empty');
    expect(found).not.toContain('template_not_found');
  });

  it('degrades instead of throwing when SHM does not answer', async () => {
    const ctx = makeCtx({
      shmList: () => {
        throw new Error('SHM GET /admin/template: HTTP 502');
      },
    });
    const answer = (await templateRead.handler(templateRead.input.parse({}), ctx)) as {
      list: { total_names: number };
      degraded: { system: string }[];
    };
    expect(answer.list.total_names).toBe(0);
    expect(codes(answer as unknown as Answer)).toContain('partial_result');
    expect(answer.degraded[0]?.system).toBe('shm');
  });

  it('refuses the bot profile in its own handler', async () => {
    const ctx = makeCtx({ profile: 'bot', shmList: () => listEnvelope() });
    await expect(templateRead.handler(templateRead.input.parse({}), ctx)).rejects.toThrow(
      /human profile only/,
    );
  });

  it('reads a route the forbidden gate allows for GET and refuses for create/delete', () => {
    expect(() => assertNotForbidden('/admin/template', 'GET')).not.toThrow();
    // POST открыт под template_edit (перезапись существующего со снимком «до»),
    // и этот инструмент им всё равно не пользуется: он только читает.
    expect(() => assertNotForbidden('/admin/template', 'POST')).not.toThrow();
    for (const method of ['PUT', 'DELETE']) {
      expect(() => assertNotForbidden('/admin/template', method)).toThrow(
        /CREATING \(PUT\) and DELETING/,
      );
    }
  });

  it('never builds a path that reaches one of the mutating GETs', () => {
    // `/template/smena` и `/template/roulette` мутируют на GET. Инструмент
    // ходит только по `/admin/template`, и имя шаблона в путь не попадает —
    // значит дотянуться до них он не может ни при каком вводе.
    for (const bad of MUTATING_GET_PATHS) {
      expect('/admin/template'.startsWith(bad)).toBe(false);
    }
  });
});
