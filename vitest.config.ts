import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Path alias for the authoring UI shadcn kit (same as apps/web/vite.config.ts)
      '@/': pkg('./apps/web/src/drive/'),
      '@aas/core': pkg('./packages/aas-core/src/index.ts'),
      '@aas/aasx': pkg('./packages/aasx/src/index.ts'),
      '@aas/linter': pkg('./packages/linter/src/index.ts'),
      '@aas/store': pkg('./packages/store/src/index.ts'),
      '@aas/collector': pkg('./packages/collector/src/index.ts'),
      '@aas/opcua': pkg('./packages/opcua/src/index.ts'),
      '@aas/fieldbus': pkg('./packages/fieldbus/src/index.ts'),
      '@aas/edge': pkg('./packages/edge/src/index.ts'),
      '@aas/api': pkg('./apps/api/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.{ts,tsx}', 'apps/**/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Undo Node 25+'s built-in Web Storage shadowing jsdom's localStorage (tests/setup/web-storage.ts)
    setupFiles: ['tests/setup/web-storage.ts', 'tests/setup/browser-lang.ts'],
  },
});
