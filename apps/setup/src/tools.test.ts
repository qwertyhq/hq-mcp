import { describe, expect, it } from 'vitest';
import { countTools } from './tools.js';

const ENV: Record<string, string> = {
  SHM_BASE_URL: 'https://billing.example.com/shm/v1',
  SHM_ADMIN_AUTH: 'login:password',
  REMNA_BASE_URL: 'https://panel.example.com',
  REMNA_API_TOKEN: 'placeholder-token',
};

describe('countTools', () => {
  it('counts the real registry, so the rw warning cannot go stale', async () => {
    const counts = await countTools(ENV);

    expect(counts).not.toBeNull();
    expect(counts?.ro).toBeGreaterThan(0);
    expect(counts?.writers).toBeGreaterThan(0);
    // Единственная разница между режимами — инструменты с access: 'rw'.
    // Если это перестанет выполняться, предупреждение назовёт неверное число.
    expect(counts?.rw).toBe((counts?.ro ?? 0) + (counts?.writers ?? 0));
  });

  it('answers null instead of throwing, because the number is not the point of the question', async () => {
    await expect(countTools({ ...ENV, SHM_BASE_URL: 'not a url' })).resolves.toBeNull();
  });
});
