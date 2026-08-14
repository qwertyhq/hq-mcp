import { describe, expect, it } from 'vitest';
import {
  MAX_TOOL_BUCKETS,
  Metrics,
  UNKNOWN_CLIENT_BUCKET,
  UNKNOWN_TOOL_BUCKET,
} from './metrics.js';
import type { MetricOutcome } from './metrics.js';

function clock(values: string[]): () => Date {
  let index = 0;
  return () =>
    new Date(values[Math.min(index++, values.length - 1)] ?? values[0] ?? '2026-08-08T00:00:00.000Z');
}

const fixed = (): (() => Date) => (): Date => new Date('2026-08-08T12:00:00.000Z');

describe('Metrics', () => {
  it('раскладывает исходы по счётчикам', () => {
    const m = new Metrics({ now: fixed() });
    m.noteCall('client_overview', 'ok');
    m.noteCall('client_overview', 'ok');
    m.noteCall('client_overview', 'invalid_input');
    m.noteCall('platform_probe', 'budget');
    m.noteCall('spool_inspect', 'handler_failed');
    m.noteCall('spool_inspect', 'handler_failed');

    const snap = m.snapshot();
    expect(snap.totals).toEqual({ calls: 6, ok: 2, notFound: 0, invalidInput: 1, budget: 1, failed: 2 });
    expect(snap.byTool['client_overview']).toEqual({
      calls: 3,
      ok: 2,
      notFound: 0,
      invalidInput: 1,
      budget: 0,
      failed: 0,
    });
    expect(snap.byTool['platform_probe']?.budget).toBe(1);
    expect(snap.byTool['spool_inspect']?.failed).toBe(2);
  });

  it('принимает ровно ToolOutcome из @hq/exec плюс budget, и ничего сверх', () => {
    // Компиляционный контракт К20: свой словарь исходов транспорт не заводит.
    const outcomes: MetricOutcome[] = ['ok', 'not_found', 'invalid_input', 'handler_failed', 'budget'];
    const m = new Metrics({ now: fixed() });
    for (const outcome of outcomes) m.noteCall('client_overview', outcome);
    const snap = m.snapshot();
    expect(snap.totals.calls).toBe(5);
    expect(snap.totals).toEqual({ calls: 5, ok: 1, notFound: 1, invalidInput: 1, budget: 1, failed: 1 });
  });

  it('считает аутентификацию отдельно', () => {
    const m = new Metrics({ now: fixed() });
    m.noteAuth(true);
    m.noteAuth(false);
    m.noteAuth(false);
    expect(m.snapshot().auth).toEqual({ ok: 1, rejected: 2 });
  });

  it('раскладывает вызовы по метке клиента — ради этого метки и заведены', () => {
    const m = new Metrics({ now: fixed() });
    m.noteCall('client_overview', 'ok', 'bot');
    m.noteCall('client_overview', 'ok', 'panel');
    m.noteCall('billing_ledger', 'budget', 'bot');
    m.noteCall('spool_inspect', 'ok');

    const snap = m.snapshot();
    expect(snap.byClient.bot).toEqual({ calls: 2, ok: 1, notFound: 0, invalidInput: 0, budget: 1, failed: 0 });
    expect(snap.byClient.panel?.ok).toBe(1);
    expect(snap.byClient[UNKNOWN_CLIENT_BUCKET]?.calls).toBe(1);
    expect(snap.totals.calls).toBe(4);
  });

  it('пустая метка не заводит собственный бакет', () => {
    const m = new Metrics({ now: fixed() });
    m.noteCall('client_overview', 'ok', '   ');
    expect(Object.keys(m.snapshot().byClient)).toEqual([UNKNOWN_CLIENT_BUCKET]);
  });

  it('перебор несуществующих имён не раздувает карту: всё в __unknown__', () => {
    const m = new Metrics({ now: fixed() });
    for (let i = 0; i < 500; i += 1) m.noteCall(`probe-${String(i)}`, 'not_found');
    const snap = m.snapshot();
    expect(Object.keys(snap.byTool)).toEqual([UNKNOWN_TOOL_BUCKET]);
    expect(snap.byTool[UNKNOWN_TOOL_BUCKET]?.notFound).toBe(500);
  });

  it('число бакетов ограничено сверху', () => {
    const m = new Metrics({ now: fixed() });
    for (let i = 0; i < MAX_TOOL_BUCKETS + 50; i += 1) m.noteCall(`tool-${String(i)}`, 'ok');
    expect(Object.keys(m.snapshot().byTool).length).toBeLessThanOrEqual(MAX_TOOL_BUCKETS + 1);
  });

  /**
   * Имя инструмента доезжает сюда от клиента раньше, чем реестр успевает сказать, что
   * такого имени нет: слот бюджета берётся предполётно (Task 8), и `POST /v1/tools/__proto__`
   * при исчерпанном ведре кладёт в карту ровно эту строку. На обычном `{}` присваивание
   * `out['__proto__'] = counters` не создаёт свойства вовсе — счётчик молча исчезает из
   * /metrics, то есть перебор становится невидимым ровно там, где его и надо видеть.
   */
  it('имя-ловушка __proto__ остаётся обычным ключом и доезжает до отчёта', () => {
    const m = new Metrics({ now: fixed() });
    m.noteCall('__proto__', 'budget', '__proto__');
    const snap = m.snapshot();
    expect(Object.keys(snap.byTool)).toEqual(['__proto__']);
    expect(snap.byTool['__proto__']?.budget).toBe(1);
    expect(JSON.stringify(snap.byTool)).toContain('"__proto__"');
    expect(JSON.stringify(snap.byClient)).toContain('"__proto__"');
    // Прототип карты не подменён: снапшот сериализуется, а не превращается в пустой {}.
    expect(Object.getPrototypeOf(snap.byTool)).toBeNull();
  });

  it('снапшот отдаёт копии: правка отчёта не правит счётчики', () => {
    const m = new Metrics({ now: fixed() });
    m.noteCall('client_overview', 'ok', 'bot');
    const first = m.snapshot();
    first.totals.calls = 999;
    const second = m.snapshot();
    expect(second.totals.calls).toBe(1);
    expect(second.byTool['client_overview']?.calls).toBe(1);
  });

  it('uptime детерминирован при инъекции времени', () => {
    const m = new Metrics({ now: clock(['2026-08-08T12:00:00.000Z', '2026-08-08T12:00:30.000Z']) });
    const snap = m.snapshot();
    expect(snap.startedAt).toBe('2026-08-08T12:00:00.000Z');
    expect(snap.uptimeMs).toBe(30_000);
  });
});
