import { z } from 'zod';
import { hashInput } from '@hq/confirm';
import type { MutationPlan } from '@hq/confirm';
import { defineMutation, planIdField } from '../kit.js';
import type { MutationDeps, MutationTool } from '../kit.js';
import { isRecord, sharedListName, syncRefuse } from './syncConfig.js';
import { MAX_SYNC_AFFECTED_NODES, PLUGINS_PATH, SHARED_LISTS_PATH, readSyncState, syncOperation } from './syncSources.js';

const input = z.object({
  target: z.enum(['plugin', 'shared_list']).describe('Явно указать плагин или общий список для повторной синхронизации.'),
  uuid: z.string().uuid().toLowerCase().optional().describe('UUID плагина; только для target=plugin.'),
  name: sharedListName.optional().describe('Имя общего списка без ext:; только для target=shared_list.'),
  ...planIdField,
}).strict();

const afterSchema = z.object({
  operation: syncOperation,
  expectedAffectedNodeCount: z.number().int().min(0).max(MAX_SYNC_AFFECTED_NODES),
}).strict();

const beforeSchema = z.object({
  operation: syncOperation,
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  catalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  membershipFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  affectedNodeCount: z.number().int().min(0).max(MAX_SYNC_AFFECTED_NODES),
  affectedNodes: z.array(z.object({
    uuid: z.string().uuid(), name: z.string().max(255), pluginUuid: z.string().uuid(),
  }).strict()).max(MAX_SYNC_AFFECTED_NODES),
  attachedNodeCount: z.number().int().min(0).max(500),
  excludedNodeCount: z.number().int().min(0).max(500),
});

/** Check both paths: the shared guard and the applier can be dispatched independently. */
function validateSyncPlan(plan: MutationPlan) {
  const before = beforeSchema.safeParse(plan.before);
  const after = afterSchema.safeParse(plan.after);
  if (!before.success || !after.success) syncRefuse('снимок синхронизации повреждён; постройте новый план.');
  // The original arguments also determine defineMutation's audit target.id. Checking the
  // stored input hash binds that identity to both the reviewed target and the eventual POST.
  if (hashInput(before.data.operation) !== plan.inputHash ||
      hashInput(after.data.operation) !== plan.inputHash ||
      after.data.expectedAffectedNodeCount !== before.data.affectedNodeCount ||
      before.data.affectedNodeCount !== before.data.affectedNodes.length ||
      new Set(before.data.affectedNodes.map((one) => one.uuid)).size !== before.data.affectedNodeCount ||
      before.data.attachedNodeCount !== before.data.affectedNodeCount + before.data.excludedNodeCount) {
    syncRefuse('снимок синхронизации несогласован: цель или охват не соответствуют подтверждённому плану.');
  }
  return { before: before.data, after: after.data };
}

function impactOf(state: {
  affectedNodeCount: number; affectedNodes: unknown[]; attachedNodeCount: number; excludedNodeCount: number;
}) {
  return {
    affectedNodeCount: state.affectedNodeCount, affectedNodes: state.affectedNodes,
    attachedNodeCount: state.attachedNodeCount, excludedNodeCount: state.excludedNodeCount,
  };
}

const CAVEAT = 'Повторная синхронизация не отменяет изменение конфигурации. Отката этой операции нет.';

export function panelSync(deps: MutationDeps): MutationTool {
  return defineMutation({
    name: 'panel_sync',
    description:
      'Подтверждаемая повторная синхронизация существующего плагина или общего списка Remnawave. ' +
      'Без plan_id только показывает зависимости и узлы; конфигурации и IP не возвращаются. ' +
      'Перед POST заново сверяет полный хеш конфигураций и состав узлов. Читает до 100 записей ' +
      'каталога, 10 карточек плагинов, 10 общих списков и 500 узлов; охват не более 20 узлов. ' +
      'Неполный или недоступный источник запрещает план. HTTP 202 означает только принятие: ' +
      'общий status=applied обозначает выполнение плана, result.status=queued и completed=false ' +
      'не подтверждают доставку на узлы. ' + CAVEAT,
    risk: 'high', profiles: ['human'], input,
    endpoints: [
      `GET ${PLUGINS_PATH}`, `GET ${PLUGINS_PATH}/{uuid}`, `GET ${SHARED_LISTS_PATH}`,
      `GET ${SHARED_LISTS_PATH}/{name}`, 'GET /api/nodes',
      `POST ${PLUGINS_PATH}/actions/sync`, `POST ${SHARED_LISTS_PATH}/actions/sync`,
    ],
    target: (i) => ({ system: 'remna', id: `${i.target}:${i.uuid ?? i.name ?? ''}` }),
    guard: {
      keys: ['configFingerprint', 'catalogFingerprint', 'membershipFingerprint'],
      read: async (plan, ctx) => {
        const snapshot = validateSyncPlan(plan);
        const current = await readSyncState(snapshot.before.operation, ctx);
        if (hashInput(impactOf(snapshot.before)) !== hashInput(impactOf(current))) {
          // Do not pass corrupted node metadata to assertUnchanged: it includes values in errors.
          syncRefuse('состояние изменилось: снимок охвата узлов не соответствует панели; постройте новый план.');
        }
        return current;
      },
    },
    plan: async (i, ctx) => {
      const { plan_id: _planId, ...asked } = i;
      const operation = syncOperation.safeParse(asked);
      if (!operation.success) syncRefuse('target=plugin требует только uuid; target=shared_list требует только name.');
      const before = await readSyncState(operation.data, ctx);
      return {
        before,
        after: { operation: operation.data, expectedAffectedNodeCount: before.affectedNodeCount },
        diff: [{ path: 'syncRequest', from: 'not_sent', to: 'enqueue' }],
        sideEffects: [
          `Панель поставит синхронизацию в очередь для ${String(before.affectedNodeCount)} узлов из плана. ` +
            `Ещё ${String(before.excludedNodeCount)} привязанных узлов выключены, отключены или подключаются.`,
          'Будет отправлена текущая конфигурация плагинов со всеми их общими списками; это может менять сетевые фильтры.',
          'HTTP 202 подтверждает только приём запроса. Доставка и применение не проверены; очередь читает актуальную конфигурацию позже.',
          CAVEAT,
        ],
      };
    },
    apply: async (plan, ctx) => {
      if (ctx.profile !== 'human' || ctx.mode !== 'rw') syncRefuse('синхронизация разрешена только human в режиме rw.');
      const { operation, expectedAffectedNodeCount } = validateSyncPlan(plan).after;
      const path = operation.target === 'plugin' ? `${PLUGINS_PATH}/actions/sync` : `${SHARED_LISTS_PATH}/actions/sync`;
      const body = operation.target === 'plugin' ? { uuid: operation.uuid } : { name: operation.name };
      try {
        await ctx.remna.send<unknown>('POST', path, body);
      } catch (error) {
        const status = isRecord(error) && Number.isInteger(error.status) ? ` (HTTP ${String(error.status)})` : '';
        syncRefuse(`запрос синхронизации не подтверждён${status}; проверьте состояние панели перед новой попыткой.`);
      }
      return {
        status: 'queued', accepted: true, completed: false, target: operation,
        expectedAffectedNodeCount,
        actualAffectedNodeCount: null,
        message: 'Панель приняла запрос. Доставка и применение на узлах не подтверждены.',
        caveat: CAVEAT,
      };
    },
  }, deps);
}
