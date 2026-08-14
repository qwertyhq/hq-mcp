import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildDiff } from '@hq/confirm';
import {
  buildTopology,
  forecastOrphans,
  hostsWithUnknownInbound,
  inboundsActiveWithoutHost,
} from '@hq/remna';
import type { Topology } from '@hq/remna';
import type { ToolContext } from '@hq/types';
import { defaultSleep, defineMutation, planIdField } from '../kit.js';
import type { MutationDeps, MutationTool, PlanDraft, PlanGuard } from '../kit.js';
import { readHostsRaw } from './hostEdit.js';

/**
 * УДАЛЕНИЕ ХОСТОВ. НЕОБРАТИМО, И ЭТО ГЛАВНОЕ СВОЙСТВО ИНСТРУМЕНТА.
 *
 * У панели нет ни корзины, ни отмены: `hostsRepository.deleteByUUID` удаляет
 * строку. Единственный путь восстановления — создать хост заново руками по
 * снимку, который этот план кладёт на диск ЦЕЛИКОМ и нередактированным.
 * Поэтому `rollback` здесь не заполняется вовсе: поле, содержащее «инструкцию
 * отката», которая на деле означает «наберите это в UI», хуже пустого.
 *
 * ЧЕГО ЭТОТ ИНСТРУМЕНТ НЕ ДЕЛАЕТ И НЕ БУДЕТ: он не выводит список удаляемых
 * хостов из разрывов карты. Список всегда приходит явными uuid от человека.
 * Причина в `inboundsActiveWithoutHost`: инбаунд, который нода обслуживает, а
 * хоста у него нет, — это НОРМАЛЬНЫЙ мост или релейный хоп. `fix-bridge.sh` в
 * remna-configs создаёт их именно так, и на здоровой панели такими оказывается
 * заметная часть инбаундов (имена вида `BRIDGE_*_IN`). Автоматическая
 * «чистка по разрыву» либо снесла бы рабочие хосты, либо — что хуже —
 * подтолкнула бы опубликовать мост клиентам. Разрывы здесь используются ровно
 * наоборот: чтобы показать, во что превратится карта ПОСЛЕ удаления, и
 * отказаться, если гаснет живая точка входа.
 *
 * Арифметика разрывов взята из общего модуля `@hq/remna/topology` — того же,
 * которым считает `infra_map`. Второй копии этих правил в проекте нет
 * намеренно: разъехавшись, она продолжала бы выглядеть согласованной с картой.
 */

/**
 * Потолок партии. Панельные `bulk/*` не используются вовсе: они принимают
 * фильтр вместо списка (радиус — вся таблица), а их наличие на этом
 * развёртывании не подтверждено. Удаляем поштучно.
 */
export const MAX_CLEANUP_BATCH = 20;

/** Пауза между удалениями: каждое рождает событие панели, у которого есть подписчик. */
const DELETE_PAUSE_MS = 200;

const HOSTS_PATH = '/api/hosts';

const input = z.object({
  uuids: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_CLEANUP_BATCH)
    .describe(
      'Явный список uuid хостов на удаление. Из разрывов карты он НЕ выводится: инбаунд без ' +
        'хоста — это обычно мост, а не поломка.',
    ),
  reason: z
    .string()
    .min(5)
    .describe('Почему эти хосты подлежат сносу. Уезжает в журнал мутаций как есть.'),
  ...planIdField,
});

type Input = z.infer<typeof input>;

/** Всё, что применение читает из плана. Ничего сверх этого оттуда не берётся. */
const opSchema = z.object({
  uuids: z.array(z.string().uuid()).min(1).max(MAX_CLEANUP_BATCH),
  remaining: z.number().int().min(1),
});

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function refuse(message: string): never {
  throw new Error(`host_cleanup: ${message}`);
}

/**
 * Отпечаток состава хостов вместо самого состава. Полный список uuid,
 * положенный в снимок и в diff, — это килобайты в контексте модели на каждый
 * план и километровая строка `hostUuids: [...] -> [...]`, за которой не видно
 * ни одного действительно удаляемого хоста (замерено на работающей панели).
 * Сверка от этого не слабеет: любое изменение состава меняет отпечаток, а ЧТО
 * именно удаляется, оператор читает в `after.hosts` поимённо.
 */
function fingerprint(uuids: readonly string[]): string {
  return createHash('sha256').update([...uuids].sort().join(',')).digest('hex').slice(0, 16);
}

function nameOf(gap: { uuid: string; tag: string | null }): string {
  return gap.tag === null ? gap.uuid : `${gap.tag} (${gap.uuid})`;
}

interface Sources {
  topology: Topology;
  hosts: Record<string, unknown>[];
}

/**
 * Читает всё, из чего считается карта. Хосты — НЕРЕДАКТИРОВАННЫМ каналом:
 * снимок удаляемого хоста и есть единственный путь восстановления, а из масок
 * хост не пересоздашь. Остальные три листинга читаются обычным каналом: они
 * нужны только для арифметики разрывов и наружу уходят числами.
 */
async function readSources(ctx: ToolContext): Promise<Sources> {
  const hosts = await readHostsRaw(ctx);
  const [nodes, profiles, inbounds] = await Promise.all([
    ctx.remna.get<unknown>('/api/nodes'),
    ctx.remna.get<unknown>('/api/config-profiles'),
    ctx.remna.get<unknown>('/api/config-profiles/inbounds'),
  ]);

  const rowsOf = (value: unknown, key: string): unknown[] => {
    if (Array.isArray(value)) return value;
    const nested = asRecord(value)[key];
    return Array.isArray(nested) ? nested : [];
  };

  const nodeRows = rowsOf(nodes, 'nodes');
  if (nodeRows.length === 0) {
    refuse(
      'панель не вернула ни одной ноды. Без листинга нод нельзя установить, какие инбаунды ' +
        'кто-то обслуживает, — а без этого проверка «не гаснет ли страна» молчит и выглядит ' +
        'пройденной. План не строится.',
    );
  }

  return {
    hosts,
    topology: buildTopology({
      nodes: nodeRows,
      hosts,
      inbounds: rowsOf(inbounds, 'inbounds'),
      profiles: rowsOf(profiles, 'configProfiles'),
    }),
  };
}

const guard: PlanGuard = {
  // Сверяются СОСТАВ хостов и их выключенность: и «кто-то уже удалил один из
  // них», и «кто-то включил хост, который мы считали погашенным», означают, что
  // прогноз сирот, показанный оператору, больше не про этот мир.
  keys: ['hostsFingerprint', 'enabledHostsFingerprint'],
  read: async (_plan, ctx) => {
    const hosts = await readHostsRaw(ctx);
    const topology = buildTopology({ nodes: [], hosts, inbounds: [], profiles: [] });
    return {
      hostsFingerprint: fingerprint(topology.hosts.map((host) => host.uuid)),
      enabledHostsFingerprint: fingerprint(
        topology.hosts.filter((host) => !host.isDisabled).map((host) => host.uuid),
      ),
    };
  },
};

export function hostCleanup(deps: MutationDeps): MutationTool {
  return defineMutation<Input>(
    {
      name: 'host_cleanup',
      description:
        'Удаление хостов Remnawave по ЯВНОМУ списку uuid. НЕОБРАТИМО: у панели нет отмены, ' +
        'восстановление — ручное создание хоста заново по снимку из плана. План показывает ' +
        'поимённо каждый удаляемый хост, их количество и прогноз по карте: какие инбаунды ' +
        'останутся без живого хоста. Если удаление гасит точку входа, которую обслуживает ' +
        'нода, план не строится. Список никогда не выводится из разрывов карты: инбаунд без ' +
        'хоста — это, как правило, мост или релейный хоп, и его хост не создан намеренно. ' +
        'Без plan_id возвращает план и ничего не удаляет.',
      input,
      risk: 'high',
      profiles: ['human'],
      endpoints: [
        'GET /api/hosts',
        'GET /api/nodes',
        'GET /api/config-profiles',
        'GET /api/config-profiles/inbounds',
        'DELETE /api/hosts/{uuid}',
      ],
      guard,

      plan: async (i, ctx): Promise<PlanDraft> => {
        const asked = [...new Set(i.uuids)];
        if (asked.length !== i.uuids.length) {
          refuse('в списке есть повторы. Уберите их: план должен совпадать со списком удалений.');
        }

        const { hosts, topology } = await readSources(ctx);
        const byUuid = new Map(hosts.map((host) => [String(host.uuid), host]));
        const missing = asked.filter((uuid) => !byUuid.has(uuid));
        if (missing.length > 0) {
          refuse(
            `в панели нет хостов ${missing.join(', ')}. План не строится целиком — частичного ` +
              'удаления по списку, половина которого уже неверна, не бывает.',
          );
        }

        const remaining = hosts.length - asked.length;
        if (remaining < 1) {
          refuse(
            `после удаления не осталось бы ни одного хоста (${String(hosts.length)} в панели, ` +
              `${String(asked.length)} в списке). Панель без хостов не раздаёт ничего никому.`,
          );
        }

        /**
         * ОТКАЗ, А НЕ ПРЕДУПРЕЖДЕНИЕ. Инбаунд, который обслуживает нода и у
         * которого после удаления не остаётся ни одного ВКЛЮЧЁННОГО хоста, —
         * это страна, гаснущая в момент подтверждения. Оператору, который
         * действительно хочет её погасить, есть чем: `host_edit` с
         * `is_disabled`, обратимый одним PATCH.
         */
        const forecast = forecastOrphans(topology, asked);
        if (forecast.losingLastLiveHost.length > 0) {
          refuse(
            `удаление оставит без единого включённого хоста инбаунд(ы) ` +
              `${forecast.losingLastLiveHost.map(nameOf).join(', ')}, которые сейчас обслуживают ` +
              'ноды. Клиенты потеряют эту точку входа немедленно и молча. Если цель именно в ' +
              'этом, гасите хост обратимо — host_edit с is_disabled, — и удаляйте потом.',
          );
        }

        const zombies = new Set(hostsWithUnknownInbound(topology).map((host) => host.uuid));
        const bridges = inboundsActiveWithoutHost(topology).map(nameOf);
        const doomed = asked.map((uuid) => {
          const host = byUuid.get(uuid) ?? {};
          const mapped = topology.hosts.find((one) => one.uuid === uuid);
          const inboundUuid = mapped?.inboundUuid ?? null;
          return {
            uuid,
            remark: mapped?.remark ?? null,
            address: host.address ?? null,
            port: host.port ?? null,
            isDisabled: mapped?.isDisabled ?? null,
            inboundUuid,
            inboundTag: inboundUuid === null ? null : (topology.tagByInbound.get(inboundUuid) ?? null),
            servedByNodes: inboundUuid === null ? [] : [...(topology.servedBy.get(inboundUuid) ?? [])],
            // Прямой ответ на «а точно ли это мусор»: зомби ссылается на
            // инбаунд, которого в панели больше нет.
            isZombie: zombies.has(uuid),
          };
        });

        const effects: string[] = [
          `УДАЛЯЕТСЯ ${String(asked.length)} хост(ов) из ${String(hosts.length)}; останется ` +
            `${String(remaining)}. Поимённо они перечислены в after.hosts.`,
          'НЕОБРАТИМО. У панели нет отмены удаления хоста. Единственный путь назад — создать ' +
            'хост заново руками; полный нередактированный снимок каждого удаляемого хоста ' +
            'сохранён в файле плана, поле rollback намеренно пустое.',
          'Удаление немедленно меняет выдачу подписок всем клиентам, которым этот хост попадал ' +
            'в конфиг.',
          `Удаляем поштучно с паузой ${String(DELETE_PAUSE_MS)} мс: каждое удаление порождает ` +
            'событие панели, у которого в этом развёртывании есть подписчик (шаблон SHM). ' +
            'Массовые ручки /api/hosts/bulk/* не используются — они принимают фильтр вместо ' +
            'списка.',
        ];

        const notZombies = doomed.filter((host) => !host.isZombie);
        if (notZombies.length > 0) {
          effects.push(
            `${String(notZombies.length)} из ${String(asked.length)} хостов НЕ зомби: их инбаунд ` +
              `панели известен (${notZombies.map((host) => host.uuid).join(', ')}). Это не ` +
              'запрет, но и не уборка мусора — убедитесь, что это осознанный снос.',
          );
        }
        if (forecast.losingLastHost.length > 0) {
          effects.push(
            `После удаления инбаунд(ы) ${forecast.losingLastHost.map(nameOf).join(', ')} ` +
              'останутся вообще без хостов и станут в карте неотличимы от моста ' +
              '(gaps.inboundsActiveWithoutHost). Клиентам они уже не светили — живого хоста у ' +
              'них не было, — но следующий оператор увидит их рядом с настоящими мостами.',
          );
        }
        if (bridges.length > 0) {
          effects.push(
            `Справочно: на этой панели ${String(bridges.length)} инбаунд(ов) уже живут без ` +
              `хоста (${bridges.join(', ')}). Это мосты и релейные хопы, они принимают трафик с ` +
              'другой ноды. Отсутствие хоста у них — норма, а не задача для этого инструмента.',
          );
        }

        const before = {
          totalHosts: hosts.length,
          // Ключи сверки живут В СНИМКЕ, а не только в `guard.read`:
          // `assertUnchanged` сравнивает две стороны по имени, и поля, которого
          // нет в `before`, хватило бы, чтобы сверка молчала всегда.
          hostsFingerprint: fingerprint(topology.hosts.map((host) => host.uuid)),
          enabledHostsFingerprint: fingerprint(
            topology.hosts.filter((host) => !host.isDisabled).map((host) => host.uuid),
          ),
          // Полный СЫРОЙ снимок: восстанавливать нечем, кроме него.
          hosts: asked.map((uuid) => byUuid.get(uuid)),
        };

        return {
          before,
          after: {
            reason: i.reason,
            deleting: asked.length,
            totalHosts: remaining,
            hosts: doomed,
            op: { uuids: asked, remaining },
          },
          // Diff — про ЧИСЛО хостов; кого именно сносим, перечислено в
          // `after.hosts` поимённо, с ремарками, тегом инбаунда и нодами.
          // Пара списков по 51 uuid вместо этого прятала бы находку в шуме.
          diff: buildDiff({ totalHosts: hosts.length }, { totalHosts: remaining }, ctx.profile),
          sideEffects: effects,
        };
      },

      apply: async (plan, ctx) => {
        const parsed = opSchema.safeParse(asRecord(plan.after).op);
        if (!parsed.success) {
          refuse('снимок плана не несёт разрешённого списка удаления — постройте план заново.');
        }
        const sleep = deps.sleep ?? defaultSleep;
        const deleted: string[] = [];

        // Поштучно и последовательно. Первая же ошибка прекращает цикл: уже
        // удалённое остаётся удалённым, и вернуть его нельзя — поэтому наружу
        // едет список того, что успело уйти, а не голое исключение.
        for (const uuid of parsed.data.uuids) {
          try {
            await ctx.remna.send<unknown>('DELETE', `${HOSTS_PATH}/${uuid}`);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
              `host_cleanup: удаление ${uuid} не прошло (${message}). УЖЕ УДАЛЕНЫ и не ` +
                `подлежат восстановлению: ${deleted.join(', ') || '(ни одного)'}. Снимок ` +
                'удалённых хостов остался в файле плана.',
            );
          }
          deleted.push(uuid);
          await sleep(DELETE_PAUSE_MS);
        }

        const left = await readHostsRaw(ctx);
        const leftUuids = new Set(left.map((host) => String(host.uuid)));
        const stillPresent = deleted.filter((uuid) => leftUuids.has(uuid));

        return {
          deleted,
          stillPresent,
          remaining: left.length,
          verified: stillPresent.length === 0,
        };
      },
    },
    deps,
  );
}
