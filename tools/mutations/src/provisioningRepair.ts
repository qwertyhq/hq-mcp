import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import type { ToolContext } from '@hq/types';
import { defineMutation, planIdField } from './kit.js';
import type { MutationDeps, MutationTool, PlanGuard } from './kit.js';

/**
 * ПОЧЕМУ НАБОР ДЕЙСТВИЙ ЗАКРЫТ И ПОЧЕМУ ПУТЬ НЕ СОБИРАЕТСЯ ИЗ ПЕРЕМЕННОЙ.
 *
 * `Core::Spool::api_manual_action` (app/lib/Core/Spool.pm:323-338) собирает имя
 * метода из сегмента URL — `sprintf("api_%s", $args{action})` — и вызывает его,
 * если `$self->can($method)` истинно. `can` видит и унаследованное от
 * `Core::Base`: `api_set` (Base.pm:388) и `api_add` (Base.pm:399, плюс свой в
 * Spool.pm:78). То есть POST на `…/manual/set` — это произвольная запись в
 * строку спула, включая её `status`, мимо запрета, который стоит на пометке
 * задачи успешной. Маршрут `'/admin/spool/manual/*'` со `splat_to => 'action'`
 * (app/public_html/shm/v1.cgi:1020-1029) не ограничивает сегмент ничем.
 *
 * Отсюда два правила, которые нельзя ослабить:
 *  1. действие приходит из закрытого `z.enum`, и никогда — свободной строкой;
 *  2. путь берётся из таблицы ЦЕЛЫМИ литералами, а не склеивается из
 *     `/admin/spool/manual/` и значения переменной. Склейка была бы хуже, чем
 *     некрасива: `scanForbiddenLiterals` (@hq/registry) ищет в исходниках
 *     СТРОКОВЫЕ ЛИТЕРАЛЫ и шаблонные строки с подстановкой пропускает вовсе.
 *     Путь, собранный из переменной, не нарушил бы скан — он стал бы ему
 *     невидим, а это ровно противоположное тому, ради чего скан существует.
 *
 * `success` в наборе НЕТ и не будет. Такая пометка не выполняет задачу: она
 * штампует SUCCESS и двигает статус услуги через `set_status_by_event`
 * (Spool.pm:340-357) — услуга становится ACTIVE в биллинге, а пользователя в
 * панели нет. Это ровно та авария, которую ищет provisioning_diagnose.
 */
const ACTIONS = ['retry', 'resume', 'pause'] as const;

const actionEnum = z.enum(ACTIONS);

type Action = z.infer<typeof actionEnum>;

/** Литерал на действие. См. большой комментарий выше — склейки здесь не будет. */
const ACTION_PATH: Readonly<Record<Action, string>> = {
  retry: '/admin/spool/manual/retry',
  resume: '/admin/spool/manual/resume',
  pause: '/admin/spool/manual/pause',
};

/**
 * Что именно правит каждое действие в строке спула.
 *
 * `resume` и `retry` — ОДНА И ТА ЖЕ операция, а не две похожие:
 * `*api_resume = \&api_retry` (Spool.pm:370), и обе ставят
 * `status => TASK_NEW, delayed => 0` (Spool.pm:372-380). Разными их делает
 * только имя в URL. `api_pause` (Spool.pm:361) трогает единственное поле —
 * `status => TASK_PAUSED`, задержку не сбрасывает.
 */
const ACTION_EFFECT: Readonly<Record<Action, { status: string; resetsDelay: boolean }>> = {
  retry: { status: 'NEW', resetsDelay: true },
  resume: { status: 'NEW', resetsDelay: true },
  pause: { status: 'PAUSED', resetsDelay: false },
};

const input = z.object({
  task_id: z
    .number()
    .int()
    .positive()
    .describe('id задачи спула — тот, что показывают spool_inspect и provisioning_diagnose'),
  action: actionEnum.describe(
    'retry — поставить задачу в очередь заново и снять задержку; resume — то же самое ' +
      'действие под другим именем (в SHM это буквально один и тот же обработчик); ' +
      'pause — остановить задачу, воркер её больше не возьмёт. Пометки задачи успешной в ' +
      'наборе нет намеренно: она не выполняет работу.',
  ),
  ...planIdField,
});

type Input = z.infer<typeof input>;

/** Ровно то, что применяется, — и единственное, что читается из плана на диске. */
const opSchema = z.object({
  action: actionEnum,
  task_id: z.number().int().positive(),
});

export interface SpoolTask {
  id: number;
  user_id: number | null;
  user_service_id: number | null;
  status: string | null;
  prio: number | null;
  delayed: number | null;
  created: string | null;
  executed: string | null;
  event: unknown;
  response: unknown;
}

/** Сколько задач очереди готовы просмотреть постранично, если фильтр не сработал. */
export const SPOOL_SCAN_LIMIT = 500;

const SPOOL_PAGE = 100;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * `settings` приезжает из SHM то объектом, то JSON-строкой — зависит от того,
 * через какой слой прошла строка. Разбор в одном месте, чтобы план и сверка
 * мира читали поле ОДИНАКОВО: иначе guard сравнивал бы 55 с null и отвергал
 * каждый второй план как «мир уехал».
 */
function settingsOf(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.settings;
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return asRecord(raw);
}

/**
 * id услуги у провижининговой задачи лежит в `settings`, а не в одноимённой
 * колонке: `USObject.pm:463` кладёт его именно туда, а сама колонка в ответе
 * приходит `null` (проверено на работающей SHM, а не по спецификации). Читать
 * одну колонку значило бы печатать «услуга неизвестна» на каждой задаче, ради
 * которой этот инструмент и существует.
 */
function spoolServiceId(row: Record<string, unknown>): number | null {
  return numOrNull(row.user_service_id) ?? numOrNull(settingsOf(row).user_service_id);
}

function toSpoolTask(row: Record<string, unknown>): SpoolTask {
  return {
    id: numOrNull(row.id) ?? 0,
    user_id: numOrNull(row.user_id),
    user_service_id: spoolServiceId(row),
    status: strOrNull(row.status),
    prio: numOrNull(row.prio),
    delayed: numOrNull(row.delayed),
    created: strOrNull(row.created),
    executed: strOrNull(row.executed),
    event: row.event ?? null,
    // Ради «почему задача упала»: у провалившейся задачи здесь лежит ответ
    // бэкенда. Канал редактируемый, так что секреты внутри уже замаскированы.
    response: row.response ?? null,
  };
}

function notFound(taskId: number, why: string): Error {
  return new Error(
    `provisioning_repair: задача спула id=${taskId} не найдена (${why}). Возьмите актуальный id ` +
      'из spool_inspect или provisioning_diagnose: очередь могла уехать, а применять действие к ' +
      'соседней задаче нельзя.',
  );
}

/**
 * Поиск задачи по id.
 *
 * Фильтр `?id=` РАБОТАЕТ: `Sql::Data::list_for_api` подставляет в WHERE
 * значение параметра, названного ключом таблицы (Data.pm), а ключ таблицы
 * `spool` — это `id` (Spool.pm:16-20, `key => 1`). Проверено на работающей SHM
 * 2.19.4, а не по спецификации: `?id=<существующий>` вернул `items:1` и ровно
 * эту задачу, `?id=<несуществующий>` — `items:0`.
 *
 * Результат всё равно СВЕРЯЕТСЯ, а не принимается на веру, и на этом держится
 * различение двух исходов, которые снаружи выглядят одинаково:
 *  - пришёл пустой список  → фильтр сработал, задачи нет;
 *  - пришли ЧУЖИЕ задачи   → фильтр проигнорирован этой версией SHM, и слепое
 *    `data[0]` означало бы retry/pause чужой задачи. Тогда идём постранично.
 */
export async function findSpoolTask(ctx: ToolContext, taskId: number): Promise<SpoolTask> {
  const filtered = await ctx.shm.list<Record<string, unknown>>('/admin/spool', {
    id: taskId,
    limit: SPOOL_PAGE,
  });
  const direct = filtered.data.find((row) => numOrNull(row.id) === taskId);
  if (direct !== undefined) return toSpoolTask(direct);
  if (filtered.data.length === 0) {
    throw notFound(taskId, 'фильтр по id отработал и не нашёл ничего');
  }

  for (let offset = 0; offset < SPOOL_SCAN_LIMIT; offset += SPOOL_PAGE) {
    const page = await ctx.shm.list<Record<string, unknown>>('/admin/spool', {
      limit: SPOOL_PAGE,
      offset,
    });
    const found = page.data.find((row) => numOrNull(row.id) === taskId);
    if (found !== undefined) return toSpoolTask(found);
    if (page.data.length === 0 || offset + page.data.length >= page.items) break;
  }

  throw notFound(
    taskId,
    `фильтр по id эта версия SHM проигнорировала, просмотрено до ${SPOOL_SCAN_LIMIT} задач очереди`,
  );
}

/**
 * Сверка мира перед применением (§7.4).
 *
 * `status` — единственное, что решает, осталось ли действие тем же действием:
 * retry по задаче, которая за десять минут жизни плана успела выполниться, и
 * retry по застрявшей — разные операции, и вторую оператор подтверждал, а
 * первую нет. `user_service_id` держит вторую половину ответа: задача обязана
 * остаться задачей той же услуги.
 *
 * `delayed` в ключи НЕ входит намеренно. Воркер умножает задержку сам на каждом
 * провале (`finish_task`, Spool.pm:300-320), то есть у активно падающей задачи
 * это поле движется без чьего-либо участия — сверка по нему отвергала бы ровно
 * те планы, ради которых инструмент написан, и называла бы это «мир уехал».
 */
const guard: PlanGuard = {
  keys: ['status', 'user_service_id'],
  read: async (plan, ctx) => {
    const taskId = numOrNull(asRecord(plan.before).id);
    if (taskId === null || taskId <= 0) {
      throw new Error(
        'provisioning_repair: в снимке плана нет id задачи — применять такой план нельзя, ' +
          'постройте его заново',
      );
    }
    const task = await findSpoolTask(ctx, taskId);
    return { status: task.status, user_service_id: task.user_service_id };
  },
};

export function provisioningRepair(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: 'provisioning_repair',
      description:
        'Чинит застрявший провижининг: retry / resume / pause одной задачи очереди SHM. ' +
        'retry и resume — буквально один и тот же обработчик (задача возвращается в NEW, ' +
        'задержка сбрасывается в ноль), pause — снимает задачу с исполнения. Пометки задачи ' +
        'как SUCCESS здесь нет и не будет: она не выполняет работу, а лишь двигает статус ' +
        'услуги — услуга станет ACTIVE в биллинге при отсутствующем пользователе в панели, то ' +
        'есть создаст ровно ту аварию, которую ищет provisioning_diagnose. Без plan_id ' +
        'возвращает план и ничего не меняет.',
      input,
      // Действие ограничено ОДНОЙ строкой очереди и обратимо противоположным
      // действием (retry ↔ pause). Это не тот класс, что перевыпуск подписки
      // или деньги; high здесь обесценил бы слово.
      risk: 'medium',
      // Только человек. Очередь спула — общая, задача чужая по построению
      // (её ставит биллинг, а не вызывающий), а retry запускает провижининг с
      // обращениями к панели и рассылкой по шаблонам события.
      profiles: ['human'],
      endpoints: [
        'GET /admin/spool',
        'POST /admin/spool/manual/retry',
        'POST /admin/spool/manual/resume',
        'POST /admin/spool/manual/pause',
      ],
      guard,
      target: (i) => ({ system: 'shm', id: i.task_id }),

      plan: async (i, ctx) => {
        const task = await findSpoolTask(ctx, i.task_id);
        const effect = ACTION_EFFECT[i.action];
        const afterState: SpoolTask = {
          ...task,
          status: effect.status,
          delayed: effect.resetsDelay ? 0 : task.delayed,
        };

        const diff = buildDiff(task, afterState, ctx.profile);
        if (diff.length === 0) {
          // Каркас отверг бы пустой diff и сам, но его формулировка общая.
          // Здесь известна причина, и она — ответ на вопрос оператора: задача
          // не «застряла», она стоит в очереди и ждёт воркера.
          throw new Error(
            `provisioning_repair: ${i.action} ничего не изменит — задача ${i.task_id} уже в ` +
              `статусе ${task.status ?? 'null'}` +
              (effect.resetsDelay ? ' и не отложена' : '') +
              '. Если задача при этом не выполняется, дело не в её строке: смотрите, жив ли ' +
              'воркер спула (spool_inspect покажет возраст очереди целиком).',
          );
        }

        const sideEffects: string[] = [];
        if (effect.resetsDelay) {
          sideEffects.push(
            'Задача будет ВЫПОЛНЕНА заново: воркер обратится к панели Remnawave и может создать ' +
              'или изменить пользователя, а шаблоны события — разослать уведомления клиенту.',
          );
          if ((task.status ?? '').toUpperCase() === 'SUCCESS') {
            sideEffects.push(
              'ЭТА ЗАДАЧА УЖЕ ЧИСЛИТСЯ ВЫПОЛНЕННОЙ. Повторный запуск оправдан ровно в одном ' +
                'случае: SUCCESS проставили вручную, а работа не выполнялась. Во всех ' +
                'остальных вы запускаете провижининг второй раз — сверьтесь с ' +
                'provisioning_diagnose до подтверждения.',
            );
          }
        } else {
          sideEffects.push(
            'Воркер больше не возьмёт эту задачу: выборка на исполнение исключает PAUSED ' +
              '(Spool.pm:132). Услуга останется без провижининга, пока паузу не снимут.',
          );
        }
        sideEffects.push(
          'Пометить задачу успешной этот инструмент не умеет и не будет: SUCCESS не выполняет ' +
            'работу, а двигает статус услуги через set_status_by_event — биллинг покажет ' +
            'ACTIVE, а пользователя в панели не будет.',
          'Запись берёт строку под локом; при контенции придёт HTTP 408, и каркас повторит ' +
            'попытку с бэкоффом.',
        );

        return {
          before: task,
          // `op` лежит РЯДОМ с предсказанным состоянием, а не вместо него:
          // применению нужны действие и адрес, оператору — «что станет». В diff
          // `op` не попадает, он посчитан по паре состояний.
          after: { ...afterState, op: { action: i.action, task_id: i.task_id } },
          diff,
          sideEffects,
        };
      },

      apply: async (plan, ctx) => {
        // План приезжает С ДИСКА. Действие перепроверяется тем же самым enum,
        // которым проверялся вход: подменённый снимок не должен получить в
        // сегмент пути ничего, чего нет в таблице ACTION_PATH.
        const parsed = opSchema.safeParse(asRecord(plan.after).op);
        if (!parsed.success) {
          throw new Error(
            'provisioning_repair: снимок плана не несёт разрешённого действия — применять его ' +
              'нельзя. Постройте план заново.',
          );
        }
        const op = parsed.data;
        // retryOn408 здесь не нужен: им оборачивает применение сам каркас.
        const task = await ctx.shm.action<unknown>('POST', ACTION_PATH[op.action], { id: op.task_id });
        return { action: op.action, task_id: op.task_id, task };
      },
    },
    deps,
  );
}
