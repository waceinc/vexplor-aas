import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@aas/core': pkg('./packages/aas-core/src/index.ts'),
      '@aas/aasx': pkg('./packages/aasx/src/index.ts'),
      '@aas/linter': pkg('./packages/linter/src/index.ts'),
      '@aas/store': pkg('./packages/store/src/index.ts'),
      '@aas/collector': pkg('./packages/collector/src/index.ts'),
      '@aas/opcua': pkg('./packages/opcua/src/index.ts'),
      '@aas/api': pkg('./apps/api/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.{ts,tsx}', 'apps/**/test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
