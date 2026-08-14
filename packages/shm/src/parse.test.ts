import { describe, expect, it } from 'vitest';
import {
  ShmError,
  buildBasicAuth,
  dataTruthyGuard,
  isHtmlBody,
  isRetryableStatus,
  toShmListResult,
  unwrapShm,
} from './parse.js';

describe('unwrapShm', () => {
  it('peels the data envelope and leaves anything else alone', () => {
    expect(unwrapShm({ data: [1, 2] })).toEqual([1, 2]);
    expect(unwrapShm([1, 2])).toEqual([1, 2]);
    expect(unwrapShm({ id: 7 })).toEqual({ id: 7 });
    expect(unwrapShm(undefined)).toBeUndefined();
  });

  it('peels exactly one level, never recursing into a nested data key', () => {
    // /user/pay/paysystems nests its array one extra level inside data[0];
    // unwrapShm must leave that inner envelope untouched for the caller to peel.
    expect(unwrapShm({ data: { data: [1, 2] } })).toEqual({ data: [1, 2] });
  });
});

describe('dataTruthyGuard', () => {
  it('treats an empty body as success for action endpoints', () => {
    expect(dataTruthyGuard(undefined)).toBeUndefined();
  });

  it('rejects the 200 + {data:[null]} false success', () => {
    let caught: unknown;
    try {
      dataTruthyGuard({ data: [null] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ShmError);
    const err = caught as ShmError;
    expect(err.status).toBe(200);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('no-op');
  });

  it('rejects an empty data array and other falsy scalars', () => {
    expect(() => dataTruthyGuard({ data: [] })).toThrow(ShmError);
    expect(() => dataTruthyGuard({ data: 0 })).toThrow(ShmError);
    expect(() => dataTruthyGuard({ data: '' })).toThrow(ShmError);
  });

  it('passes real payloads through untouched', () => {
    expect(dataTruthyGuard({ data: [{ id: 42 }] })).toEqual([{ id: 42 }]);
    expect(dataTruthyGuard({ data: 5 })).toBe(5);
  });
});

describe('isHtmlBody', () => {
  it('detects the no-rights HTML page SHM serves with status 200', () => {
    expect(isHtmlBody('<!DOCTYPE html><html><body>login</body></html>')).toBe(true);
    expect(isHtmlBody('  \n<html lang="ru">')).toBe(true);
    expect(isHtmlBody('{"data":[]}')).toBe(false);
    expect(isHtmlBody('')).toBe(false);
  });
});

describe('buildBasicAuth', () => {
  it('encodes login:password and passes a ready header through', () => {
    expect(buildBasicAuth('mcp:secret')).toBe(`Basic ${Buffer.from('mcp:secret').toString('base64')}`);
    expect(buildBasicAuth('Basic abc123')).toBe('Basic abc123');
    expect(buildBasicAuth('  basic abc123 ')).toBe('basic abc123');
    expect(buildBasicAuth('')).toBe('');
  });
});

describe('toShmListResult', () => {
  it('keeps items/limit/offset from the envelope', () => {
    const result = toShmListResult<{ id: number }>(
      { data: [{ id: 1 }, { id: 2 }], items: 8123, limit: 25, offset: 50 },
      25,
      50,
    );
    expect(result).toEqual({ items: 8123, limit: 25, offset: 50, data: [{ id: 1 }, { id: 2 }] });
  });

  it('falls back to the requested paging when the envelope has none', () => {
    expect(toShmListResult([{ id: 1 }], 25, 0)).toEqual({
      items: 1,
      limit: 25,
      offset: 0,
      data: [{ id: 1 }],
    });
  });

  it('normalises a scalar and an empty body into an array', () => {
    expect(toShmListResult({ data: { id: 1 } }, 25, 0).data).toEqual([{ id: 1 }]);
    expect(toShmListResult(undefined, 25, 0).data).toEqual([]);
  });
});

describe('isRetryableStatus', () => {
  it('is true only for the 3-second write lock', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(429)).toBe(false);
    expect(isRetryableStatus(500)).toBe(false);
  });
});
