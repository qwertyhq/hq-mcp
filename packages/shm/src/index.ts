export {
  ShmError,
  buildBasicAuth,
  dataTruthyGuard,
  isHtmlBody,
  isRetryableStatus,
  renameSafeShmKeys,
  SHM_SAFE_RENAMES,
  toShmListResult,
  unwrapShm,
} from './parse.js';
export { SHM_MAX_LIMIT, createShmClient, createUnconfiguredShmClient } from './client.js';
export type { ShmClientDeps } from './client.js';
/**
 * Как ЭТА инсталляция именует свои объекты. Живёт здесь, потому что источник
 * истины — таблица config самой SHM, а потребителей два и они в разных
 * пакетах: читающие инструменты собирают и разбирают по этим префиксам имена
 * пользователей панели, а `storage_edit` держит на них разрешительный список
 * ключей, по которым вообще готов писать.
 */
export {
  DEFAULT_PANEL_USERNAME_PREFIX,
  DEFAULT_PANEL_USERNAME_PREFIXES,
  DEFAULT_STORAGE_PREFIX,
  LEGACY_PANEL_USERNAME_PREFIXES,
  PANEL_PREFIXES_VAR,
  STORAGE_PREFIX_VAR,
  matchesKnownPrefix,
  parsePrefixList,
  prefixSourcePhrase,
  resetPanelNamingCache,
  resolvePanelNaming,
} from './naming.js';
export type { PanelNaming, PrefixSource } from './naming.js';
