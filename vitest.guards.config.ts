import { defineConfig } from 'vitest/config';

/**
 * Committed config for `pnpm test:guards` — the safety-guard tests for
 * scripts/probe-stands.ts (production-host refusal, credential-leak
 * detection). Deliberately a SEPARATE config from vitest.config.ts, whose
 * `include` intentionally omits `scripts/**`: the brief requires the harness
 * (and its tests) stay out of `pnpm test`/CI. Without a committed config,
 * running these tests meant hand-building an ad-hoc one each time — a
 * safety-guard test nobody can actually run is write-only. This file exists
 * so `pnpm test:guards` is one documented, repeatable command instead.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts'],
  },
});
