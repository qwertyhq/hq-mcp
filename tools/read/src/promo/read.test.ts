import { describe, expect, it } from 'vitest';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { promoRead } from './read.js';

interface Code {
  id: string;
  idQuoted?: string;
  idLength?: number;
  whitespace?: string[];
  templateId: string | null;
  hasDefinitionRow: boolean;
  createdAt: string | null;
  amount: number | null;
  reusable: boolean | null;
  status: number | null;
  remaining: number | null;
  rows: number;
  redemptions: number;
  lastUsedAt: string | null;
  usedBy: number[];
}

interface Out {
  items: number | null;
  limit: number;
  rowsRead: number;
  matched: number;
  complete: boolean;
  scannedWholeTable: boolean;
  codes: Code[];
  whitespaceIds: string[];
  whitespaceSweepCoversWholeTable: boolean;
  warnings: Array<{ code: string; message: string }>;
  degraded: Array<{ system: string; error: string }>;
}

/**
 * Форма настоящей таблицы, снятая с работающей SHM. Одна строка — это ЛИБО сам
 * код (`used` пуст, `settings.quantity` — текущий остаток), ЛИБО одно его
 * применение (`used`/`used_by` заполнены, `user_id` равен применившему, а `quantity` —
 * снимок остатка на тот момент, то есть число ИЗ ПРОШЛОГО).
 */
const DEFINITION = {
  id: 'FREEWORM',
  created: '2026-07-29 20:18:23',
  expire: null,
  used: null,
  used_by: null,
  user_id: 1,
  template_id: 'add_bonus',
  settings: { amount: 150, count: 1, length: 10, prefix: 'PROMO_', quantity: 937, reusable: 1, status: 1 },
};

function redemption(userId: number, used: string, quantity: number): Record<string, unknown> {
  return {
    id: 'FREEWORM',
    created: used,
    expire: null,
    used,
    used_by: userId,
    user_id: userId,
    template_id: 'add_bonus',
    settings: { amount: 150, quantity, reusable: 1, status: 1 },
  };
}

const ROWS = [
  DEFINITION,
  redemption(41, '2026-07-29 20:39:35', 1000),
  redemption(42, '2026-08-02 19:40:56', 939),
  redemption(43, '2026-08-10 12:06:51', 938),
];

type Answer = (path: string, params?: Record<string, string | number | undefined>) => unknown;

function run(
  input: Record<string, unknown>,
  answer: Answer,
  calls: StubCall[] = [],
): Promise<Out> {
  const ctx = makeCtx({ calls, shmList: (path, params) => answer(path, params) });
  const parsed = promoRead.input.parse(input);
  return promoRead.handler(parsed, ctx) as Promise<Out>;
}

function codes(out: Out): string[] {
  return out.warnings.map((one) => one.code).sort();
}

/** Отвечает только на точный фильтр по id; всё остальное — вся таблица. */
function table(rows: Record<string, unknown>[]): Answer {
  return (path, params) => {
    const filter = params?.filter;
    if (typeof filter === 'string') {
      const wanted = (JSON.parse(filter) as { id?: string }).id;
      return rows.filter((row) => row.id === wanted);
    }
    if (params?.user_id !== undefined) {
      return rows.filter((row) => row.user_id === params.user_id);
    }
    return rows;
  };
}

describe('promo_read', () => {
  it('reads the remaining count off the code row, never off a redemption snapshot', async () => {
    const out = await run({ code: 'FREEWORM' }, table(ROWS));
    const code = out.codes[0];
    expect(code?.id).toBe('FREEWORM');
    expect(code?.hasDefinitionRow).toBe(true);
    // 937 — строка-определение. Самое свежее применение несёт 938, и подстановка
    // его сюда объявила бы вчерашний остаток сегодняшним.
    expect(code?.remaining).toBe(937);
    expect(code?.rows).toBe(4);
    expect(code?.redemptions).toBe(3);
    expect(code?.usedBy).toEqual([41, 42, 43]);
    expect(code?.lastUsedAt).toBe('2026-08-10 12:06:51');
    expect(code?.amount).toBe(150);
    expect(code?.reusable).toBe(true);
    expect(code?.status).toBe(1);
  });

  it('leaves the remaining count unknown when no code row was read', async () => {
    const out = await run({ code: 'FREEWORM' }, table(ROWS.slice(1)));
    expect(out.codes[0]?.hasDefinitionRow).toBe(false);
    expect(out.codes[0]?.remaining).toBeNull();
    expect(out.codes[0]?.redemptions).toBe(3);
  });

  /**
   * Записанный отказ из работающей установки: родная админка SHM не тримит код
   * на создании, в базу легли строки с ведущими пробелами (` FREEWORM`),
   * коллация считает ведущий пробел значимым — и клиент получает «промокод не
   * найден» на существующей строке.
   */
  it('flags an identifier with invisible characters instead of returning the row silently', async () => {
    const rows = [{ ...DEFINITION, id: ' FREEWORM' }];
    const out = await run({}, table(rows));
    const code = out.codes[0];
    expect(code?.id).toBe(' FREEWORM');
    expect(code?.idQuoted).toBe('[ FREEWORM]');
    expect(code?.idLength).toBe(9);
    expect(code?.whitespace).toEqual(['leading']);
    expect(out.whitespaceIds).toEqual([' FREEWORM']);
    expect(codes(out)).toContain('promo_id_has_whitespace');
  });

  it('tells leading, trailing and embedded apart, and sees zero-width characters too', async () => {
    const rows = [
      { ...DEFINITION, id: 'TRAIL ' },
      { ...DEFINITION, id: 'MID DLE' },
      { ...DEFINITION, id: 'ZERO​WIDTH' },
      { ...DEFINITION, id: 'CLEAN' },
    ];
    const out = await run({}, table(rows));
    const found = new Map(out.codes.map((one) => [one.id, one.whitespace]));
    expect(found.get('TRAIL ')).toEqual(['trailing']);
    expect(found.get('MID DLE')).toEqual(['embedded']);
    expect(found.get('ZERO​WIDTH')).toEqual(['embedded']);
    expect(found.get('CLEAN')).toBeUndefined();
    expect(out.whitespaceIds).toHaveLength(3);
  });

  /**
   * Точный фильтр по id — действительно точный (проверено на работающей SHM:
   * filter={"id":"IC%"} отдал ноль строк), поэтому код с пробелом им не
   * находится вовсе. Пустой ответ здесь ОБЯЗАН превратиться во второе чтение,
   * а не в «такого кода нет».
   */
  it('does not answer "no such code" on an exact-filter miss until the table was scanned', async () => {
    const calls: StubCall[] = [];
    const out = await run({ code: 'FREEWORM' }, table([{ ...DEFINITION, id: ' FREEWORM' }]), calls);
    expect(out.scannedWholeTable).toBe(true);
    expect(out.codes[0]?.id).toBe(' FREEWORM');
    expect(codes(out)).toEqual(['promo_code_matched_after_normalizing', 'promo_id_has_whitespace']);
    expect(codes(out)).not.toContain('promo_code_not_found');
    // Два чтения: точный фильтр, затем таблица без фильтра.
    expect(calls.filter((one) => one.path === '/admin/promo')).toHaveLength(2);
  });

  it('matches through a zero-width character and a case difference alike', async () => {
    const out = await run({ code: 'freeworm' }, table([{ ...DEFINITION, id: 'FREE​WORM' }]));
    expect(out.codes[0]?.id).toBe('FREE​WORM');
    expect(codes(out)).toContain('promo_code_matched_after_normalizing');
  });

  it('says not found only after a complete scan, and says the scan was complete', async () => {
    const out = await run({ code: 'NOSUCH' }, table(ROWS));
    expect(out.codes).toEqual([]);
    expect(out.scannedWholeTable).toBe(true);
    const warning = out.warnings.find((one) => one.code === 'promo_code_not_found');
    expect(warning?.message).toContain('the whole table');
  });

  it('suppresses the not-found finding when the read failed rather than computing it', async () => {
    const out = await run({ code: 'NOSUCH' }, () => {
      throw new Error('shm down');
    });
    expect(codes(out)).toEqual(['partial_result']);
    expect(out.degraded).toEqual([{ system: 'shm', error: 'shm down' }]);
    expect(out.whitespaceSweepCoversWholeTable).toBe(false);
  });

  it('reports an exhausted code as used up, not as missing', async () => {
    const rows = [{ ...DEFINITION, id: '900', settings: { ...DEFINITION.settings, quantity: 0 } }];
    const out = await run({ code: '900' }, table(rows));
    expect(out.codes[0]?.remaining).toBe(0);
    expect(codes(out)).toContain('promo_code_exhausted');
  });

  it('surfaces the server-side row count and warns that the counts are about the slice', async () => {
    const out = await run({ limit: 2 }, () => ({ items: 312, limit: 2, offset: 0, data: ROWS.slice(0, 2) }));
    expect(out.items).toBe(312);
    expect(out.rowsRead).toBe(2);
    expect(out.complete).toBe(false);
    expect(out.whitespaceSweepCoversWholeTable).toBe(false);
    const warning = out.warnings.find((one) => one.code === 'truncated');
    expect(warning?.message).toContain('312');
  });

  /**
   * Владелец строки применения — не всегда применивший: в работающей
   * установке заметная доля строк применения принадлежит админу (user_id = 1),
   * а клиент назван только в used_by. Серверный фильтр по user_id такие строки
   * не находит, и ответ «этот клиент промокодов не применял» был бы неправдой.
   */
  it('finds a redemption whose row belongs to the admin, not to the redeemer', async () => {
    const rows = [
      DEFINITION,
      { ...redemption(41, '2026-07-29 20:39:35', 1000), user_id: 1 },
      redemption(42, '2026-08-02 19:40:56', 939),
    ];
    const out = await run({ user_id: 41 }, table(rows));
    expect(out.matched).toBe(1);
    expect(out.codes[0]?.usedBy).toEqual([41]);
    expect(out.rowsRead).toBe(3);
  });

  it('does not ask the server to filter by user at all', async () => {
    const calls: StubCall[] = [];
    await run({ user_id: 41 }, table(ROWS), calls);
    expect(calls[0]?.params).not.toHaveProperty('user_id');
    expect(calls[0]?.params).not.toHaveProperty('filter');
  });

  it('sends the exact id filter, and lets the code win over the user', async () => {
    const calls: StubCall[] = [];
    await run({ code: 'FREEWORM', user_id: 41 }, table(ROWS), calls);
    expect(calls[0]?.params).toMatchObject({ filter: JSON.stringify({ id: 'FREEWORM' }) });
    expect(calls[0]?.params).not.toHaveProperty('user_id');
  });
});
