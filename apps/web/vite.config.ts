import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dev server proxies to the API (@aas/api).
 * Following the principle that the browser does not parse AASX (plan VIII — with manuals inside a file reaches hundreds of MB),
 * files are only uploaded and all interpretation happens on the server.
 *
 * Important: do not list paths one by one — `/rules`, `/policy` and `/opcua-status` were missing, so in dev mode
 *    the welcome screen showed an "Unexpected token '<'" error bar and the Rules screen was empty (measured 2026-09-09).
 *    One regex captures the top-level paths the API serves. When a new path is added to the server, add it here too.
 * Important: the target is 127.0.0.1 — on Windows `localhost` resolves to ::1 first, while the protected-mode API binds to IPv4.
 */
/**
 * Important: the target can be changed with `AAS_API_URL`. On this PC the installed build (VEXPLOR AAS Studio) uses 8080,
 *    so the dev API sometimes has to run on another port (2026-09-30 — the dev screen attached to the installed build and data got mixed).
 * Important: `bundles` (open reference bundle) was added — without it, opening a bundle returns 404 only in the dev build.
 * Important: `auth` (login, sign-up, account) was added — without it the dev build's welcome screen falls back to token entry instead of account login (2026-10-13).
 * Important: `integrations` (MES / ERP / CMMS feed, subscriptions, exports) was added — the per-package paths live under `packages` already.
 */
const API_TARGET = process.env['AAS_API_URL'] ?? 'http://127.0.0.1:8080';
const API_PATHS =
  '^/(packages|bundles|description|health|auth|rules|policy|opcua|opcua-status|collect-status|registry-conflicts|integrations)(?=/|$|\\?)';
const API_PROXY = { [API_PATHS]: API_TARGET };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Path alias used by the shadcn kit (src/drive) — same as Logic Studio (`@/lib/cn` · `@/ui/kit/…` · `@/hooks/…`)
  resolve: { alias: { '@': fileURLToPath(new URL('./src/drive', import.meta.url)) } },
  server: { port: 5173, proxy: API_PROXY },
  preview: { port: 4173, proxy: API_PROXY },
});
