import { describe, expect, it } from 'vitest';
import { checkRemna, checkShm } from './checks.js';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

function stubFetch(
  reply: (recorded: Recorded) => { status: number; body: string; headers?: Record<string, string> },
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect,
    };
    calls.push(recorded);
    const { status, body, headers } = reply(recorded);
    return new Response(body, { status, ...(headers === undefined ? {} : { headers }) });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function throwingFetch(error: Error): typeof fetch {
  return (() => Promise.reject(error)) as unknown as typeof fetch;
}

function transportError(code: string): Error {
  const error = new TypeError('fetch failed');
  (error as { cause?: unknown }).cause = { code };
  return error;
}

const SHM = { baseUrl: 'https://billing.example.com/shm/v1', auth: 'operator:hunter2' };
const REMNA = { baseUrl: 'https://panel.example.com', token: 'jwt-token-value-here' };

describe('checkShm', () => {
  it('accepts an admin answer in the SHM envelope and reports the server timezone', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ TZ: 'Asia/Tbilisi', data: [{ id: 1 }], items: 1 }),
    }));
    const result = await checkShm(SHM, { fetchImpl });

    expect(result.status).toBe('ok');
    expect(result.serverTz).toBe('Asia/Tbilisi');
    expect(calls[0]?.url).toBe('https://billing.example.com/shm/v1/admin/user?limit=1');
    // Проверка обязана идти ТЕМ ЖЕ заголовком, который потом соберёт клиент.
    expect(calls[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from('operator:hunter2', 'utf8').toString('base64')}`,
    );
    // Редирект — сам по себе ответ, а не дорога: за ним заголовок не уезжает.
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('separates "credentials rejected" from "server down" and never echoes the password', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 401,
      body: JSON.stringify({ msg: 'Not authorized', status: 401 }),
    }));
    const result = await checkShm(SHM, { fetchImpl });

    expect(result.status).toBe('rejected');
    expect(result.message).toContain('it is up');
    expect(result.message).toContain('throttles an IP');
    expect(result.message).not.toContain('hunter2');
  });

  it('reports an unreachable host by what the transport said, not by guessing', async () => {
    const result = await checkShm(SHM, { fetchImpl: throwingFetch(transportError('ENOTFOUND')) });

    expect(result.status).toBe('unreachable');
    expect(result.message).toContain('DNS does not resolve');
    expect(result.serverTz).toBeNull();
  });

  it('reads a timeout as unreachable rather than as a bad password', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const result = await checkShm(SHM, { fetchImpl: throwingFetch(timeout) });

    expect(result.status).toBe('unreachable');
    expect(result.message).toContain('timed out');
  });

  it('reads 404 as a wrong base URL and says which segment is missing', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404, body: '{"error":"not found"}' }));
    const result = await checkShm(SHM, { fetchImpl });

    expect(result.status).toBe('wrong_endpoint');
    expect(result.message).toContain('/shm/v1');
  });

  it('does not blame the credentials for a 502', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 502, body: 'bad gateway' }));
    const result = await checkShm(SHM, { fetchImpl });

    expect(result.status).toBe('unverified');
    expect(result.message).toContain('nothing about the credentials was proven');
  });

  it('refuses a 200 that is not the SHM envelope instead of calling it a success', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const result = await checkShm(SHM, { fetchImpl });

    expect(result.status).toBe('unverified');
  });

  it('names the redirect target instead of following it', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 302,
      body: '',
      headers: { location: 'https://billing.example.com/login?back=%2Fadmin' },
    }));
    const result = await checkShm(SHM, { fetchImpl });

    expect(result.status).toBe('wrong_endpoint');
    expect(result.message).toContain('https://billing.example.com/login');
    // Query отрезан: в него человек мог вклеить что угодно, включая секрет.
    expect(result.message).not.toContain('back=');
  });

  it('calls an HTML page what it is instead of parsing it', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: '<!doctype html><html><body>login</body></html>',
    }));
    const result = await checkShm(SHM, { fetchImpl });

    expect(result.status).toBe('wrong_endpoint');
    expect(result.message).toContain('HTML page');
  });
});

describe('checkRemna', () => {
  it('accepts the panel health envelope and sends the token as a bearer', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ response: { runtimeMetrics: [] } }),
    }));
    const result = await checkRemna(REMNA, { fetchImpl });

    expect(result.status).toBe('ok');
    expect(calls[0]?.url).toBe('https://panel.example.com/api/system/health');
    expect(calls[0]?.headers.Authorization).toBe('Bearer jwt-token-value-here');
  });

  it('reads 401 as a rejected token — the route needs auth, so it is up if it answered', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 401,
      body: JSON.stringify({ message: 'Unauthorized', statusCode: 401 }),
    }));
    const result = await checkRemna(REMNA, { fetchImpl });

    expect(result.status).toBe('rejected');
    expect(result.message).toContain('it is up');
    expect(result.message).toContain('API role');
    expect(result.message).not.toContain('jwt-token-value-here');
  });

  it('reads a refused connection as unreachable, not as a rejected token', async () => {
    const result = await checkRemna(REMNA, {
      fetchImpl: throwingFetch(transportError('ECONNREFUSED')),
    });

    expect(result.status).toBe('unreachable');
    expect(result.message).toContain('nothing listens');
  });

  it('explains an expired certificate instead of reporting a generic failure', async () => {
    const result = await checkRemna(REMNA, {
      fetchImpl: throwingFetch(transportError('CERT_HAS_EXPIRED')),
    });

    expect(result.status).toBe('unreachable');
    expect(result.message).toContain('certificate has expired');
  });

  it('reads 404 as the wrong root rather than as a missing capability', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404, body: '{"message":"Cannot GET"}' }));
    const result = await checkRemna(REMNA, { fetchImpl });

    expect(result.status).toBe('wrong_endpoint');
    expect(result.message).toContain('panel root with no path');
  });

  it('keeps a token pasted into the URL out of the message', async () => {
    const result = await checkRemna(
      { baseUrl: 'https://panel.example.com/?token=supersecretvalue', token: 'x' },
      { fetchImpl: throwingFetch(transportError('ENOTFOUND')) },
    );

    expect(result.message).not.toContain('supersecretvalue');
  });
});
