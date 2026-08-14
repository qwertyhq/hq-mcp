import type { ToolOutcome } from '@hq/exec';

/**
 * Исходы, которые считает транспорт: весь `ToolOutcome` из `@hq/exec` (канон К20) плюс отказ
 * по бюджету. Своего `ToolOutcome` этот пакет не объявляет — `budget` дописывается сюда потому,
 * что предполётный слот берётся ДО `executeTool`, и исполнитель такого исхода не видит.
 */
export type MetricOutcome = ToolOutcome | 'budget';

export const UNKNOWN_TOOL_BUCKET = '__unknown__';
export const UNKNOWN_CLIENT_BUCKET = '__unlabelled__';
export const MAX_TOOL_BUCKETS = 128;

export interface ToolCounters {
  calls: number;
  ok: number;
  notFound: number;
  invalidInput: number;
  budget: number;
  failed: number;
}

export interface MetricsSnapshot {
  startedAt: string;
  uptimeMs: number;
  auth: { ok: number; rejected: number };
  totals: ToolCounters;
  byTool: Record<string, ToolCounters>;
  /** Разрез по метке из HQ_MCP_HTTP_TOKENS: видно, кто именно ходит — бот или панель. */
  byClient: Record<string, ToolCounters>;
}

function emptyCounters(): ToolCounters {
  return { calls: 0, ok: 0, notFound: 0, invalidInput: 0, budget: 0, failed: 0 };
}

/**
 * Карта отчёта строится без прототипа — по той же причине, что и в `stripDeep` из `@hq/exec`.
 * Имя инструмента приходит от клиента и попадает в бакет раньше, чем реестр скажет, что имени
 * нет: слот бюджета берётся предполётно, и отказ по бюджету считается за тем именем, которое
 * прислали. На обычном `{}` присваивание `out['__proto__'] = …` не создаёт свойства вовсе —
 * счётчик исчезает из /metrics молча, то есть перебор перестаёт быть виден ровно там, где его
 * и смотрят.
 */
function emptyBuckets(): Record<string, ToolCounters> {
  return Object.create(null) as Record<string, ToolCounters>;
}

export class Metrics {
  private readonly nowFn: () => Date;
  private readonly startedAt: Date;
  private authOk = 0;
  private authRejected = 0;
  private readonly totals: ToolCounters = emptyCounters();
  private readonly byTool = new Map<string, ToolCounters>();
  private readonly byClient = new Map<string, ToolCounters>();

  constructor(deps: { now?: () => Date } = {}) {
    this.nowFn = deps.now ?? ((): Date => new Date());
    this.startedAt = this.nowFn();
  }

  noteAuth(ok: boolean): void {
    if (ok) this.authOk += 1;
    else this.authRejected += 1;
  }

  noteCall(tool: string, outcome: MetricOutcome, client: string = UNKNOWN_CLIENT_BUCKET): void {
    const bucket = this.bucketFor(tool, outcome);
    const counters = this.byTool.get(bucket) ?? emptyCounters();
    this.byTool.set(bucket, counters);
    const clientBucket = client.trim() === '' ? UNKNOWN_CLIENT_BUCKET : client;
    const clientCounters = this.byClient.get(clientBucket) ?? emptyCounters();
    this.byClient.set(clientBucket, clientCounters);
    for (const target of [this.totals, counters, clientCounters]) {
      target.calls += 1;
      if (outcome === 'ok') target.ok += 1;
      else if (outcome === 'not_found') target.notFound += 1;
      else if (outcome === 'invalid_input') target.invalidInput += 1;
      else if (outcome === 'budget') target.budget += 1;
      else target.failed += 1;
    }
  }

  /**
   * Имена из not_found приходят от клиента и могут быть произвольными — держать по бакету на
   * каждое было бы утечкой памяти под перебором. Такие вызовы (и всё сверх MAX_TOOL_BUCKETS)
   * сваливаются в общий бакет.
   */
  private bucketFor(tool: string, outcome: MetricOutcome): string {
    if (outcome === 'not_found') return UNKNOWN_TOOL_BUCKET;
    if (this.byTool.has(tool)) return tool;
    if (this.byTool.size >= MAX_TOOL_BUCKETS) return UNKNOWN_TOOL_BUCKET;
    return tool;
  }

  snapshot(): MetricsSnapshot {
    const byTool = emptyBuckets();
    for (const [name, counters] of this.byTool) byTool[name] = { ...counters };
    const byClient = emptyBuckets();
    for (const [label, counters] of this.byClient) byClient[label] = { ...counters };
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Math.max(0, this.nowFn().getTime() - this.startedAt.getTime()),
      auth: { ok: this.authOk, rejected: this.authRejected },
      // Копия, а не сам счётчик: снапшот уезжает в обработчик /metrics, и правка отчёта
      // не должна править то, что считает сервер.
      totals: { ...this.totals },
      byTool,
      byClient,
    };
  }
}
