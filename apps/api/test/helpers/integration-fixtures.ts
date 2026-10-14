/**
 * Fixtures and an API harness for the WP4 tests (exports, external refs, projector).
 *
 * Everything starts from the anonymised `tests/fixtures/01-roll-forming-machine.aasx`. The fixture is a **Type** whose
 * BOM entry points at another asset (it triggers INT-1 and INT-2), so `unitCopy` makes the per-unit Instance file an
 * ERP actually receives: Instance kind, unit ids, BOM root = own asset.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readAasx, type AasxPackage } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import type { Environment } from '@aas/core';
import { addChild, scaffoldEnvironment } from '@aas/linter';
import { expect } from 'vitest';
import type { ApiOptions } from '../../src/api.js';
import type { IntegrationRouteDeps } from '../../src/integration/deps.js';
import { exportRoutes } from '../../src/integration/routes-exports.js';
import { externalRefRoutes } from '../../src/integration/routes-external-refs.js';
import type { IntegrationTestStore } from './integration-store.js';

export type Json = Record<string, unknown>;

export const FIXED_NOW = '2026-10-14T00:00:00.000Z';
const BASE = 'https://www.smart-factory.kr/ids';
export const TYPE_ASSET = `${BASE}/asset/RollFormingMachine/1/0`;

export function rollForming(): AasxPackage {
  return readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx')));
}

export function submodel(environment: Environment, idShort: string): Json {
  return (environment.submodels as unknown as Json[]).find((sm) => sm['idShort'] === idShort)!;
}

/** Element by `.`-separated idShorts below a submodel or element (collections, lists, entities) */
export function element(parent: Json, path: string): Json {
  let current = parent;
  for (const name of path.split('.')) {
    const children = (current['submodelElements'] ?? current['value'] ?? current['statements']) as Json[];
    current = children.find((child) => child['idShort'] === name)!;
    if (!current) throw new Error(`no element ${name} in ${path}`);
  }
  return current;
}

export function shell(environment: Environment): Json {
  return (environment.assetAdministrationShells as unknown as Json[])[0]!;
}

/** The Instance unit file `RollFormingMachine_<n>` made from the Type fixture */
export function unitCopy(n = 1, mutate?: (environment: Environment) => void): AasxPackage {
  const pkg = rollForming();
  const env = pkg.environment;
  const aas = shell(env);
  const info = aas['assetInformation'] as Json;
  aas['id'] = `${BASE}/aas/RollFormingMachine_${n}/1/0`;
  info['assetKind'] = 'Instance';
  info['globalAssetId'] = unitAsset(n);
  element(submodel(env, 'DigitalNameplate'), 'SerialNumber')['value'] = `EXM-RFL-2026-${String(126 + n).padStart(5, '0')}`;
  element(submodel(env, 'HierarchicalStructures'), 'RollFormingMachine')['globalAssetId'] = unitAsset(n);
  mutate?.(env);
  return pkg;
}

export function unitAsset(n = 1): string {
  return `${BASE}/asset/RollFormingMachine_${n}/1/0`;
}

/** A company file: SampleFactory → line PressLine → process Forming → the given equipment */
export function plantFile(equipment: { name: string; globalAssetId: string; bulkCount?: number }[]): AasxPackage {
  const environment = scaffoldEnvironment({ assetName: 'SampleFactory', unit: 'company' });
  const index = (environment.submodels as unknown as Json[]).findIndex((sm) => sm['idShort'] === 'HierarchicalStructures');
  let hierarchy = (environment.submodels as unknown as Json[])[index] as never;
  hierarchy = addChild(hierarchy, { name: 'PressLine', group: true, line: true }, BASE) as never;
  hierarchy = addChild(hierarchy, { name: 'Forming', group: true }, BASE, ['PressLine']) as never;
  for (const item of equipment) hierarchy = addChild(hierarchy, item, BASE, ['PressLine', 'Forming']) as never;
  (environment.submodels as unknown as Json[])[index] = hierarchy;
  return { environment, specPart: '/aasx/data.json', supplementaryFiles: [], extraParts: new Map() };
}

export interface CallOptions {
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export function harness(store: IntegrationTestStore, deps: IntegrationRouteDeps = { demo: false }, options: ApiOptions = {}) {
  const handle = createApi(store, {
    ...options,
    // These tests mount the export routes themselves (fixed clock, own deps) — not the built-in ones
    integrationRouteBuilders: {},
    routes: [...exportRoutes(store, deps, { now: () => FIXED_NOW }), ...externalRefRoutes(store, deps)],
  });
  const call = async (method: string, path: string, options: CallOptions = {}) => {
    const response = await handle({
      method,
      path,
      query: options.query ?? {},
      queryAll: {},
      headers: { ...(options.body !== undefined && !(options.body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...options.headers },
      ...(options.body !== undefined ? { body: options.body } : {}),
    } as ApiRequest);
    return response;
  };
  return { handle, call };
}

export function text(body: unknown): string {
  return new TextDecoder().decode(body as Uint8Array);
}

/** The product version changes every release — goldens hold a placeholder */
export function normalized(value: unknown): unknown {
  const copy = structuredClone(value) as Json;
  const source = copy['source'] as Json | undefined;
  if (source) source['version'] = '<version>';
  return copy;
}

/**
 * Compares with a committed golden file. `UPDATE_GOLDEN=1` rewrites it — review the diff before committing: a changed
 * golden means the output an ERP / MES / CMMS integration parses has changed.
 * Important: goldens are stored with LF (`.gitattributes` `text=auto` converts on checkout per platform), so line ends
 *    are compared normalised. That CSV lines end with CRLF is asserted by integration-exports-csv.test.ts.
 */
export function expectGolden(name: string, actual: string): void {
  const path = `apps/api/test/golden/integration/${name}`;
  const lf = (value: string): string => value.replace(/\r\n/g, '\n');
  if (process.env['UPDATE_GOLDEN'] === '1') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lf(actual));
  }
  expect(lf(actual)).toBe(lf(readFileSync(path, 'utf8')));
}
