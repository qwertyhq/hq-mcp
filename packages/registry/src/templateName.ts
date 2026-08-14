/**
 * ИМЯ ШАБЛОНА — ЭТО ПУТЬ НА ДИСКЕ БИЛЛИНГА, И ПРОВЕРЯТЬ ЕГО БОЛЬШЕ НЕКОМУ.
 *
 * `Core::Template::read_template_from_file` — это буквально
 * `sprintf("%s/%s.tpl", $dir, $id)` без единого санитайза
 * (app/lib/Core/Template.pm:324-334), а на записи `Core::Template::add` ещё и
 * зовёт `make_path(dirname($id))`, то есть создаёт каталоги по имени, которое
 * пришло снаружи. Имя с `../` читает — и в перспективе пишет — произвольный
 * `.tpl` где угодно, куда дотягивается процесс.
 *
 * Отказ живёт ЗДЕСЬ, а не в конкретном инструменте, по двум причинам сразу:
 *  - `assertNotForbidden` тут бессилен по построению: он смотрит на ПУТЬ
 *    запроса, а имя шаблона едет параметром (`?id=`) или полем тела и в путь
 *    не попадает вовсе;
 *  - потребителей у проверки двое (`template_read` читает, `template_edit`
 *    пишет), и вторая копия правила разъехалась бы молча — причём в худшую
 *    сторону, потому что расходятся такие копии всегда на стороне записи.
 *
 * Слэш в имени РАЗРЕШЁН намеренно: в проде живут `.DAV/hwid_blocker` и
 * `bak-deeplinks-20260812-1904/brevo_autopay_charge`. Запрещён шаг ВВЕРХ.
 */
export function assertSafeTemplateName(id: string): void {
  const bad =
    id.includes('..') ||
    id.startsWith('/') ||
    id.includes('\\') ||
    id.includes('\0') ||
    id.includes('\n');
  if (!bad) return;
  throw new Error(
    `Template name "${id}" is refused before it reaches SHM. The backend builds the file path ` +
      'by string interpolation and sanitises nothing (Core::Template::read_template_from_file), ' +
      'so a name containing ".." or a leading slash reads an arbitrary .tpl file from the ' +
      'billing host rather than a template. Names may contain "/" — real ones do, e.g. ' +
      '".DAV/hwid_blocker" — but never a parent-directory step.',
  );
}

/**
 * Каталоги-копии внутри `data/templates`. `.DAV` создаёт WebDAV-сервер при
 * правке шаблона через панель, `bak-*` — руками перед массовой заменой. В проде
 * таких копий 45 на 197 записей, они ОТЛИЧАЮТСЯ по содержимому от живых, и SHM
 * не исполняет ни одну: воркер разрешает имя без префикса.
 */
const BACKUP_PREFIX_RE = /^(?:\.DAV\/|bak[-_/])/i;

export type TemplateKind = 'live' | 'backup';

export function templateKind(id: string): TemplateKind {
  return BACKUP_PREFIX_RE.test(id) || id.includes('/bak-') ? 'backup' : 'live';
}
