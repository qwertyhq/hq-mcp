import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_RULES,
  MUTATING_GET_PATHS,
  REFUSAL_INSTRUCTIONS,
  assertNotForbidden,
  explainRefusal,
  scanForbiddenLiterals,
} from './forbidden.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function sources(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // каталог ещё не создан планом 2 — это не повод падать
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('forbidden rules', () => {
  it('lists every §8 operation and the mutating GETs of §6.15', () => {
    const patterns = FORBIDDEN_RULES.map((rule) => rule.pattern);
    expect(patterns).toContain('/admin/server/identity');
    expect(patterns).toContain('/api/tokens');
    expect(patterns).toContain('/admin/spool/manual/success');
    expect(patterns).toContain('/api/subscriptions');
    expect(MUTATING_GET_PATHS).toEqual([
      '/promo/apply',
      '/template/',
      '/template/smena',
      '/template/roulette',
      '/public/',
      '/user/passkey/register',
      '/user/auth/passkey',
      '/user/passwd/reset',
      '/telegram/webapp/auth',
      '/telegram/web/auth',
      '/telegram/web/callback',
    ]);
  });

  /**
   * Список мутирующих GET сравнивается `startsWith`, поэтому у него есть
   * обязанность, которой нет у FORBIDDEN_RULES: не задеть соседний путь, у
   * которого то же начало. Эти проверки — про границы, а не про состав.
   */
  it('closes the client-side mutating GETs without closing the reads next to them', () => {
    const blocked = (path: string): boolean => MUTATING_GET_PATHS.some((bad) => path.startsWith(bad));

    // Исполнение шаблона клиентом закрыто целиком, а не двумя именами.
    expect(blocked('/template/smena')).toBe(true);
    expect(blocked('/template/anything_else')).toBe(true);
    expect(blocked('/public/oferta')).toBe(true);
    // ...и чтение ТЕЛ шаблонов при этом остаётся открытым: template_read ходит
    // по /admin/template, который под '/template/' не подпадает.
    expect(blocked('/admin/template')).toBe(false);

    // Аутентификационные GET закрыты, а читающие соседи с тем же префиксом — нет.
    expect(blocked('/user/passkey/register')).toBe(true);
    expect(blocked('/user/auth/passkey')).toBe(true);
    expect(blocked('/user/passwd/reset/verify')).toBe(true);
    expect(blocked('/user/passkey')).toBe(false);
    expect(blocked('/user/password-auth')).toBe(false);

    // Телеграм-вход закрыт, настройки бота у клиента — читаются.
    expect(blocked('/telegram/web/auth/init')).toBe(true);
    expect(blocked('/telegram/web/auth/start')).toBe(true);
    expect(blocked('/telegram/user')).toBe(false);

    // Клиентские маршруты, на которых стоят три новых инструмента.
    for (const path of [
      '/user/pay',
      '/user/pay/forecast',
      '/user/pay/paysystems',
      '/user/withdraw',
      '/user/autopayment',
      '/user/email',
      '/user/otp',
      '/user/referrals',
      '/service',
      '/service/order',
      '/promo',
    ]) {
      expect(blocked(path)).toBe(false);
    }
    // ...а применение промокода — по-прежнему нет.
    expect(blocked('/promo/apply/FREEWORM')).toBe(true);
  });

  it('matches /admin/config exactly and everything else by prefix', () => {
    // §8 запрещает ДАМП конфига целиком, §5.1 требует чтение одного ключа из
    // allowlist. Разница выражается полем match, а не комментарием.
    const config = FORBIDDEN_RULES.find((rule) => rule.pattern === '/admin/config');
    expect(config?.match).toBe('exact');
    expect(FORBIDDEN_RULES.find((rule) => rule.pattern === '/api/tokens')?.match).toBe('prefix');
    expect(FORBIDDEN_RULES.every((rule) => rule.reason.length > 0)).toBe(true);
  });

  it('refuses a forbidden path and lets a normal one through', () => {
    expect(() => assertNotForbidden('/admin/user/service')).not.toThrow();
    expect(() => assertNotForbidden('/api/tokens/abc')).toThrow(/plaintext/);
    expect(() => assertNotForbidden('/admin/server/identity/generate')).toThrow(/private/i);
    // Список ключей запрещён ровно так же, как их генерация: он и есть то, что
    // отдаёт приватный ключ. Раньше правило стояло на `/generate`, и эта строка
    // была красной — запрет существовал на бумаге, но не в рантайме.
    expect(() => assertNotForbidden('/admin/server/identity')).toThrow(/private/i);
    // ...и при этом инвентарь серверов остаётся читаемым: соседний путь не
    // должен уехать под запрет вместе с ним.
    expect(() => assertNotForbidden('/admin/server')).not.toThrow();
    expect(() => assertNotForbidden('/admin/server/group')).not.toThrow();
    expect(scanForbiddenLiterals(`const p = '/admin/server/group';`)).toEqual([]);
    expect(scanForbiddenLiterals(`const p = '/admin/server/identity';`)).toEqual([
      '/admin/server/identity',
    ]);
  });

  it('refuses the config dump but lets a single allowlisted key through', () => {
    expect(() => assertNotForbidden('/admin/config')).toThrow(/wholesale/i);
    expect(() => assertNotForbidden('/admin/config?limit=0')).toThrow(/wholesale/i);
    expect(() => assertNotForbidden('/admin/config/telegram_bot')).not.toThrow();
    expect(() => assertNotForbidden('/admin/config/cli.url')).not.toThrow();
  });

  it('scans source text with the same exact/prefix semantics', () => {
    expect(scanForbiddenLiterals(`const p = '/admin/config';`)).toEqual(['/admin/config']);
    expect(scanForbiddenLiterals('const p = `/admin/config/${name}`;')).toEqual([]);
    expect(scanForbiddenLiterals(`await get("/api/tokens/abc")`)).toEqual(['/api/tokens']);
    // Объяснять запрет словами инструментам не запрещено — ловим только литералы.
    expect(scanForbiddenLiterals('// never call /api/tokens from here')).toEqual([]);
  });

  it('lets a doc comment name a forbidden path in markdown backticks', () => {
    // Доккомментарии здесь пишутся с обратными кавычками, а обратная кавычка —
    // полноценный строковый литерал. Пока комментарии не вырезались,
    // предохранитель краснел ровно на объяснении того, что защищает: автор
    // либо убирал кавычки, либо переставал документировать. Предохранитель,
    // наказывающий за документирование, учит писать хуже.
    const doc = ['/**', ' * Запрещён `PUT /admin/spool` (job_users).', ' */'].join('\n');
    expect(scanForbiddenLiterals(doc)).toEqual([]);
    expect(scanForbiddenLiterals('/* см. `/api/tokens` в §8 */')).toEqual([]);
    // ...а в коде тот же литерал по-прежнему нарушение.
    expect(scanForbiddenLiterals("await get('/api/tokens/abc')")).toEqual(['/api/tokens']);
  });

  it('does not let a slash inside a string open a comment', () => {
    // Наивная вырезка комментариев проглотила бы хвост строки после 'https://'
    // и вместе с ним литерал, стоящий следом, — предохранитель замолчал бы
    // на честном коде. Пропуск здесь дороже ложной тревоги.
    const line = `const doc = 'https://example.test/x'; await get('/api/tokens/abc');`;
    expect(scanForbiddenLiterals(line)).toEqual(['/api/tokens']);
  });

  // matchForbidden/assertNotForbidden стали методозависимыми в Task 5
  // (DELETE /admin/user/pay запрещён, GET /admin/user/pay — основа
  // billing_ledger), но scanForbiddenLiterals этого не узнал: он бил тревогу
  // на голый литерал независимо от того, какой rule.methods у правила, и
  // легитимное чтение приходилось прятать за конкатенацией/переменной,
  // чтобы пройти "no source file hardcodes a forbidden path" (Task 12).
  // Эти четыре теста фиксируют исправление: правило БЕЗ methods остаётся
  // запрещено при любом упоминании литерала (как раньше), а правило С
  // methods (список методов, среди которых нет GET) больше не считает голый
  // литерал нарушением — рантайм-гейт всё равно ловит настоящий DELETE по
  // подлинному методу, скан ему не нужен.
  it('does not flag a bare literal for a rule scoped to non-GET methods', () => {
    // /admin/user/pay: methods: ['DELETE'] — GET на этом пути обязан остаться
    // легитимным (billing_ledger, Task 13), скан не должен заставлять
    // прятать литерал ради обычного чтения.
    const source = `const r = await ctx.shm.list('/admin/user/pay', { user_id });`;
    expect(scanForbiddenLiterals(source)).toEqual([]);
    // То же и для /admin/template после сужения правила до PUT/DELETE:
    // template_read и template_edit держат путь голым литералом, и прятать его
    // за конкатенацией только ради скана было бы платой за операции, которые
    // правило разрешает.
    expect(
      scanForbiddenLiterals(`const r = await ctx.shm.list('/admin/template', { id });`),
    ).toEqual([]);
  });

  it('still flags a bare literal for a method-agnostic rule', () => {
    // /api/keygen не сужен по methods — правило действует на любой метод,
    // и голый литерал остаётся нарушением, как и до фикса.
    const source = `fetch('/api/keygen')`;
    expect(scanForbiddenLiterals(source)).toEqual(['/api/keygen']);
  });

  it('keeps exact-match semantics unchanged by the method-awareness fix', () => {
    expect(scanForbiddenLiterals(`const p = '/admin/config';`)).toEqual(['/admin/config']);
    expect(scanForbiddenLiterals('const p = `/admin/config/${name}`;')).toEqual([]);
  });

  it('keeps contains-match semantics unchanged by the method-awareness fix', () => {
    expect(
      scanForbiddenLiterals('const url = `/api/internal-squads/${uuid}/bulk-actions/add-users`;'),
    ).toEqual(['/bulk-actions/']);
  });

  it('explains why a missing capability is missing instead of saying "no such tool"', () => {
    expect(explainRefusal('identity')).toContain('private SSH key');
    expect(explainRefusal('template')).toContain('no git and no rollback');
    // ...и говорит, ЧТО ИМЕННО отсутствует. Раньше объяснение по слову
    // «template» звучало как «шаблоны недоступны», хотя обосновано было
    // только запретом ЗАПИСИ, — и модель, спросившая про шаблон, узнавала,
    // что возможности нет вовсе. Отказ обязан называть и границу, и то, что
    // за ней осталось доступным.
    expect(explainRefusal('template')).toMatch(/WRITING/);
    expect(explainRefusal('template')).toContain('template_read');
    expect(explainRefusal('weather')).toBeUndefined();
    expect(REFUSAL_INSTRUCTIONS).toContain('deliberately absent');
    expect(REFUSAL_INSTRUCTIONS).toContain('/api/tokens');
  });

  it('forbids PUT /admin/spool (mass mailing) but allows GET /admin/spool (spool_inspect)', () => {
    expect(() => assertNotForbidden('/admin/spool', 'GET')).not.toThrow();
    expect(() => assertNotForbidden('/admin/spool', 'PUT')).toThrow(/job_users/);
  });

  it('forbids deleting a payment, bonus or withdraw but allows reading it (billing_ledger)', () => {
    expect(() => assertNotForbidden('/admin/user/pay', 'GET')).not.toThrow();
    expect(() => assertNotForbidden('/admin/user/pay', 'DELETE')).toThrow(/balance/i);
    expect(() => assertNotForbidden('/admin/user/bonus', 'DELETE')).toThrow(/balance/i);
    expect(() => assertNotForbidden('/admin/user/service/withdraw', 'DELETE')).toThrow(/balance/i);
  });

  /**
   * ГРАНИЦА ПРОВЕДЕНА ПО ФОРМЕ ЗАПРОСА, А НЕ ПО РАДИУСУ ПОРАЖЕНИЯ.
   *
   * `bulk/all/*` задевает весь флот и открыт: `bulk_ops` спрашивает у панели
   * точное число затронутых до применения, отвергает план выше
   * `HQ_MCP_MAX_BULK_USERS` и не показывается боту. `bulk/delete-by-status`
   * закрыт при меньшем радиусе, потому что в его теле СТАТУС, а не люди:
   * очередь удаляет тех, кто подпадёт под статус в момент её работы, — не тех,
   * кого показали оператору.
   */
  it('opens the counted bulk routes and keeps the one that cannot name its victims', () => {
    for (const path of [
      '/api/users/bulk/all/update',
      '/api/users/bulk/all/reset-traffic',
      '/api/users/bulk/all/extend-expiration-date',
      '/api/users/bulk/update',
      '/api/users/bulk/delete',
      '/api/users/bulk/update-squads',
    ]) {
      expect(() => assertNotForbidden(path, 'POST'), path).not.toThrow();
    }
    expect(() => assertNotForbidden('/api/users/bulk/delete-by-status', 'POST')).toThrow(
      /not a list of people/,
    );
    // Скан исходников идёт по той же семантике: литерал открытого пути больше
    // не нарушение, литерал закрытого — по-прежнему да.
    expect(scanForbiddenLiterals(`const p = '/api/users/bulk/all/update';`)).toEqual([]);
    expect(scanForbiddenLiterals(`const p = '/api/users/bulk/delete-by-status';`)).toEqual([
      '/api/users/bulk/delete-by-status',
    ]);
  });

  it('answers the word "bulk" with where it IS available instead of a flat no', () => {
    expect(explainRefusal('bulk')).toContain('bulk_ops');
    expect(explainRefusal('массовая операция')).toContain('bulk_ops');
    // ...но именно те массовые ручки, которых нет, по-прежнему объясняются
    // отказом, а не приглашением.
    expect(explainRefusal('restart-all')).toContain('takes down the fleet');
    expect(explainRefusal('delete-by-status')).toContain('not a list of people');
    expect(explainRefusal('bulk-actions')).toContain('squad');
    expect(REFUSAL_INSTRUCTIONS).toContain('delete-by-status');
  });

  it('forbids squad bulk-actions no matter which uuid sits in the middle of the path', () => {
    expect(() =>
      assertNotForbidden(
        '/api/internal-squads/3fa85f64-5717-4562-b3fc-2c963f66afa6/bulk-actions/add-users',
      ),
    ).toThrow();
    expect(() =>
      assertNotForbidden(
        '/api/external-squads/9c858901-8a57-4791-81fe-4c455b099bc9/bulk-actions/delete-users',
      ),
    ).toThrow();
    expect(() =>
      assertNotForbidden('/api/internal-squads/3fa85f64-5717-4562-b3fc-2c963f66afa6'),
    ).not.toThrow();
  });

  it('forbids reorder on any Remnawave entity', () => {
    expect(() => assertNotForbidden('/api/hosts/actions/reorder')).toThrow();
    expect(() => assertNotForbidden('/api/nodes/actions/reorder')).toThrow();
    expect(() => assertNotForbidden('/api/hosts/actions/enable')).not.toThrow();
  });

  it('leaves a method-scoped rule ungated when no method is given', () => {
    expect(() => assertNotForbidden('/admin/spool')).not.toThrow();
    expect(() => assertNotForbidden('/admin/user/pay')).not.toThrow();
    expect(() => assertNotForbidden('/admin/template')).not.toThrow();
  });

  /**
   * СУЖЕНИЕ, ЗАФИКСИРОВАННОЕ С ОБЕИХ СТОРОН — ДВАЖДЫ.
   *
   * Сперва правило стояло без `methods` и резало любой метод, тогда как его
   * обоснование говорило только про запись. Потом из трёх методов записи
   * открылся POST — перезапись СУЩЕСТВУЮЩЕГО шаблона под `template_edit`,
   * который снимает предыдущие байты до записи и умеет вернуть их обратно.
   *
   * Эти проверки закрепляют ровно текущую границу: чтение и перезапись открыты
   * на обеих формах пути, создание и удаление закрыты на обеих и во всех
   * регистрах. Ослабить это, «починив» тест, нельзя: любое послабление на
   * создании роняет вторую половину.
   */
  it('forbids creating or deleting a template but allows reading and overwriting one', () => {
    for (const path of ['/admin/template', '/admin/template/hwid_blocker']) {
      // template_read
      expect(() => assertNotForbidden(path, 'GET')).not.toThrow();
      // template_edit: перезапись существующего — единственная открытая запись
      expect(() => assertNotForbidden(path, 'POST')).not.toThrow();
      expect(() => assertNotForbidden(path, 'post')).not.toThrow();
      for (const method of ['PUT', 'DELETE', 'put', 'delete']) {
        expect(() => assertNotForbidden(path, method)).toThrow(/CREATING \(PUT\) and DELETING/);
      }
    }
  });

  it('keeps the two closed template methods named one by one, not as "anything but GET"', () => {
    // Правило, написанное отрицанием («всё, кроме GET и POST»), открыло бы
    // создание первым же новым методом. Состав проверяется поимённо, чтобы
    // PATCH, который SHM однажды заведёт, потребовал осознанной строки здесь.
    const rule = FORBIDDEN_RULES.find((one) => one.pattern === '/admin/template');
    expect(rule?.methods).toEqual(['PUT', 'DELETE']);
    expect(rule?.reason).toMatch(/WRITING OVER an existing one is available/);
    // ...и по-прежнему называет то, что за границей осталось доступным.
    expect(rule?.reason).toContain('template_edit');
    expect(rule?.reason).toContain('template_read');
  });

  it('matches a method-scoped rule regardless of the caller\'s method casing', () => {
    // Гейт существует, чтобы будущий вызывающий не мог случайно проскочить, а не
    // потому что сегодняшние вызывающие аккуратно шлют строки в верхнем регистре.
    expect(() => assertNotForbidden('/admin/user/pay', 'delete')).toThrow(/balance/i);
    expect(() => assertNotForbidden('/admin/user/pay', 'DELETE')).toThrow(/balance/i);
    expect(() => assertNotForbidden('/admin/spool', 'put')).toThrow(/job_users/);
    expect(() => assertNotForbidden('/admin/spool', 'PUT')).toThrow(/job_users/);
    expect(() => assertNotForbidden('/admin/user/pay', 'get')).not.toThrow();
    expect(() => assertNotForbidden('/admin/user/pay', 'GET')).not.toThrow();
    expect(() => assertNotForbidden('/admin/spool')).not.toThrow();
  });

  it('scans literals with the same exact/prefix/contains semantics the runtime gate uses', () => {
    expect(
      scanForbiddenLiterals('const url = `/api/internal-squads/${uuid}/bulk-actions/add-users`;'),
    ).toEqual(['/bulk-actions/']);
    expect(scanForbiddenLiterals(`const p = '/api/hosts/actions/reorder';`)).toEqual([
      '/actions/reorder',
    ]);
  });

  it('no source file outside this module hardcodes a forbidden path', () => {
    // Скан покрывает ВСЕ каталоги с инструментами и оба приложения, а не только
    // собственный пакет: иначе будущий read-инструмент спокойно заведёт
    // /api/subscriptions и никто не заметит. Семантика — та же функция, что в
    // рантайме, поэтому tools/read/src/config/read.ts с его
    // `/admin/config/${name}` тут НЕ считается нарушением.
    const files = [
      ...sources(join(repoRoot, 'tools')),
      ...sources(join(repoRoot, 'apps')),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      for (const pattern of scanForbiddenLiterals(readFileSync(file, 'utf8'))) {
        offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
