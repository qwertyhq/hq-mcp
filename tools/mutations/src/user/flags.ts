import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import { defineMutation, planIdField } from '../kit.js';
import type { MutationDeps, MutationTool, PlanDraft } from '../kit.js';
import type { AuditTarget } from '@hq/audit';
import type { MutationPlan } from '@hq/confirm';
import type { ToolContext } from '@hq/types';

/** Поля карточки клиента, которые этот инструмент писать умеет. */
export const ALLOWED_USER_FIELDS = ['block', 'full_name', 'phone', 'comment'] as const;

/**
 * Поля, которые `POST /admin/user` под админом писать УМЕЕТ, а мы не даём.
 *
 * Умеет он их потому, что `Core::Base::api` фильтрует аргументы через
 * `api_safe_args` только когда флага `admin` нет (Base.pm:417-425), а диспетчер
 * ставит `admin => 1` любому запросу к `/admin/*` (v1.cgi:1670-1683). То есть
 * на этом маршруте нет ни одного поля структуры, которое было бы защищено
 * бэкендом. Единственный whitelist, который существует, — этот.
 */
export const FORBIDDEN_USER_FIELDS = ['gid', 'balance', 'bonus', 'password', 'partner_id'] as const;

const FORBIDDEN_HINTS: Record<string, string> = {
  gid: 'gid 0→1 выдаёт админские права в SHM (структура User, enum [0,1]) — это не «поле ' +
    'карточки», а выдача доступа ко всей админке. Только руками.',
  balance:
    'правка баланса напрямую разводит users.balance с историей платежей: для денег есть ' +
    'billing_adjust, у которого свой журнал и свой потолок суммы',
  bonus:
    'правка бонусов напрямую не оставляет следа в истории начислений: для бонусов есть ' +
    'billing_adjust',
  password: 'смена пароля клиента через MCP — механизм захвата аккаунта, а не операция поддержки',
  partner_id: 'подмена реферала переписывает партнёрские начисления задним числом',
};

type FieldProblem = string | undefined;

const FIELD_VALIDATORS: Record<string, (value: unknown) => FieldProblem> = {
  block: (value) =>
    value === 0 || value === 1
      ? undefined
      : 'block принимает только 0 или 1 (структура User, enum [0,1]); 0 — активен, 1 — заблокирован',
  full_name: (value) =>
    typeof value === 'string' && value.length <= 200
      ? undefined
      : 'full_name — строка до 200 символов',
  phone: (value) =>
    typeof value === 'string' && value.length <= 40 ? undefined : 'phone — строка до 40 символов',
  comment: (value) =>
    typeof value === 'string' && value.length <= 1000
      ? undefined
      : 'comment — строка до 1000 символов',
};

/**
 * `record`, а не `z.object`. Через `executeTool` вход всегда проходит
 * `def.input.parse`, и у `z.object` в strip-режиме ключи `gid` и `balance`
 * исчезли бы ДО хендлера: пользователь получил бы «не передано ни одного поля»,
 * а объяснение, почему gid запрещён, не прозвучало бы никогда. Whitelist,
 * проверка типов и объяснения живут в хендлере — там, где их видно.
 */
const input = z.object({
  user_id: z.number().int().positive(),
  fields: z
    .record(z.string(), z.unknown())
    .describe(
      'Разрешены только block (0|1), full_name, phone, comment. Любое другое поле будет ' +
        'отклонено с объяснением: POST /admin/user под админом пишет что угодно, включая gid и ' +
        'balance, и защиты на стороне SHM у этого маршрута нет.',
    ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

interface ShmUserRow {
  user_id?: unknown;
  block?: unknown;
  full_name?: unknown;
  phone?: unknown;
  comment?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Нормализованный снимок ровно тех полей, которые инструмент вправе трогать. */
function snapshotOf(row: ShmUserRow): Record<string, unknown> {
  return {
    block: num(row.block) ?? 0,
    full_name: text(row.full_name),
    phone: text(row.phone),
    comment: text(row.comment),
  };
}

/**
 * ЧТЕНИЕ ИДЁТ ЧЕРЕЗ `getRaw`, И ЭТО НЕ ОПТИМИЗАЦИЯ.
 *
 * Из этого снимка строится `rollback`: тело, которым операцию откатывают.
 * Обычный `get`/`list` прогоняет ответ через `redact`, и поле, попавшее под
 * маскирование по форме значения, вернулось бы в SHM строкой '<redacted>' —
 * то есть откат уничтожил бы данные клиента вместо восстановления. Результат
 * `getRaw` наружу не уходит: в ответ инструмента едет `plan.before`, который
 * `executeTool` маскирует уже на выходе.
 *
 * Клиент, у которого block=1, читается здесь нормально: `User::_list`
 * дописывает `block => 0` только когда в условии нет ключа таблицы
 * (User.pm:1205-1217), а `user_id` админский вызов кладёт в where
 * (Sql/Data.pm:749-751).
 */
async function readUser(ctx: ToolContext, userId: number): Promise<ShmUserRow> {
  const raw = await ctx.shm.getRaw<unknown>('/admin/user', { user_id: userId, limit: 1 });
  const rows = Array.isArray(raw) ? raw : [raw];
  const row = rows[0];
  if (row === undefined || row === null) {
    throw new Error(`user_flags: клиент user_id=${userId} не найден в SHM`);
  }
  return asRecord(row) as ShmUserRow;
}

async function readWorld(plan: MutationPlan, ctx: ToolContext): Promise<Record<string, unknown>> {
  const before = asRecord(plan.before);
  const userId = num(before.user_id) ?? 0;
  return snapshotOf(await readUser(ctx, userId));
}

/**
 * ЧТО БЛОКИРОВКА НА САМОМ ДЕЛЕ ДЕЛАЕТ — И ЧЕГО ОНА НЕ ДЕЛАЕТ.
 *
 * `Core::User::set` при `block` истинном выполняет РОВНО одно действие:
 * `sessions->delete_user_sessions` (User.pm:884-892). Ни задачи в спуле, ни
 * события, ни касания услуг, ни обращения к панели. Услуги остаются ACTIVE,
 * биллинг продолжает списывать, а учётка в Remnawave продолжает раздавать VPN.
 *
 * Это и есть находка `blockedButActiveInPanel` из `sync_audit`: «клиент
 * заблокирован, а VPN работает». Инструмент обязан сказать это вслух, иначе
 * оператор уходит в уверенности, что доступ закрыт.
 */
function blockSideEffects(activeServices: Array<{ id: number; name: string | null }>): string[] {
  const list =
    activeServices.length === 0
      ? 'Действующих услуг у клиента сейчас нет.'
      : `У клиента ${activeServices.length} действующих услуг: ` +
        activeServices.map((one) => `${one.id} (${one.name ?? 'без имени'})`).join(', ') +
        '. Они продолжат работать и продолжат списывать деньги.';
  return [
    'БЛОКИРОВКА НЕ ОТКЛЮЧАЕТ ДОСТУП. Core::User::set при block=1 делает ровно одно: убивает ' +
      'веб-сессии клиента (User.pm:884-892). Ни задачи провижининга, ни события, ни изменения ' +
      'услуг, ни обращения к Remnawave она не порождает — учётка в панели продолжает раздавать ' +
      'VPN. Это ровно то расхождение, которое sync_audit показывает как blockedButActiveInPanel.',
    list,
    'Чтобы доступ действительно закрылся, нужно отдельно: service_lifecycle action=stop на ' +
      'каждую активную услугу (он идёт через block_force и порождает задачу провижининга), а ' +
      'при срочности — проверить учётку клиента в панели вручную. Одного user_flags для этого ' +
      'мало.',
    'Заблокированный клиент пропадёт из обычного поиска и списков: User::_list дописывает в ' +
      'условие block=0, когда в нём нет user_id (User.pm:1205-1217). Дальше искать его только ' +
      'точечно по user_id.',
  ];
}

export function userFlags(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: 'user_flags',
      description:
        'Блокировка клиента и правка безопасных полей карточки SHM: block, full_name, phone, ' +
        'comment. gid, balance, bonus, password и partner_id запрещены. Блокировка убивает только ' +
        'веб-сессии: услуги и учётка в панели продолжают работать, и инструмент говорит, что ещё ' +
        'нужно сделать. Без plan_id возвращает план и не меняет ничего.',
      input,
      risk: 'high',
      // К21: боту не отдаётся. `POST /admin/user` под админом — неограниченный
      // UPDATE, whitelist держит наш код, а не бэкенд, поэтому писатель здесь
      // только человек.
      profiles: ['human'],
      endpoints: ['GET /admin/user', 'GET /admin/user/service', 'POST /admin/user'],
      target: (i): AuditTarget => ({ system: 'shm', id: i.user_id }),
      guard: { keys: [...ALLOWED_USER_FIELDS], read: readWorld },

      plan: async (i, ctx): Promise<PlanDraft> => {
        const incoming = asRecord(i.fields);
        const keys = Object.keys(incoming).filter((key) => incoming[key] !== undefined);

        for (const key of keys) {
          if ((FORBIDDEN_USER_FIELDS as readonly string[]).includes(key)) {
            throw new Error(
              `user_flags: поле ${key} запрещено. ${FORBIDDEN_HINTS[key] ?? 'опасное поле'}`,
            );
          }
          if (!(ALLOWED_USER_FIELDS as readonly string[]).includes(key)) {
            throw new Error(
              `user_flags: поле ${key} вне whitelist. Разрешены: ${ALLOWED_USER_FIELDS.join(', ')}. ` +
                'Список держится здесь, а не в SHM: на админском маршруте бэкенд не фильтрует ' +
                'ничего.',
            );
          }
          const problem = FIELD_VALIDATORS[key]?.(incoming[key]);
          if (problem !== undefined) throw new Error(`user_flags: ${problem}`);
        }
        if (keys.length === 0) {
          throw new Error('user_flags: не передано ни одного поля для изменения');
        }

        const row = await readUser(ctx, i.user_id);
        const snapshot = snapshotOf(row);

        const beforeSubset: Record<string, unknown> = {};
        const afterSubset: Record<string, unknown> = {};
        for (const key of keys) {
          beforeSubset[key] = snapshot[key] ?? null;
          afterSubset[key] = incoming[key];
        }

        const unchanged = keys.filter(
          (key) => JSON.stringify(beforeSubset[key] ?? null) === JSON.stringify(afterSubset[key] ?? null),
        );
        if (unchanged.length === keys.length) {
          const blocking = keys.includes('block');
          throw new Error(
            blocking && snapshot.block === 1
              ? `user_flags: клиент user_id=${i.user_id} уже заблокирован (block=1) — план ничего ` +
                'не меняет. Если доступ всё ещё работает, дело не в этом флаге: блокировка не ' +
                'трогает ни услуги, ни панель. Смотрите service_lifecycle action=stop.'
              : `user_flags: поля уже имеют эти значения (${unchanged.join(', ')}) — план ничего ` +
                'не меняет.',
          );
        }

        const sideEffects = [
          'POST /admin/user под админом — неограниченный UPDATE: api_safe_args не применяется, ' +
            'потому что диспетчер ставит admin=1 всему /admin/* (v1.cgi:1670-1683, ' +
            'Base.pm:417-425). Отправлено будет ровно то, что перечислено в diff, и ничего сверх.',
        ];
        if (incoming.block === 1) {
          let active: Array<{ id: number; name: string | null }> = [];
          try {
            const page = await ctx.shm.list<Record<string, unknown>>('/admin/user/service', {
              user_id: i.user_id,
              limit: 200,
            });
            active = page.data
              .filter((one) => asRecord(one).status === 'ACTIVE')
              .map((one) => ({
                id: num(asRecord(one).user_service_id) ?? 0,
                name: text(asRecord(one).name),
              }));
          } catch {
            // Список услуг — справка для оператора, а не условие операции.
            // Молчаливый провал здесь честнее отказа: блокировка от него не
            // становится опаснее, а вот отказ на живой блокировке — мешает.
          }
          sideEffects.push(...blockSideEffects(active));
        }
        if (incoming.block === 0) {
          sideEffects.push(
            'Разблокировка вернёт клиента в списки и поиск. Сессии она не восстанавливает — ' +
              'клиенту нужно войти заново. Услуги разблокировка тоже не трогает: если они были ' +
              'остановлены, поднимать их отдельно через service_lifecycle action=activate.',
          );
        }

        return {
          before: { user_id: i.user_id, ...snapshot },
          after: { user_id: i.user_id, ...afterSubset },
          diff: buildDiff(beforeSubset, afterSubset, ctx.profile),
          sideEffects,
          rollback: {
            method: 'POST',
            path: '/admin/user',
            body: { user_id: i.user_id, ...beforeSubset },
          },
        };
      },

      apply: async (plan, ctx) => {
        // Ровно `plan.after`: тело собрано из аргументов вызова, а не из
        // прочитанной строки, поэтому read-merge-write здесь не происходит и
        // маскированное значение в SHM уехать не может.
        const body = asRecord(plan.after);
        const user = await ctx.shm.action<unknown>('POST', '/admin/user', body);
        return { user };
      },
    },
    deps,
  );
}
