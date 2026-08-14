import { describe, expect, it } from 'vitest';
import { FORBIDDEN_RULES, assertNotForbidden } from '@hq/registry';
import { createMutationTools } from './register.js';
import { makeWorld } from './testkit.js';

/** `PUT /admin/user/payment` -> `{ method: 'PUT', path: '/admin/user/payment' }` */
function split(endpoint: string): { method: string; path: string } {
  const [method = '', ...rest] = endpoint.trim().split(/\s+/);
  return { method, path: rest.join(' ') };
}

function declared(): Map<string, string[]> {
  return new Map(createMutationTools(makeWorld().deps).map((tool) => [tool.name, tool.endpoints]));
}

describe('запрещённые операции (§8)', () => {
  it('форбидден-модуль подключён и действительно отбивает запрещённый путь', () => {
    // Без этой проверки все остальные в файле бессмысленны: молчащий
    // assertNotForbidden делает их зелёными на любом наборе эндпоинтов.
    expect(FORBIDDEN_RULES.length).toBeGreaterThan(10);
    expect(() => {
      assertNotForbidden('/admin/server/identity/generate', 'POST');
    }).toThrow();
    expect(() => {
      assertNotForbidden('/api/tokens', 'POST');
    }).toThrow();
    expect(() => {
      assertNotForbidden('/api/tokens/abc', 'DELETE');
    }).toThrow();
    expect(() => {
      assertNotForbidden('/admin/user/service/change', 'POST');
    }).not.toThrow();
  });

  it('ни один инструмент не объявляет запрещённый эндпоинт', () => {
    for (const [tool, endpoints] of declared()) {
      expect(endpoints.length, `${tool} не объявил ни одного эндпоинта`).toBeGreaterThan(0);
      for (const endpoint of endpoints) {
        const { method, path } = split(endpoint);
        expect(method, `${tool}: «${endpoint}» без метода`).toMatch(
          /^(GET|POST|PUT|PATCH|DELETE)$/,
        );
        expect(() => {
          assertNotForbidden(path, method);
        }, `${tool} объявляет запрещённый эндпоинт ${endpoint}`).not.toThrow();
      }
    }
  });

  /**
   * §6.10: пометить задачу спула успешной руками — значит соврать биллингу о
   * состоянии мира. Починка задачи — это retry/resume/pause, и именно они
   * объявлены; соседний `manual/success` не объявлен никем и запрещён правилом.
   */
  it('ручная пометка задачи успешной не объявлена ни одним инструментом (§6.10)', () => {
    const all = [...declared().values()].flat();
    expect(all.join('\n')).not.toContain('manual/success');
    expect(all).toContain('POST /admin/spool/manual/retry');
  });

  /**
   * `template_edit` УБРАН ИЗ ЭТОГО СПИСКА ОСОЗНАННО, И ГРАНИЦА НЕ ИСЧЕЗЛА, А
   * ПЕРЕЕХАЛА.
   *
   * Имя стояло здесь, пока запрещена была ЛЮБАЯ запись шаблона, и запрет
   * обосновывался словами «нет гита, нет отката». Владелец попросил
   * перезапись — и она появилась вместе с механизмом, которого не было:
   * `template_edit` снимает предыдущие байты в файл ДО записи, отказывается
   * писать без снимка, отказывается писать пустое тело и тело с маркерами
   * чистки, и умеет положить снятое обратно. Создание и удаление остались
   * закрыты и в правиле §8 (PUT/DELETE), и здесь — под своими именами: у
   * появившегося и у исчезнувшего шаблона снимать нечего.
   */
  it('в реестре нет инструментов с прокси-именами (§7.1)', () => {
    const names = [...declared().keys()];
    for (const banned of [
      'config_write',
      'template_create',
      'template_delete',
      'spool_broadcast',
      'tokens_create',
      'users_bulk',
      'nodes_restart_all',
      'shm_raw',
      'remna_raw',
      'sql_exec',
    ]) {
      expect(names).not.toContain(banned);
    }
  });

  /**
   * Проверка не декоративная: `defineMutation` прогоняет объявленные эндпоинты
   * через `assertNotForbidden` ПРИ СБОРКЕ, и сборка с запрещённой ручкой обязана
   * не состояться вовсе — не «состояться и отказать при вызове».
   */
  it('мутатор с запрещённой ручкой не собирается: отказ на сборке, а не на вызове', async () => {
    const { defineMutation, planIdField } = await import('./kit.js');
    const { z } = await import('zod');
    expect(() =>
      defineMutation(
        {
          name: 'tokens_create',
          description: 'выпуск токена — то, чего быть не должно',
          input: z.object({ ...planIdField }),
          risk: 'high',
          profiles: ['human'],
          endpoints: ['POST /api/tokens'],
          guard: { keys: ['id'], read: async () => ({}) },
          plan: async () => ({ before: null, after: null, diff: [], sideEffects: [] }),
          apply: async () => ({}),
        },
        makeWorld().deps,
      ),
    ).toThrow();
  });
});
