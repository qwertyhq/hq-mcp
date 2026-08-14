import { describe, expect, it } from 'vitest';
import { maskAuth, maskSecret, safeUrlLabel } from './mask.js';

describe('maskSecret', () => {
  it('leaves enough to recognise a value and not enough to reuse it', () => {
    const masked = maskSecret('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(masked).toBe('abc…789');
    expect(masked).not.toContain('defghij');
  });

  it('hides a short value completely, because six of its characters are most of it', () => {
    expect(maskSecret('short')).toBe('••••••••');
    expect(maskSecret('short')).not.toContain('sho');
  });

  it('says "empty" instead of printing nothing at all', () => {
    expect(maskSecret('   ')).toBe('(empty)');
  });
});

describe('maskAuth', () => {
  it('keeps the login readable and the password entirely hidden', () => {
    expect(maskAuth('operator:example-secret-value')).toBe('operator:••••••••');
  });

  it('treats a ready Basic header as one secret, because that is what it is', () => {
    const masked = maskAuth('Basic b3BlcmF0b3I6ZXhhbXBsZS1zZWNyZXQ=');
    expect(masked.startsWith('Basic ')).toBe(true);
    expect(masked).not.toContain('b3BlcmF0b3I6ZXhhbXBsZS1zZWNyZXQ=');
  });

  it('falls back to a full mask when there is no login to show', () => {
    expect(maskAuth('single-value-no-colon')).toBe('sin…lon');
  });
});

describe('safeUrlLabel', () => {
  it('drops the query, where a pasted token would end up', () => {
    expect(safeUrlLabel('https://panel.example.com/api?token=example-secret-value')).toBe(
      'https://panel.example.com/api',
    );
  });

  it('drops credentials embedded in the authority', () => {
    const label = safeUrlLabel('https://operator:example-secret@billing.example.com/shm/v1');
    expect(label).toBe('https://billing.example.com/shm/v1');
    expect(label).not.toContain('example-secret');
  });

  it('refuses to echo something it could not parse', () => {
    expect(safeUrlLabel('panel.example.com?token=example-secret-value')).toBe('(unparseable URL)');
  });
});
