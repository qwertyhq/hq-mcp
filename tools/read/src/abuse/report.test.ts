import { beforeEach, describe, expect, it } from 'vitest';
import { createRegistry } from '@hq/registry';
import { executeTool } from '@hq/exec';
import type { TunnelConfig } from '@hq/types';
import type { StubCall } from '../testkit.js';
import { makeCtx } from '../testkit.js';
import { ABUSE_BUDGET, createAbuseReportTool, resetAbuseBudget } from './report.js';

const tunnel: TunnelConfig = {
  abuseUrl: 'http://127.0.0.1:18099',
  postgres: { host: '127.0.0.1', port: 16767 },
  mysql: null,
  sshCommand: 'ssh -L 18099:192.0.2.10:8099 -L 16767:192.0.2.20:6767 jump-host',
  abuseToken: 'guard-secret',
};

interface AbuseOut {
  report: Record<string, unknown>;
  topDevices: unknown[];
  stats: Record<string, unknown>;
  warnings: Array<{ code: string }>;
  degraded: Array<{ system: string; error: string }>;
}

const okFetch = (): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ shared_devices: [] }), {
      status: 200,
    })) as unknown as typeof fetch;

/** Текст отказа целиком: часть проверок здесь — про то, чего в нём быть НЕ должно. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to be refused, but it resolved');
}

describe('abuse_report', () => {
  beforeEach(() => {
    resetAbuseBudget();
  });

  it('refuses with the exact ssh command instead of hanging when the tunnel is closed', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:18099');
    }) as unknown as typeof fetch;
    const tool = createAbuseReportTool(tunnel, { fetchImpl });
    const ctx = makeCtx({ remnaGet: () => [] });
    await expect(tool.handler({}, ctx)).rejects.toThrow(/ssh -L 18099:192\.0\.2\.10:8099/);
  });

  it('blames the token, not the tunnel, when the hook answers 403', async () => {
    // guard-hook.py:260-262 — GET /report закрыт заголовком X-Guard-Token.
    // Ответ «туннель закрыт» здесь отправляет оператора чинить исправное.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: 403, msg: 'forbidden' }), {
        status: 403,
      })) as unknown as typeof fetch;
    const tool = createAbuseReportTool(tunnel, { fetchImpl });
    const ctx = makeCtx({ remnaGet: () => [] });
    const message = await refusal(tool.handler({}, ctx));
    expect(message).toContain('X-Guard-Token');
    expect(message).toContain('.guard-hook-secret');
    expect(message).not.toContain('ssh -L');
  });

  it('calls a timeout slow, not closed', async () => {
    // Отчёт собирается заново на каждый запрос неограниченными сканами по
    // рабочей MySQL — медленный ответ это норма, а не признак закрытого туннеля.
    const fetchImpl = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    const tool = createAbuseReportTool(tunnel, { fetchImpl });
    const ctx = makeCtx({ remnaGet: () => [] });
    const message = await refusal(tool.handler({}, ctx));
    expect(message).toMatch(/did not answer in time/i);
    expect(message).not.toContain('ssh -L');
  });

  it('does not call an external cancellation a timeout, nor blame the tunnel for it', async () => {
    // Отмена и таймаут — разные события: первое ничего не говорит ни о хуке,
    // ни о туннеле. Свалить её в любую из двух готовых веток значит повторить
    // ровно ту ошибку атрибуции, ради которой эти ветки и разделены.
    const fetchImpl = (async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const tool = createAbuseReportTool(tunnel, { fetchImpl });
    const ctx = makeCtx({ remnaGet: () => [] });
    const message = await refusal(tool.handler({}, ctx));
    expect(message).toMatch(/cancelled/i);
    expect(message).not.toMatch(/did not answer in time/i);
    expect(message).not.toContain('ssh -L');
  });

  it('shows the hook its own words on any other non-2xx', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    const tool = createAbuseReportTool(tunnel, { fetchImpl });
    const ctx = makeCtx({ remnaGet: () => [] });
    const message = await refusal(tool.handler({}, ctx));
    expect(message).toContain('502');
    expect(message).toContain('nope');
  });

  it('refuses before the call when no guard token is configured', async () => {
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const { abuseToken: _drop, ...withoutToken } = tunnel;
    const tool = createAbuseReportTool(withoutToken, { fetchImpl });
    const ctx = makeCtx({ remnaGet: () => [] });
    await expect(tool.handler({}, ctx)).rejects.toThrow(/HQ_MCP_GUARD_HOOK_TOKEN/);
    expect(fetched).toBe(0);
  });

  it('sends the guard token and asks for the report without a refresh parameter', async () => {
    // `?refresh=1` не существует: do_GET сравнивает только parsed.path
    // (guard-hook.py:256-258), query-строка отбрасывается, кэша нет вовсе.
    const seen: Array<{ url: string; token: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), token: headers.get('X-Guard-Token') });
      return new Response(JSON.stringify({ shared_devices: [{ hwid: 'h1' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const tool = createAbuseReportTool(tunnel, { fetchImpl });
    const ctx = makeCtx({ remnaGet: () => [] });
    await tool.handler({}, ctx);
    expect(seen[0]?.url).toBe('http://127.0.0.1:18099/report');
    expect(seen[0]?.token).toBe('guard-secret');
  });

  it('takes no refresh input at all', () => {
    const tool = createAbuseReportTool(tunnel, { fetchImpl: okFetch() });
    const shape = (tool.input as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toEqual([]);
  });

  it('joins the hook report with panel tops and degrades softly', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ shared_devices: [{ hwid: 'h1' }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const tool = createAbuseReportTool(tunnel, { fetchImpl });
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/system/stats') throw new Error('HTTP 404');
        return { users: [{ userUuid: 'u-1', devicesCount: 9 }], total: 1 };
      },
    });
    const result = (await tool.handler({}, ctx)) as AbuseOut;
    expect(result.report.shared_devices).toEqual([{ hwid: 'h1' }]);
    expect(result.topDevices).toEqual([{ userUuid: 'u-1', devicesCount: 9 }]);
    expect(result.degraded).toEqual([{ system: 'remna', error: 'HTTP 404' }]);
  });

  it('marks a degraded answer with partial_result, like the other ten tools that degrade', async () => {
    // `degraded` без предупреждения — это частичный ответ, который выглядит
    // полным: вызывающий, ключующийся на partial_result (а так делают все
    // остальные инструменты), у abuse_report его не находил.
    const tool = createAbuseReportTool(tunnel, { fetchImpl: okFetch() });
    const ctx = makeCtx({
      remnaGet: (path) => {
        if (path === '/api/system/stats') throw new Error('HTTP 404');
        return { users: [], total: 0 };
      },
    });
    const result = (await tool.handler({}, ctx)) as AbuseOut;
    expect(result.degraded).toHaveLength(1);
    expect(result.warnings.map((w) => w.code)).toContain('partial_result');
  });

  it('says nothing about partial results when both panel routes answered', async () => {
    const tool = createAbuseReportTool(tunnel, { fetchImpl: okFetch() });
    const ctx = makeCtx({ remnaGet: () => [] });
    const result = (await tool.handler({}, ctx)) as AbuseOut;
    expect(result.degraded).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('does not quote the JSON parse error, which carries the first bytes of the body', async () => {
    // V8 кладёт в текст SyntaxError первые ~10 символов разбираемой строки
    // (`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`). Тело этого
    // хука — логины, почтовые адреса и IP настоящих клиентов, а страховочная
    // стрижка исполнителя режет только по маркеру и такой фрагмент не видит вовсе.
    const fetchImpl = (async () =>
      new Response('gmail-of-a-real-client@example.test is sharing 9 devices', {
        status: 200,
      })) as unknown as typeof fetch;
    const tool = createAbuseReportTool(tunnel, { fetchImpl });
    const ctx = makeCtx({ remnaGet: () => [] });
    const message = await refusal(tool.handler({}, ctx));
    expect(message).toContain('not JSON');
    expect(message).not.toContain('gmail-of-a-real-client');
    expect(message).not.toMatch(/Unexpected token/i);
  });

  it('puts the hook body last so the safety strip cannot eat the operator hint', async () => {
    // Стрижка исполнителя режет ОТ маркера и до конца строки: тело, стоящее в
    // середине, уносит с собой всё, что написано после него. Проверяется через
    // executeTool, а не глазами — по-другому «подсказка пережила стрижку» не
    // утверждение, а надежда.
    const fetchImpl = (async () =>
      new Response('login=real.client@example.test ip=203.0.113.7', {
        status: 500,
      })) as unknown as typeof fetch;
    const registry = createRegistry([createAbuseReportTool(tunnel, { fetchImpl })]);
    const result = await executeTool('abuse_report', {}, { registry, ctx: makeCtx({ remnaGet: () => [] }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('build_report()');
    expect(result.message).toContain('guard-hook.py:264-267');
    expect(result.message).not.toContain('real.client@example.test');
    expect(result.message).not.toContain('203.0.113.7');
  });

  it('sends each panel route only the parameters it declares', async () => {
    // /api/system/stats объявляет parameters: [] в обоих дампах OpenAPI;
    // topNodesLimit/topUsersLimit — это семейство /api/bandwidth-stats/*.
    // /api/hwid/devices/top-users объявляет size и start, а не limit.
    const calls: StubCall[] = [];
    const tool = createAbuseReportTool(tunnel, { fetchImpl: okFetch() });
    const ctx = makeCtx({ calls, remnaGet: () => [] });
    await tool.handler({}, ctx);
    expect(calls.find((c) => c.path === '/api/system/stats')?.params).toBeUndefined();
    expect(calls.find((c) => c.path === '/api/hwid/devices/top-users')?.params).toEqual({
      size: 25,
      start: 0,
    });
  });

  it('refuses the bot profile in the handler, not only in the listing', async () => {
    const tool = createAbuseReportTool(tunnel, { fetchImpl: okFetch() });
    const ctx = makeCtx({ profile: 'bot', remnaGet: () => [] });
    await expect(tool.handler({}, ctx)).rejects.toThrow(/human/);
  });

  it('gates the expensive rebuild through a budget of its own', async () => {
    const tool = createAbuseReportTool(tunnel, { fetchImpl: okFetch() });
    const ctx = makeCtx({ remnaGet: () => [] });
    for (let i = 0; i < ABUSE_BUDGET.limit; i += 1) {
      await tool.handler({}, ctx);
    }
    await expect(tool.handler({}, ctx)).rejects.toThrow(/budget/i);
  });

  it('is a human-only read-only tool that stays visible with the tunnel closed', () => {
    // requires:['tunnel.abuse'] прятал бы инструмент ровно в том состоянии,
    // ради объяснения которого он и написан: probe ставит возможности жёсткий
    // false, и Registry.list выбрасывает инструмент из tools/list.
    const tool = createAbuseReportTool(tunnel, { fetchImpl: okFetch() });
    expect(tool.profiles).toEqual(['human']);
    expect(tool.access).toBe('ro');
    expect(tool.requires).toBeUndefined();
  });
});
