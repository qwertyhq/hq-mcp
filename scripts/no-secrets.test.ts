import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALL_PLACEHOLDER_SEGMENTS_RE,
  ASSIGNED_SECRET_RE,
  JWT_RE,
  PLACEHOLDER_RE,
  REGEX_LITERAL_RE,
} from '@hq/redact';

/**
 * Предохранитель против того, что чинить поздно: секрет, уехавший в публичную
 * историю, отзывается ротацией, а не коммитом. Одноразовая проверка «сейчас
 * чисто» этого не даёт — она была чистой и в тот момент, когда в соседнем
 * репозитории настоящие токены пролежали в .env.example.
 *
 * Ищет ФОРМЫ, а не конкретные значения: настоящий токен в тест не вписать, не
 * опубликовав его этим же тестом.
 */

const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((path) => path !== '' && !path.startsWith('docs/'));

/**
 * ФОРМЫ ЖИВУТ В `@hq/redact/shapes`, А НЕ ЗДЕСЬ. Раньше они были объявлены в
 * этом файле, и это было терпимо ровно до тех пор, пока секрет искали ТОЛЬКО в
 * трекаемых файлах. Как только тем же вопросом («как выглядит секрет») занялся
 * рантайм — `template_read` чистит тело шаблона, где креденшл лежит голой
 * подстрокой, — копия стала бы вторым источником истины: правило, поправленное
 * в одном месте, молча продолжало бы пропускать в другом. Поэтому определения
 * общие, а этот файл — один из двух их потребителей.
 */

/**
 * ОДНА СТРОКА ГЛАЗАМИ ПРАВИЛА. Вынесена из прогона по файлам не ради красоты:
 * прогон зеленеет в двух случаях — секретов в репозитории действительно нет ИЛИ
 * правило перестало срабатывать, — и различить их изнутри прогона нечем.
 * Отдельная функция даёт вторую половину проверки («правило ещё ловит», ниже),
 * причём на ТОМ ЖЕ коде, а не на его похожей копии.
 */
const FIXED_PROTECTED_FILE_ASSIGNMENTS = new Set(
  [
    ['SHM_ADMIN_AUTH_FILE', '/run/secrets/shm_admin_auth'],
    ['REMNA_API_TOKEN_FILE', '/run/secrets/remna_api_token'],
    ['HQ_MCP_HTTP_TOKENS_FILE', '/run/secrets/http_tokens'],
  ].map(([name, path]) => `${name}=${path}`),
);

function isOnlyFixedProtectedFileAssignment(line: string): boolean {
  const assignment = line
    .trim()
    .replace(/^-e\s+/, '')
    .replace(/\s*\\$/, '')
    .trim();
  return FIXED_PROTECTED_FILE_ASSIGNMENTS.has(assignment);
}

function assignsRealLookingSecret(line: string): boolean {
  // Строки комментариев пропускаются: комментарий ничего не присваивает,
  // а объяснить правило нельзя, не процитировав его — этот тест поймал
  // на этом сам себя, ровно как сканер запрещённых путей ловил
  // доккомментарии до правки dc3e3ce. Проверка на JWT комментарии НЕ
  // пропускает: там ищется значение, а не форма присваивания, и
  // вставленный в комментарий настоящий токен обязан краснеть.
  const bare = line.trim();
  if (bare.startsWith('*') || bare.startsWith('//') || bare.startsWith('#')) return false;
  const hit = ASSIGNED_SECRET_RE.exec(line);
  if (hit === null) return false;
  // Эти три значения — не креды, а фиксированные пути к защищённым bind
  // mounts production-контейнера. Исключение намеренно требует, чтобы ВСЯ
  // строка (кроме shell `-e` и завершающего `\`) была одним точным
  // NAME=/run/secrets/basename: произвольный *_FILE, другой путь или второе
  // присваивание остаются обычным срабатыванием правила.
  if (isOnlyFixedProtectedFileAssignment(line)) return false;
  // Хвостовая пунктуация языка — не часть значения: без этого
  // `SECRET_KEY_RE = /…/i;` не опознаётся как литерал регулярки.
  const value = (hit[1] ?? '').replace(/[;,)]+$/, '');
  return !(
    PLACEHOLDER_RE.test(value) ||
    REGEX_LITERAL_RE.test(value) ||
    ALL_PLACEHOLDER_SEGMENTS_RE.test(value)
  );
}

/**
 * АДРЕС — НЕ СЕКРЕТ, И ИМЕННО ПОЭТОМУ ЕГО НИКТО НЕ ЛОВИЛ. Правила выше ищут то,
 * что даёт доступ: JWT, присваивание значения имени вроде `*_TOKEN`. Адрес
 * доступа не даёт — он говорит, ЧЬЯ это установка и где она стоит. Перед первой
 * публикацией в трекаемых фикстурах нашлись адрес внутренней подсети вместе со
 * строкой подключения к Postgres и mesh-адреса; оба прогона выше были при этом
 * зелёными, потому что искали не то.
 *
 * Ловятся ТОЛЬКО зарезервированные под частные сети диапазоны (RFC 1918) и
 * CGNAT/mesh (RFC 6598, 100.64/10) — их в публичном репозитории быть не может
 * по определению. Петля (`127.0.0.1`) и `0.0.0.0` разрешены: это законные
 * умолчания, на них сервер слушает. Диапазоны для документации (RFC 5737:
 * 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) правилом не задеваются — они и
 * есть правильная замена, когда фикстуре нужен похожий на настоящий адрес.
 *
 * Четыре октета обязательны, поэтому версии вида `pnpm@10.15.0` не задеваются.
 */
const PRIVATE_ADDRESS_RE =
  /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/;

function carriesPrivateAddress(line: string): boolean {
  return PRIVATE_ADDRESS_RE.test(line);
}

describe('no secrets reach a published commit', () => {
  it('.env is not tracked', () => {
    const files = tracked();
    expect(files).not.toContain('.env');
    expect(files.filter((f) => f.startsWith('.env') && f !== '.env.example')).toEqual([]);
  });

  it('no tracked file carries a JWT', () => {
    const offenders = tracked().filter((file) => JWT_RE.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no tracked file assigns a real-looking value to a secret-shaped name', () => {
    const offenders: string[] = [];
    for (const file of tracked()) {
      for (const [lineNo, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (assignsRealLookingSecret(line)) offenders.push(`${file}:${String(lineNo + 1)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no tracked file carries a private or mesh address', () => {
    const offenders: string[] = [];
    for (const file of tracked()) {
      for (const [lineNo, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (carriesPrivateAddress(line)) offenders.push(`${file}:${String(lineNo + 1)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('actually reads files — a broken path would pass vacuously', () => {
    expect(tracked().length).toBeGreaterThan(30);
  });
});

/**
 * ЗУБЫ ПРЕДОХРАНИТЕЛЯ, ПРОВЕРЯЕМЫЕ ОТДЕЛЬНО ОТ ЕГО ЗЕЛЕНИ.
 *
 * Прогон выше зелен и тогда, когда правило перестало ловить, — а страж,
 * потерявший зубы, хуже красного: он успокаивает. Поэтому те же формы, что
 * встречались в этом хозяйстве на практике, прогоняются через ТУ ЖЕ функцию явно.
 * Любая будущая правка, сделанная ради зелени, обязана сначала сломать это.
 *
 * Образцы СОБИРАЮТСЯ из кусков: файл трекается и попадает под собственный
 * прогон, а написанная целиком форма секрета покраснела бы на самой себе.
 * Комментарием тут не отделаться — JWT ищется и в комментариях, намеренно.
 */
describe('the rule still catches what it was written for', () => {
  const jwtSample = (): string =>
    [
      ['eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'].join(''),
      ['eyJ', 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ'].join(''),
      'Sfl5c1TJSMeKKF2QT4fwpMeJf36POk6yJVadQssw6AB',
    ].join('.');
  /** 32 символа трёх классов — то, как выглядит непрозрачный ключ вебхука. */
  const opaqueSample = (): string => 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv';
  const assign = (name: string, value: string, gap = '='): string => `${name}${gap}${value}`;

  it.each([
    ['a JWT handed to an env-style name', assign('REMNA_API_TOKEN', jwtSample())],
    ['an opaque 32-char key', assign('X_GUARD_TOKEN', opaqueSample())],
    [
      'a bot token',
      assign('TELEGRAM_TOKEN', ['7331234567', 'AAF9kZq2xWvBn4TcMdLpQr8sYh3JgEuVwXy'].join(':')),
    ],
    // НАРОЧНО СТРОЖЕ РАНТАЙМ-ЧИСТКИ. Там значение обязано ещё и выглядеть
    // непрозрачным (`looksOpaque` в @hq/redact), потому что ложное срабатывание
    // вырезает из ответа модели логику. Здесь цена ошибки обратная — пропущенный
    // секрет уезжает в публичную историю и отзывается ротацией, — поэтому
    // человеческий пароль, у которого никакой «формы» нет, обязан краснеть.
    ['a human passphrase with no opaque shape', assign('SHM_ADMIN_PASSWORD', 'correcthorsebattery')],
    // json/yaml: имя закавычено вместе со значением. Раньше эта форма
    // проезжала — правило требовало `[:=]` вплотную к имени.
    ['a quoted json field', assign('"API_KEY"', `"${opaqueSample()}"`, ': ')],
  ])('flags %s', (_name, line) => {
    expect(assignsRealLookingSecret(line)).toBe(true);
  });

  /** Обратная половина: без неё «ловит всё» сошло бы за «ловит нужное». */
  it.each([
    ['an angle-bracket placeholder', assign('HQ_MCP_HTTP_TOKENS', '<label>:<token>')],
    ['a shell substitution', assign('REMNA_API_TOKEN', '${REMNA_API_TOKEN}')],
    ['an example value', assign('TEST_TOKEN', 'example-token-0123456789abcdef')],
    [
      'a regex literal that merely defines the rule',
      assign('SECRET_KEY_RE', '/token|secret|key|password|auth/i;', ' = '),
    ],
  ])('leaves %s alone', (_name, line) => {
    expect(assignsRealLookingSecret(line)).toBe(false);
  });

  it.each([
    ['SHM_ADMIN_AUTH_FILE', '/run/secrets/shm_admin_auth'],
    ['REMNA_API_TOKEN_FILE', '/run/secrets/remna_api_token'],
    ['HQ_MCP_HTTP_TOKENS_FILE', '/run/secrets/http_tokens'],
  ])('allows the fixed protected file reference %s', (name, path) => {
    expect(assignsRealLookingSecret(assign(name, path))).toBe(false);
  });

  it('still flags a secret-shaped file variable pointed outside its fixed protected path', () => {
    expect(assignsRealLookingSecret(assign('REMNA_API_TOKEN_FILE', '/tmp/operator-token-file'))).toBe(
      true,
    );
  });

  it('still flags a second opaque assignment after an allowed protected file reference', () => {
    const line = [
      assign('REMNA_API_TOKEN_FILE', '/run/secrets/remna_api_token'),
      assign('REMNA_API_TOKEN', 'opaque-secret-value'),
    ].join(' ');
    expect(assignsRealLookingSecret(line)).toBe(true);
  });

  it('the JWT rule deliberately does NOT skip comments', () => {
    // Закомментированный настоящий токен остаётся настоящим токеном. Правило
    // присваивания комментарии пропускает — объяснить его нельзя, не
    // процитировав; правило JWT не пропускает. Это два разных решения, и
    // разъехаться они не имеют права молча.
    expect(JWT_RE.test(`// ${assign('REMNA_API_TOKEN', jwtSample())}`)).toBe(true);
    expect(assignsRealLookingSecret(`// ${assign('REMNA_API_TOKEN', opaqueSample())}`)).toBe(false);
  });

  /**
   * Октеты СОБИРАЮТСЯ, а не пишутся целиком: файл трекается и попадает под
   * собственный прогон, а записанный литералом приватный адрес покраснел бы
   * на самом себе — ровно так же, как форма секрета выше.
   */
  const addr = (...octets: readonly (string | number)[]): string => octets.join('.');

  it.each([
    ['the subnet that actually leaked', `connect ETIMEDOUT ${addr(10, 10, 10, 20)}:6767`],
    ['it inside a connection string', `postgres://hq:pw@${addr(10, 0, 0, 5)}:5432/shm`],
    ['a home-router range', `proxy ${addr(192, 168, 1, 1)}`],
    ['the RFC 1918 middle block', `host ${addr(172, 20, 3, 4)}`],
    ['a mesh address', `peer ${addr(100, 118, 56, 82)}`],
  ])('catches %s', (_name, line) => {
    expect(carriesPrivateAddress(line)).toBe(true);
  });

  it.each([
    ['loopback, on which the server legitimately listens', `url=http://${addr(127, 0, 0, 1)}:42799`],
    ['the bind-anything address', `host ${addr(0, 0, 0, 0)}`],
    ['the documentation range that replaces a real one', `host ${addr(192, 0, 2, 20)}`],
    ['a three-octet version number', 'pnpm@10.15.0 (corepack)'],
    ['a public address', `resolved ${addr(8, 8, 8, 8)}`],
  ])('leaves %s alone', (_name, line) => {
    expect(carriesPrivateAddress(line)).toBe(false);
  });
});
