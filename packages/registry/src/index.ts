import { BACKENDS, CAPABILITIES } from '@hq/types';
import type {
  Access,
  Backend,
  BackendPresence,
  Capability,
  Profile,
  ProbeResult,
  ProbeStore,
  Risk,
  ToolContext,
  ToolDef,
} from '@hq/types';
import type { ZodType, output } from 'zod';

/**
 * Точка в имени запрещена: имя доезжает до модели через Messages API, где
 * действует ^[a-zA-Z0-9_-]{1,64}$, а клиент лишь префиксует mcp__<server>__.
 * Лимит длины — часть того же контракта: имя длиннее 64 символов принимающий
 * API отклонит сам, вне нашего контроля, и утащит с собой весь листинг
 * инструментов. `(?=.{1,64}$)` бьёт по общей длине до применения формата.
 */
export const TOOL_NAME_RE = /^(?=.{1,64}$)[a-z][a-z0-9]*_[a-z][a-z0-9_]*$/;

export interface ToolSpec<S extends ZodType, O> {
  name: string;
  description: string;
  input: S;
  access: Access;
  risk: Risk;
  profiles: Profile[];
  requires?: Capability[];
  /** Системы, без которых у инструмента нет ответа. См. `ToolDef.backends`. */
  backends?: readonly Backend[];
  handler: (input: output<S>, ctx: ToolContext) => Promise<O>;
}

/**
 * Стирает дженерики схемы и результата: `ToolDef<I>` контравариантен по входу
 * хендлера, поэтому разнотипные инструменты нельзя сложить в один `ToolDef[]`
 * без этого шага. Валидация входа остаётся честной — её делает executeTool.
 */
export function defineTool<S extends ZodType, O>(spec: ToolSpec<S, O>): ToolDef {
  return spec as unknown as ToolDef;
}

export function createProbeStore(initial: ProbeResult | null = null): ProbeStore {
  let value = initial;
  return {
    get: () => value,
    set: (next: ProbeResult) => {
      value = next;
    },
  };
}

export class Registry {
  private readonly defs = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (!TOOL_NAME_RE.test(def.name)) {
      throw new Error(
        `invalid tool name "${def.name}": expected "<domain>_<action>" in snake_case, no dots, ` +
          'at most 64 characters',
      );
    }
    if (this.defs.has(def.name)) {
      throw new Error(`tool "${def.name}" is already registered`);
    }
    if (def.profiles.length === 0) {
      throw new Error(`tool "${def.name}" declares no profiles and would be invisible everywhere`);
    }
    for (const capability of def.requires ?? []) {
      if (!(CAPABILITIES as readonly string[]).includes(capability)) {
        throw new Error(`tool "${def.name}" requires unknown capability "${capability}"`);
      }
    }
    for (const backend of def.backends ?? []) {
      if (!(BACKENDS as readonly string[]).includes(backend)) {
        throw new Error(`tool "${def.name}" declares unknown backend "${backend}"`);
      }
    }
    const input = def.input as unknown as { parse?: unknown; shape?: unknown };
    if (typeof input.parse !== 'function' || typeof input.shape !== 'object') {
      throw new Error(`tool "${def.name}" input must be a z.object() so MCP can publish a schema`);
    }
    this.defs.set(def.name, def);
  }

  /**
   * В режиме ro инструменты с access==='rw' НЕ возвращаются вовсе: сервер их не
   * регистрирует, модель не видит их в tools/list и не может вызвать (§4.2).
   * Гейт по probe: инструмент выпадает, только если его возможность проверена и
   * оказалась ложной. 'unknown' оставляет инструмент видимым — прятать полреестра
   * из-за неудавшейся проверки хуже, чем показать его с предупреждением (§9).
   *
   * ГЕЙТ ПО БЭКЕНДАМ — ТРЕТИЙ И САМЫЙ ЖЁСТКИЙ, И ПРИЧИНА У НЕГО ДРУГАЯ.
   *
   * `probe` описывает состояние ВРЕМЕННОЕ: возможность, не подтверждённая
   * сейчас, подтвердится после починки, и потому 'unknown' инструмент
   * оставляет. `backends` описывает РЕШЕНИЕ РАЗВЁРТЫВАНИЯ: сервер поднят против
   * одной системы, второй в этом процессе не появится никогда. Инструмент,
   * который в этой установке не может ответить ни разу за всю свою жизнь, — это
   * не «закрытый порт», а трата контекста модели и приглашение пробовать. Он
   * не показывается.
   *
   * Отсутствие `backends` в opts означает «не гейтить» — той же
   * договорённостью, что и у `probe`. Единственный путь, по которому модель
   * получает список, — `listVisibleTools`, и он берёт значение из `ctx.backends`,
   * где оно обязательно.
   */
  list(opts: {
    mode: Access;
    profile: Profile;
    probe?: ProbeResult;
    backends?: BackendPresence;
  }): ToolDef[] {
    return [...this.defs.values()]
      .filter((def) => def.profiles.includes(opts.profile))
      .filter((def) => opts.mode === 'rw' || def.access === 'ro')
      .filter((def) => {
        if (opts.backends === undefined) return true;
        return (def.backends ?? []).every((backend) => opts.backends?.[backend] === true);
      })
      .filter((def) => {
        if (opts.probe === undefined) return true;
        return (def.requires ?? []).every(
          (capability) => opts.probe?.capabilities[capability] !== false,
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Каких систем инструменту не хватает в ЭТОМ развёртывании. Пустой список —
   * дело не в них. Нужен исполнителю: «инструмент есть, но эта установка без
   * SHM» — единственный ответ, после которого оператор перестанет искать
   * опечатку в имени.
   */
  missingBackends(def: ToolDef, backends: BackendPresence): readonly Backend[] {
    return (def.backends ?? []).filter((backend) => !backends[backend]);
  }

  get(name: string): ToolDef | undefined {
    return this.defs.get(name);
  }
}

export function createRegistry(defs: ToolDef[]): Registry {
  const registry = new Registry();
  for (const def of defs) registry.register(def);
  return registry;
}

export { backendOfPath, backendsOfEndpoints } from './backends.js';
export {
  FORBIDDEN_RULES,
  MUTATING_GET_PATHS,
  REFUSAL_INSTRUCTIONS,
  assertNotForbidden,
  explainRefusal,
  matchForbidden,
  scanForbiddenLiterals,
} from './forbidden.js';
export type { ForbiddenRule } from './forbidden.js';
export { assertSafeTemplateName, templateKind } from './templateName.js';
export type { TemplateKind } from './templateName.js';
