export {
  BALANCE_SPEND_ENDPOINT_PATHS,
  BULK_ENDPOINT_PATHS,
  MONEY_ENDPOINT_PATHS,
  NO_MONEY,
  PLAN_ID_FIELD,
  applyPlan,
  assertUnchanged,
  defaultSleep,
  defineMutation,
  planIdField,
  retryOn408,
} from './kit.js';
export type {
  AppliedResult,
  DeclaredAmount,
  MutationApplier,
  MutationDeps,
  MutationInput,
  MutationLimits,
  MutationRunner,
  MutationSpec,
  MutationTool,
  PlanDraft,
  PlanGuard,
  PlanIdInput,
  PlanResult,
} from './kit.js';
export { OWNERSHIP_PAGE, assertServiceOwner, readServicesPage } from './service/ownership.js';
export type { OwnedService, ServicesPage } from './service/ownership.js';
export { SERVICE_STATUSES, serviceLifecycle } from './service/lifecycle.js';
export type { LifecycleAction } from './service/lifecycle.js';
export { ALLOWED_USER_FIELDS, FORBIDDEN_USER_FIELDS, userFlags } from './user/flags.js';
export { SPOOL_SCAN_LIMIT, findSpoolTask, provisioningRepair } from './provisioningRepair.js';
export type { SpoolTask } from './provisioningRepair.js';
export { computeExpireAt, subscriptionOps } from './subscriptionOps.js';
export { billingAdjust } from './billing/billingAdjust.js';
export { billingRefundService } from './billing/billingRefundService.js';
/**
 * ЕДИНСТВЕННАЯ проверка владения услугой: точечный запрос по
 * `user_service_id`, положительное доказательство владельца, запасной путь на
 * страницу клиента для сборок без server-side filter и «подтвердить не
 * удалось» вместо «услуга чужая». Отдаёт строку как есть — вместе с
 * подмешанным списанием (`withdraws`), из которого возврат берёт сумму.
 *
 * `assertServiceOwner` выше — не вторая проверка, а её же результат,
 * приведённый к типам жизненного цикла (`status`, `next`, `cost` числами и
 * строками, а не `unknown`). Две копии одного алгоритма под разными именами
 * прожили ровно столько, сколько две задачи шли параллельно.
 */
export { assertOwnsService } from './billing/ownership.js';
export type { OwnedWithdraw } from './billing/ownership.js';
export {
  HISTORY_SCAN,
  findHqTwin,
  findPlanRow,
  hqPlanOf,
  readClientMoney,
} from './billing/money.js';
export type { ClientMoney, ClientMoneyRead, MoneyRow } from './billing/money.js';
export { MUTATION_FACTORIES, createMutationTools, registerMutations } from './register.js';
export type { MutationFactory } from './register.js';
export {
  FORBIDDEN_SETTINGS_KEYS,
  GROUP_FIELDS,
  GROUP_TYPES,
  REDACTION_MARKER,
  SERVER_FIELDS,
  TRANSPORTS,
  assertNoMaskedValues,
  serverEdit,
} from './server/edit.js';
export type { ServerEditAction } from './server/edit.js';
export { hostEdit, mergeHost, previousOf, readHostRaw, readHostsRaw, hostState } from './panel/hostEdit.js';
export type { HostPatchBody } from './panel/hostEdit.js';
export { MAX_CLEANUP_BATCH, hostCleanup } from './panel/hostCleanup.js';
export { nodeManage } from './panel/nodeManage.js';
export { panelSync } from './panel/sync.js';
/**
 * Служебные инструменты мутационной поверхности. Мутаторами они не являются
 * (`defineMutation` не зовут, планов не строят), поэтому их нет и в
 * `MUTATION_FACTORIES`: `ops_confirm` получает СОБРАННЫЕ мутаторы аргументом, а
 * значит регистрируется после них — этот шов делает сборка рантайма.
 */
export { opsAudit, opsConfirm } from './ops.js';
export { bulkOps } from './bulk/bulkOps.js';
export {
  FLEET_MAX_PAGES,
  FLEET_PAGE_SIZE,
  USER_STATUSES,
  readFleet,
  readFleetPage,
  readFleetTotal,
  resolveUserIds,
  toFleetUser,
} from './bulk/fleet.js';
export type { FleetPage, FleetRead, FleetUser, ResolvedSet, UserStatus } from './bulk/fleet.js';
/**
 * Снимок «до» на локальном диске. Нужен ровно двум инструментам ниже и по
 * одной причине: их «до» — это текст и снимок конфигурации клиента, то есть
 * данные, у которых нет имени поля, по которому редакция могла бы их
 * замаскировать. Держать такое в `before`/`rollback` плана значит вернуть его
 * модели, поэтому оно уезжает в файл, а наружу идёт только путь.
 */
export {
  defaultBackupDir,
  readBackup,
  sha256Of,
  stableStringify,
  writeBackup,
} from './backups.js';
export type { BackupKind, BackupRecord } from './backups.js';
export {
  DEFAULT_STORAGE_APP_KEYS,
  STORAGE_APP_KEYS_VAR,
  storageAllowlist,
  storageEdit,
} from './storage/edit.js';
export type { StorageAllowlist } from './storage/edit.js';
export { templateEdit } from './template/edit.js';
