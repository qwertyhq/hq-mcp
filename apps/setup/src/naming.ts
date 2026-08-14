import { loadConfig } from '@hq/env';

/**
 * КАК ЭТА ИНСТАЛЛЯЦИЯ ИМЕНУЕТ СВОИ ОБЪЕКТЫ — прочитано, а не спрошено.
 *
 * Имя пользователя панели `<префикс><user_service_id>` — единственный ключ,
 * которым услуга биллинга связывается с учёткой панели. Промах по префиксу не
 * роняет ничего: он делает КАЖДУЮ живую услугу находкой «пользователя панели
 * нет» и рекомендацией «перепровижинить клиента». Это ровно тот класс отказа,
 * ради которого мастер и написан, — сервер работает и уверенно врёт.
 *
 * Определяет префиксы `resolvePanelNaming` из @hq/tools-read: он читает ту же
 * строку конфигурации, из которой их вычисляет сам шаблон провижининга SHM.
 * Своей копии этой логики здесь нет намеренно — вторая копия однажды разойдётся
 * с первой, и разойдётся молча. Мастер делает единственное, чего резолвер
 * сделать не может: ПОКАЗЫВАЕТ ответ вместе с его источником, потому что
 * «умолчание шаблона» означает не «настроено так», а «ни одна живая система
 * этого не подтверждала».
 *
 * Отказ чтения — не повод падать: наличие `.env` от него не зависит. По той же
 * причине оба модуля подтягиваются динамическим импортом — см. `countTools`:
 * мастер обязан довести человека до записанного `.env` даже в дереве, где
 * какой-то инструмент сейчас не собирается.
 */
export async function describeNaming(
  env: Record<string, string>,
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  try {
    const [{ buildRuntime }, tools] = await Promise.all([
      import('@hq/runtime'),
      import('@hq/tools-read'),
    ]);
    const { PANEL_PREFIXES_VAR, STORAGE_PREFIX_VAR, prefixSourcePhrase, resolvePanelNaming } =
      tools;
    const { ctx } = buildRuntime(
      loadConfig({ ...env }),
      fetchImpl === undefined ? {} : { fetchImpl },
    );
    const naming = await resolvePanelNaming(ctx, env);
    const lines = [
      'How this install names the objects the two systems are joined by:',
      `  panel username   ${naming.usernamePrefixes.join('<id>, ')}<id>`,
      `                   ${prefixSourcePhrase(naming.usernamePrefixesFrom, PANEL_PREFIXES_VAR)}`,
      `  storage key      ${naming.storagePrefix}<id>`,
      `                   ${prefixSourcePhrase(naming.storagePrefixFrom, STORAGE_PREFIX_VAR)}`,
    ];
    if (naming.usernamePrefixesFrom === 'default' || naming.storagePrefixFrom === 'default') {
      lines.push(
        '  A prefix this install does not actually use makes every live service look',
        `  like it has no panel account. If that is what you see, set ${PANEL_PREFIXES_VAR}`,
        `  or ${STORAGE_PREFIX_VAR} in .env — they win over the live config.`,
      );
    }
    return lines;
  } catch {
    return [];
  }
}
