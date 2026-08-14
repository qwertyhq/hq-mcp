import { billingAdjust } from './billing/billingAdjust.js';
import { billingRefundService } from './billing/billingRefundService.js';
import { bulkOps } from './bulk/bulkOps.js';
import { hostCleanup } from './panel/hostCleanup.js';
import { hostEdit } from './panel/hostEdit.js';
import { nodeManage } from './panel/nodeManage.js';
import { provisioningRepair } from './provisioningRepair.js';
import { serverEdit } from './server/edit.js';
import { serviceLifecycle } from './service/lifecycle.js';
import { storageEdit } from './storage/edit.js';
import { subscriptionOps } from './subscriptionOps.js';
import { templateEdit } from './template/edit.js';
import { userFlags } from './user/flags.js';
import { backendsOfEndpoints } from '@hq/registry';
import type { Registry } from '@hq/registry';
import type { ToolDef } from '@hq/types';
import type { MutationDeps, MutationTool } from './kit.js';

/**
 * Фабрика мутатора: одна и та же форма у всех, потому что зависимости у них
 * общие (журнал, хранилище планов, потолок суммы), а всё остальное каждый
 * добирает из `ToolContext` на вызове.
 */
export type MutationFactory = (deps: MutationDeps) => MutationTool;

/**
 * ЕДИНСТВЕННЫЙ СПИСОК МУТАТОРОВ.
 *
 * Списка ИМЁН рядом с ним нет намеренно. Имена выводятся отсюда
 * (`createMutationTools(deps).map((m) => m.name)`), потому что вторая копия
 * набора живёт ровно до первого добавленного инструмента: константа с десятью
 * именами и реестр с одиннадцатью расходятся молча, а тест, сверяющий одно с
 * другим, остаётся зелёным — он сверяет копию с копией.
 *
 * Что мутатор ДОБАВЛЕН, но НЕ дописан сюда, ловится не глазами: соседний
 * `register.test.ts` выводит набор из БАРРЕЛЯ (`index.ts`) и требует, чтобы
 * каждый выставленный наружу мутатор был здесь. Граница — именно баррель:
 * файл, лежащий в дереве, но ещё не экспортированный, — черновик, а экспорт и
 * есть момент, когда автор сказал «готово».
 */
export const MUTATION_FACTORIES: readonly MutationFactory[] = [
  billingAdjust,
  billingRefundService,
  bulkOps,
  hostCleanup,
  hostEdit,
  nodeManage,
  provisioningRepair,
  serverEdit,
  serviceLifecycle,
  storageEdit,
  subscriptionOps,
  templateEdit,
  userFlags,
];

/**
 * Сборка мутаторов на конкретных зависимостях.
 *
 * Возвращается `MutationTool[]`, а не `{ tools, appliers, endpoints }`: в
 * `MutationTool` уже лежит и определение (`def`), и исполнитель (`apply`), и
 * сверка мира (`guard`), и объявленные эндпоинты. Три параллельные карты,
 * ключом которым служит имя из того же объекта, — это тот же набор, разложенный
 * так, что его можно рассогласовать.
 *
 * Проверки каркаса (запрещённый эндпоинт §8, мутирующий GET §6.15, денежная
 * ручка без `amountOf`, пустой `guard.keys`, схема без `plan_id`) срабатывают
 * ЗДЕСЬ, при сборке, а не при первом вызове: инструмент с запрещённой ручкой
 * иначе спокойно доезжает до прода и ждёт там своего первого оператора.
 */
export function createMutationTools(deps: MutationDeps): MutationTool[] {
  return MUTATION_FACTORIES.map((factory) => {
    const tool = factory(deps);
    /**
     * К КАКИМ СИСТЕМАМ ХОДИТ МУТАТОР — ВЫВОДИТСЯ, А НЕ ОБЪЯВЛЯЕТСЯ ВТОРОЙ РАЗ.
     *
     * Мутатор уже перечисляет свою поверхность в `endpoints`, и на этом списке
     * держатся проверки запрещённых и денежных ручек. Отдельное поле «а ещё я
     * хожу в панель» было бы второй копией того же факта — и разошлось бы с
     * первой на первой же добавленной ручке, причём молча: увидеть расхождение
     * можно только там, где второй системы нет, то есть у чужого оператора.
     *
     * Мутаторов, которым нужны ОБЕ системы, сегодня нет ни одного: каждый пишет
     * либо в биллинг, либо в панель. Вывод это не предполагает — он вернёт обе,
     * если такой появится, и такой инструмент честно исчезнет там, где есть
     * только одна.
     */
    return { ...tool, def: { ...tool.def, backends: backendsOfEndpoints(tool.endpoints) } };
  });
}

/**
 * Регистрация в общем реестре.
 *
 * Прятать мутаторы по `cfg.mode` вручную не нужно и вредно: видимость считает
 * `Registry.list({ mode, profile })`, и в режиме `ro` инструмент с
 * `access: 'rw'` не возвращается вовсе — модель его не видит и вызвать не
 * может. Условная регистрация была бы вторым механизмом сокрытия, а два
 * механизма расходятся: тот, который забыли обновить, начинает показывать то,
 * что второй прячет.
 */
export function registerMutations(registry: Registry, deps: MutationDeps): ToolDef[] {
  const defs = createMutationTools(deps).map((tool) => tool.def);
  for (const def of defs) registry.register(def);
  return defs;
}
