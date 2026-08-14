import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    // Тесты гоняются по ИСХОДНИКАМ пакетов: без алиасов node-резолв увёл бы
    // импорт в dist/index.js, которого до `pnpm build` не существует.
    // Здесь перечислены ВСЕ 14 пакетов канона, включая те, что появятся в
    // планах 2 и 3 — этот файл заполняется один раз и больше не правится.
    alias: {
      '@hq/types': pkg('./packages/types/src/index.ts'),
      '@hq/env': pkg('./packages/env/src/index.ts'),
      '@hq/redact': pkg('./packages/redact/src/index.ts'),
      '@hq/budget': pkg('./packages/budget/src/index.ts'),
      '@hq/shm': pkg('./packages/shm/src/index.ts'),
      '@hq/remna': pkg('./packages/remna/src/index.ts'),
      '@hq/registry': pkg('./packages/registry/src/index.ts'),
      '@hq/exec': pkg('./packages/exec/src/index.ts'),
      '@hq/audit': pkg('./packages/audit/src/index.ts'),
      '@hq/confirm': pkg('./packages/confirm/src/index.ts'),
      '@hq/idempotency': pkg('./packages/idempotency/src/index.ts'),
      '@hq/runtime': pkg('./packages/runtime/src/index.ts'),
      '@hq/tools-read': pkg('./tools/read/src/index.ts'),
      '@hq/tools-mutations': pkg('./tools/mutations/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'tools/**/*.test.ts',
      'apps/**/*.test.ts',
    ],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './reports/junit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'apps/*/src/**', 'tools/*/src/**'],
      exclude: ['**/*.test.ts', '**/dist/**', '**/testkit.ts'],
    },
  },
});
