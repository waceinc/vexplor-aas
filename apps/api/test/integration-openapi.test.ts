/**
 * docs/openapi/integration.yaml documents exactly the integration routes the server has (design §4.8).
 *
 * Integration routes = every pattern under `/integrations` plus the two per-package paths
 * (`/packages/:packageId/integration-config`, `/packages/:packageId/external-refs`). Both sides are compared as
 * "METHOD path" with parameter names erased (`{id}` == `:id`), the same normalisation scripts/part2-coverage.mjs uses.
 *
 * Important: the YAML is read by indentation (paths at 2 spaces, methods at 4), like part2-coverage.mjs — no YAML
 *    dependency. Keep that layout when editing the file; a path written in flow style would be invisible here.
 */
import { buildRoutes } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PER_PACKAGE = new Set(['/packages/:packageId/integration-config', '/packages/:packageId/external-refs']);

function normalize(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') || /^\{.*\}$/.test(segment) ? '{}' : segment))
    .join('/');
}

/** "METHOD path" for every operation under `paths:` */
function readOperations(text: string): string[] {
  const out: string[] = [];
  let inPaths = false;
  let path: string | undefined;
  for (const line of text.split('\n')) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[A-Za-z]/.test(line)) break;
    const pathLine = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathLine) {
      path = pathLine[1];
      continue;
    }
    const methodLine = /^ {4}(get|put|post|patch|delete):\s*$/.exec(line);
    if (methodLine && path) out.push(`${methodLine[1]!.toUpperCase()} ${normalize(path)}`);
  }
  return out;
}

describe('integration OpenAPI parity', () => {
  it('reads paths and methods by indentation', () => {
    const sample = ['openapi: 3.0.3', 'paths:', '  /a/{id}:', '    parameters: []', '    get:', '      summary: x', '    patch:', '      summary: y', '  /b:', '    post:', 'components:', '  /c:', '    get:'].join('\n');
    expect(readOperations(sample)).toEqual(['GET /a/{}', 'PATCH /a/{}', 'POST /b']);
  });

  it('lists every operation once', () => {
    const operations = readOperations(readFileSync('docs/openapi/integration.yaml', 'utf8'));
    expect(operations.length).toBeGreaterThan(25);
    expect(new Set(operations).size).toBe(operations.length);
  });

  it('documents exactly the integration routes in buildRoutes', async () => {
    const store = new InMemoryStore();
    await store.init();
    const routes = buildRoutes(store, {}).filter((route) => route.pattern.startsWith('/integrations') || PER_PACKAGE.has(route.pattern));
    const served = [...new Set(routes.map((route) => `${route.method.toUpperCase()} ${normalize(route.pattern)}`))].sort();
    const documented = [...new Set(readOperations(readFileSync('docs/openapi/integration.yaml', 'utf8')))].sort();
    // Before the integration routes are merged (WP3 wires them) `served` is empty — this test is meant to fail then
    expect({ missingFromYaml: served.filter((op) => !documented.includes(op)), notServed: documented.filter((op) => !served.includes(op)) }).toEqual({
      missingFromYaml: [],
      notServed: [],
    });
  });
});
