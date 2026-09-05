import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_NAME_RE, createRegistry } from '@hq/registry';
import { MUTATION_FACTORIES, createMutationTools, registerMutations } from './register.js';
import { makeWorld } from './testkit.js';
import type { MutationTool } from './kit.js';

const SRC = 'tools/mutations/src';

function tools(): MutationTool[] {
  return createMutationTools(makeWorld().deps);
}

function names(): string[] {
  return tools()
    .map((tool) => tool.name)
    .sort();
}

/**
 * Имена мутаторов, ВЫВЕДЕННЫЕ ИЗ БАРРЕЛЯ, — а не переписанные списком.
 *
 * Проверка на «их шесть» зеленеет и тогда, когда седьмой мутатор написан,
 * покрыт своими тестами, выставлен наружу и просто забыт в
 * `MUTATION_FACTORIES`: в реестр он не попадёт, в `tools/list` его не будет, и
 * для модели такой возможности не станет существовать вовсе. Ровно этот дефект
 * держал шесть готовых мутаторов недостижимыми, и ловить его глазами нельзя.
 *
 * ГРАНИЦА — БАРРЕЛЬ, А НЕ ВЕСЬ КАТАЛОГ. Файл, лежащий в дереве, но ещё не
 * экспортированный из `index.ts`, — это работа в процессе (в этом пакете
 * мутаторы пишутся параллельно и красными тестами вперёд), и требовать его
 * регистрации значит краснеть на чужом черновике. Экспорт из барреля — момент,
 * когда автор сказал «готово»; с него инструмент обязан быть в реестре.
 *
 * Имя берётся из вызова `defineMutation<...>(`: и литералом, и через локальную
 * константу (`name: NAME`) — авторы пишут и так, и так.
 */
function exportedMutations(): Map<string, string> {
  const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8');
  const found = new Map<string, string>();

  for (const from of barrel.matchAll(/from '\.\/([\w./-]+)\.js'/g)) {
    const path = join(SRC, `${from[1] ?? ''}.ts`);
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const call of source.matchAll(/(function\s+)?defineMutation[<(]/g)) {
      if (call[1] !== undefined) continue;
      const named = /\bname:\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))/.exec(
        source.slice(call.index, call.index + 600),
      );
      if (named === null) continue;
      const literal = named[1];
      if (literal !== undefined) {
        found.set(literal, path);
        continue;
      }
      const constant = new RegExp(`\\b${named[2] ?? ''}\\s*=\\s*'([^']+)'`).exec(source);
      if (constant?.[1] !== undefined) found.set(constant[1], path);
    }
  }
  return found;
}

describe('createMutationTools', () => {
  it('регистрирует КАЖДЫЙ мутатор, выставленный из барреля', () => {
    const registered = new Set(names());
    const missing = [...exportedMutations()]
      .filter(([name]) => !registered.has(name))
      .map(([name, file]) => `${name} (${file})`);

    expect(
      missing,
      'мутатор экспортирован из index.ts, но не попал в MUTATION_FACTORIES — в реестре его нет, ' +
        `в tools/list тоже, и для модели такой возможности не существует: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('баррель действительно разбирается — опечатка в пути прошла бы вхолостую', () => {
    const exported = exportedMutations();
    expect(exported.size).toBeGreaterThan(3);
    // Обратная сторона: зарегистрировано ровно то, что баррель и объявляет.
    expect([...exported.keys()].sort()).toEqual(names());
  });

  it('в сборке нет ни одного дубля имени', () => {
    const built = tools();
    expect(new Set(built.map((tool) => tool.name)).size).toBe(built.length);
    expect(MUTATION_FACTORIES).toHaveLength(built.length);
  });

  it('имена доезжают до модели: ^[a-zA-Z0-9_-]{1,64}$ и ни одной точки (К7)', () => {
    for (const tool of tools()) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.name).not.toContain('.');
      // Реестр строже Messages API: он же требует snake_case вида <домен>_<действие>.
      expect(tool.name).toMatch(TOOL_NAME_RE);
    }
  });

  it('каждый объявлен как rw и объявляет хотя бы один эндпоинт', () => {
    for (const tool of tools()) {
      expect(tool.def.access, `${tool.name} обязан быть rw`).toBe('rw');
      expect(tool.endpoints.length, `${tool.name} не объявил ни одного эндпоинта`).toBeGreaterThan(
        0,
      );
    }
  });

  it('у каждого есть исполнитель и непустая сверка мира — иначе применение слепо', () => {
    for (const tool of tools()) {
      expect(typeof tool.apply, tool.name).toBe('function');
      expect(tool.guard.keys.length, `${tool.name}: пустой guard.keys молчит всегда`).toBeGreaterThan(
        0,
      );
    }
  });

  it('никакой скрытой общей памяти: две сборки дают разные объекты', () => {
    const first = tools();
    const second = tools();
    expect(first[0]).not.toBe(second[0]);
    expect(first.map((tool) => tool.name)).toEqual(second.map((tool) => tool.name));
  });
});

describe('registerMutations', () => {
  it('в режиме ro реестр не показывает НИ ОДНОГО мутатора — ни человеку, ни боту', () => {
    const registry = createRegistry([]);
    registerMutations(registry, makeWorld().deps);

    // Список берётся из сборки, а не переписан сюда именами: седьмой мутатор
    // попадает под эту проверку сам, без чьей-либо памяти.
    expect(registry.list({ mode: 'ro', profile: 'human' })).toEqual([]);
    expect(registry.list({ mode: 'ro', profile: 'bot' })).toEqual([]);
  });

  it('в режиме rw профиль human видит их все', () => {
    const registry = createRegistry([]);
    registerMutations(registry, makeWorld().deps);
    expect(registry.list({ mode: 'rw', profile: 'human' }).map((def) => def.name).sort()).toEqual(
      names(),
    );
  });

  it('боту сегодня не открыт ни один из них, и это решают сами инструменты', () => {
    // Не «так вышло»: каждый мутатор объявляет profiles: ['human'] со своей
    // причиной (revoke рвёт подключение, POST /admin/user — неограниченный
    // UPDATE карточки клиента, деньги — это деньги). Тест держит границу на
    // виду: когда боту откроют первый инструмент, он упадёт и потребует
    // сказать об этом вслух.
    const registry = createRegistry([]);
    registerMutations(registry, makeWorld().deps);
    expect(registry.list({ mode: 'rw', profile: 'bot' })).toEqual([]);
    for (const tool of tools()) expect(tool.def.profiles).toContain('human');
  });

  it('повторная регистрация того же имени — ошибка, а не тихая подмена', () => {
    const registry = createRegistry([]);
    registerMutations(registry, makeWorld().deps);
    expect(() => {
      registerMutations(registry, makeWorld().deps);
    }).toThrow(/already registered/);
  });
});
