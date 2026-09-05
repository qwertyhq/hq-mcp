import { RemnaError } from '@hq/remna';

/** Ошибка попадает в audit до executeTool: тело ответа и cause здесь недопустимы. */
export function panelMutationError(operation: string, error: unknown): Error {
  const status = error instanceof RemnaError ? error.status : null;
  return new Error(
    `Remnawave ${operation}: запрос не выполнен (${status === null || status === 0 ? 'ошибка транспорта' : `HTTP ${String(status)}`}). ` +
      'Тело ответа скрыто: оно может содержать приватную конфигурацию.',
  );
}
