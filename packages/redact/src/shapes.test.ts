import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ASSIGNED_MASK,
  BOT_TOKEN_MASK,
  JWT_MASK,
  JWT_RE,
  OPAQUE_MASK,
  URL_CREDENTIALS_MASK,
  scrubSecretShapes,
} from './shapes.js';

/**
 * НИ ОДНОГО СЕКРЕТОПОДОБНОГО ЛИТЕРАЛА В ЭТОМ ФАЙЛЕ ЦЕЛИКОМ.
 *
 * `scripts/no-secrets.test.ts` не пускает в коммит ни JWT, ни присваивание
 * длинного значения секретному имени — и это ровно те формы, которые здесь
 * надо проверить. Поэтому образцы СОБИРАЮТСЯ из кусков: в исходнике нет
 * подстроки, которую предохранитель обязан считать секретом, а в памяти
 * получается настоящая форма. Тест, ради прохождения которого пришлось бы
 * отключить предохранитель, — это тест, который учит его отключать.
 */
const jwtSample = (): string =>
  ['eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'].join('') +
  '.' +
  ['eyJ', 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ'].join('') +
  '.' +
  'Sfl5c1TJSMeKKF2QT4fwpMeJf36POk6yJVadQssw6AB';

/** 32 символа трёх классов — то, как выглядит непрозрачный ключ вебхука. */
const opaqueSample = (): string => 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv';

/**
 * Присваивание тоже СОБИРАЕТСЯ, по той же причине, что и образцы выше: в
 * исходнике не должно быть подстроки `ИМЯ = значение` с секретным именем —
 * `scripts/no-secrets.test.ts` обязан считать её секретом и не обязан
 * догадываться, что это тестовые данные. На вход скрубберу при этом приходит
 * ровно та строка, ради которой образец и написан.
 */
const assignment = (name: string, value: string): string => [name, value].join(' = ');

describe('scrubSecretShapes', () => {
  it('removes a JWT and says what shape it was', () => {
    const body = `{{ REMNA_TOKEN = "${jwtSample()}" }}`;
    const { text, hits } = scrubSecretShapes(body);
    expect(text).toContain(JWT_MASK);
    expect(text).not.toContain(jwtSample());
    expect(hits).toEqual([{ shape: 'jwt', chars: jwtSample().length }]);
    // Имя переменной остаётся: «шаблон присваивает сюда токен панели» — это
    // логика, и ровно она отвечает на вопрос, почему шаблон делает что делает.
    expect(text).toContain('REMNA_TOKEN');
  });

  it('removes the value assigned to a secret-shaped name, keeping the name', () => {
    const line = ['export SUDO_PASSWORD="', opaqueSample(), '"'].join('');
    const { text, hits } = scrubSecretShapes(line);
    expect(text).toBe(`export SUDO_PASSWORD="${ASSIGNED_MASK}"`);
    expect(hits.map((hit) => hit.shape)).toEqual(['assigned_secret']);
  });

  it('removes a secret compared with == , not only one assigned with =', () => {
    // Настоящий `shm-all.tpl` сверяет `request.params.secret == '<значение>'`.
    // Значение там такое же настоящее, как при присваивании, а первая версия
    // правила смотрела только на `=` и пропускала его целиком.
    const line = ['IF request.params.secret == ', "'", opaqueSample(), "'", ';'].join('');
    const { text } = scrubSecretShapes(line);
    expect(text).not.toContain(opaqueSample());
    expect(text).toContain(ASSIGNED_MASK);
  });

  it('does not let a greedy value swallow the secret later in a query string', () => {
    // `port=443&secret=<hex>`: пока значение могло содержать `&` и `=`,
    // совпадало безобидное имя `port`, а до `secret` дело не доходило вовсе —
    // hex-ключ MTProxy уезжал наружу из публичной ссылки.
    const hex = 'dd77870ef8bdf3625b6eb083bc2f55877e';
    const line = `https://t.me/proxy?server=mt.example.test&port=8443&secret=${hex}`;
    const { text } = scrubSecretShapes(line);
    expect(text).not.toContain(hex);
    expect(text).toContain('port=8443');
  });

  it('reads a perl fat-comma header as an assignment, so the name still counts', () => {
    // `'X-Guard-Token' => '<значение>'` — настоящая форма из remnawave-webhook.tpl.
    const line = `'headers', { 'X-Guard-Token' => '${opaqueSample()}' },`;
    const { text, hits } = scrubSecretShapes(line);
    expect(text).not.toContain(opaqueSample());
    expect(hits.map((hit) => hit.shape)).toEqual(['assigned_secret']);
    expect(text).toContain('X-Guard-Token');
  });

  it('removes a long opaque run with no name to go by at all', () => {
    const line = `curl -H "X-Thing: ${opaqueSample()}" https://example.test/hook`;
    const { text, hits } = scrubSecretShapes(line);
    expect(text).not.toContain(opaqueSample());
    expect(text).toContain(OPAQUE_MASK);
    expect(hits.map((hit) => hit.shape)).toEqual(['opaque_run']);
    // Адрес, по которому шаблон ходит, остаётся — иначе вырезали бы логику.
    expect(text).toContain('https://example.test/hook');
  });

  /**
   * ПОЛОВИНА ЦЕННОСТИ ЭТОЙ ЧИСТКИ — В ТОМ, ЧЕГО ОНА НЕ ТРОГАЕТ. Инструмент
   * существует затем, чтобы модель ПРОЧИТАЛА логику шаблона; чистка, съевшая
   * адрес ручки или ссылку на условия, отвечает на вопрос «не утекло ли» ценой
   * вопроса, ради которого чтение и открывали. Все три образца ниже взяты из
   * настоящих шаблонов, и все три первая версия правила вырезала.
   */
  it.each([
    ['a URL path built in a shell string', '"$API_URL/shm/v1/storage/manage/vpn_mrzb_{{ us.id }}"'],
    ['a public telegra.ph slug', 'https://telegra.ph/Polzovatelskoe-soglashenie-08-12-61'],
    [
      'a reference to where the token comes from',
      `{{ ${assignment('TOKEN', 'config.telegram.telegram_bot.token')} }}`,
    ],
    ['a template name that merely reads long', assignment('PASSWORD_TEMPLATE', 'brevo_password_reset')],
    ['a snake_case identifier of 28 characters', 'remnawave_update_configs_all'],
  ])('leaves %s alone', (_name, line) => {
    expect(scrubSecretShapes(line)).toEqual({ text: line, hits: [] });
  });

  it('is idempotent — a second pass finds nothing left to remove', () => {
    const once = scrubSecretShapes(`{{ REMNA_TOKEN = "${jwtSample()}" }}`);
    expect(scrubSecretShapes(once.text)).toEqual({ text: once.text, hits: [] });
  });

  it('handles an empty body without pretending it found something', () => {
    expect(scrubSecretShapes('')).toEqual({ text: '', hits: [] });
  });
});

/**
 * ТРИ НАСТОЯЩИЕ УТЕЧКИ ОДНОГО КЛАССА, И НИ ОДНУ НЕ ЛОВИЛО НИ ОДНО ПРАВИЛО.
 *
 * Все три найдены в работающей установке: (1) токен бота лежал в
 * `response.request.url` строки спула, (2) он же — в колонке `host` части
 * серверов SHM
 * (`https://api.telegram.org/bot<ТОКЕН>/sendMessage`), (3) креденшлы — голыми
 * подстроками в телах шаблонов. Общего у всех трёх ровно одно: секрет был
 * ЗНАЧЕНИЕМ, а `redact` смотрит на ИМЯ поля. Чинили их по одной, у каждого
 * инструмента отдельно.
 *
 * Здесь описаны формы, которых не хватало. Правило про `bot<id>:<токен>` —
 * отдельное от общего непрозрачного прогона намеренно: в URL перед цифрами
 * стоит `bot`, границы слова между `t` и `1` нет, поэтому «голый» вариант
 * внутрь пути не попадает вовсе; а секретная часть настоящего токена берётся из
 * алфавита с `-`, который непрозрачный прогон разрывает — то есть примерно
 * два токена из пяти проезжали бы и через него.
 */
describe('scrubSecretShapes — a secret that is a value, not a field', () => {
  /** 35 символов после двоеточия — длина секретной части настоящего токена. */
  const telegramToken = (): string =>
    ['1088', '9977', '01:'].join('') + ['AAF', 'q7x2Kd0Lm9', 'Zt4Rv1Ns6Wb', '3Yc8Hj5Pg2Q'].join('');

  it('cuts a bot token out of an api path, where the field name promises nothing', () => {
    const url = `https://api.telegram.org/bot${telegramToken()}/sendMessage`;
    const { text, hits } = scrubSecretShapes(url);
    expect(text).not.toContain(telegramToken());
    expect(text).toBe(`https://api.telegram.org/${BOT_TOKEN_MASK}/sendMessage`);
    expect(hits.map((hit) => hit.shape)).toEqual(['bot_token']);
    // Хост остаётся: «этот сервер шлёт в Telegram» — логика, а не секрет.
    expect(text).toContain('api.telegram.org');
  });

  it('cuts a short bot token too, because the api path itself is the evidence', () => {
    // Форма `/bot<цифры>:` бывает только у Bot API. Порога длины здесь нет
    // намеренно: усечённый или тестовый токен в этой позиции — всё равно
    // токен, а ложным срабатыванием такая форма быть не может.
    const { text, hits } = scrubSecretShapes('https://api.telegram.org/bot1111111111:AAshort/sendMessage');
    expect(text).not.toContain('AAshort');
    expect(hits.map((hit) => hit.shape)).toEqual(['bot_token']);
  });

  it('cuts a bare bot token that no name and no path introduced', () => {
    const { text, hits } = scrubSecretShapes(`webhook target ${telegramToken()} is stale`);
    expect(text).toBe(`webhook target ${BOT_TOKEN_MASK} is stale`);
    expect(hits.map((hit) => hit.shape)).toEqual(['bot_token']);
  });

  it('cuts the password out of a url that carries credentials before the host', () => {
    const line = 'postgres://hq:Vd93kfLs02mQ@192.0.2.20:6767/shm';
    const { text, hits } = scrubSecretShapes(line);
    expect(text).toBe(`postgres://hq:${URL_CREDENTIALS_MASK}@192.0.2.20:6767/shm`);
    expect(hits.map((hit) => hit.shape)).toEqual(['url_credentials']);
    // Пользователь и хост остаются: без них строка перестаёт быть диагнозом.
    expect(text).toContain('hq');
    expect(text).toContain('192.0.2.20:6767');
  });

  /**
   * Обратная сторона, без которой правило выше — не правило, а рулетка.
   * Каждая строка ниже похожа на секрет ровно настолько, чтобы неаккуратная
   * форма её съела, и ни одна секретом не является.
   */
  it.each([
    ['a timestamp with colons', 'started 2026-08-13T12:24:35.000Z and finished'],
    ['an ssh tunnel spec', 'ssh -L 18099:192.0.2.10:8099 jump-host'],
    ['a vless link with no userinfo password', 'vless://2f0c4a1e-0000-4000-8000-000000000001@node.example.test:443'],
    ['a bare host and port', 'connect ETIMEDOUT 192.0.2.20:6767'],
    ['an id followed by a short slug', 'user 1088997701:ru is blocked'],
  ])('leaves %s alone', (_name, line) => {
    expect(scrubSecretShapes(line)).toEqual({ text: line, hits: [] });
  });
});

/**
 * ПОЧЕМУ У НЕПРОЗРАЧНОГО ПРОГОНА ЕСТЬ ВЫКЛЮЧАТЕЛЬ.
 *
 * Порог в 32 символа откалиброван на корпусе настоящих ШАБЛОНОВ — то есть на
 * тексте.
 * У структурированного ответа панели статистика другая: `svgLibrary` несёт
 * data-URI, `uniq_id` платежа — hex провайдера, и оба этот порог перешагивают.
 * Правило, вырезающее их, ломает ровно те инструменты, ради которых поля и
 * читают (этот проект уже дважды выкатывал такую потерю по ИМЕНИ поля).
 *
 * Поэтому текстовый блоб чистится полным набором, а сквозной проход по
 * значениям в `redact` — только теми формами, которые не бывают ложными.
 */
describe('scrubSecretShapes — the nameless opaque run is optional', () => {
  it('drops it by default, the way a template body needs', () => {
    const { hits } = scrubSecretShapes(`X-Thing: ${opaqueSample()}`);
    expect(hits.map((hit) => hit.shape)).toEqual(['opaque_run']);
  });

  it('keeps it when switched off, and still cuts the unmistakable shapes', () => {
    const line = `X-Thing: ${opaqueSample()} via ${jwtSample()}`;
    const { text, hits } = scrubSecretShapes(line, { opaqueRuns: false });
    expect(text).toContain(opaqueSample());
    expect(text).not.toContain(jwtSample());
    expect(hits.map((hit) => hit.shape)).toEqual(['jwt']);
  });
});

/**
 * ПИН ПРОТИВ РЕАЛЬНОСТИ, А НЕ ПРОТИВ ВЫДУМАННОЙ ФИКСТУРЫ.
 *
 * Образцы выше написаны мной и доказывают ровно то, что я предполагал.
 * Настоящий `hwid_blocker.tpl` — нет: он написан не под этот тест, лежит в
 * форке SHM рядом с этим репозиторием и несёт настоящий JWT панели прямо в теле.
 * Скопировать его сюда фикстурой нельзя — это и был бы тот самый утёкший
 * секрет, — поэтому файл ЧИТАЕТСЯ с диска.
 *
 * Отсутствие форка не роняет прогон (в CI его нет), но и не проходит молча
 * успехом: перед проверкой «после чистки JWT не осталось» тест требует, чтобы
 * ДО чистки он там БЫЛ. Пропуск же печатает, чего именно не проверили —
 * предохранитель, зеленеющий вхолостую, ровно так и умирает.
 */
const forkTemplate = (): string => {
  const fromEnv = process.env.HQ_MCP_SHM_FORK_TEMPLATES;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const base = fromEnv ?? resolve(repoRoot, '..', 'shm-fork-from-orig', 'tempaltes');
  return resolve(base, 'hwid_blocker.tpl');
};

describe('the scrubber against the real hwid_blocker.tpl', () => {
  const path = forkTemplate();
  const present = existsSync(path);

  it.runIf(present)('finds a JWT in the real body and leaves none behind', () => {
    const body = readFileSync(path, 'utf8');
    const jwt = new RegExp(JWT_RE.source, 'g');

    // Без этого утверждения тест зеленел бы и на пустом файле.
    const before = [...body.matchAll(jwt)];
    expect(before.length).toBeGreaterThan(0);

    const { text, hits } = scrubSecretShapes(body);
    expect([...text.matchAll(jwt)]).toEqual([]);
    expect(hits.filter((hit) => hit.shape === 'jwt')).toHaveLength(before.length);

    // Ни один сегмент вырезанного токена не остался лежать отдельно: у JWT их
    // три, и правило, снявшее только «средний», выглядело бы сработавшим.
    for (const segment of (before[0]?.[0] ?? '').split('.')) {
      expect(text).not.toContain(segment);
    }

    // И при этом файл остался ЧИТАЕМЫМ: имя переменной, которой присваивают
    // токен, на месте — иначе диагностировать по нему было бы нечего.
    expect(text).toContain('REMNA_TOKEN');
  });

  it('says out loud when the real-body check did not run', () => {
    if (!present) {
      // eslint-disable-next-line no-console
      console.warn(
        `[shapes.test] the SHM fork is not checked out at ${path}, so the scrubber was NOT ` +
          'pinned against a real template body in this run. Set HQ_MCP_SHM_FORK_TEMPLATES to ' +
          "the fork's tempaltes/ directory to enable it.",
      );
    }
    expect(typeof present).toBe('boolean');
  });
});
