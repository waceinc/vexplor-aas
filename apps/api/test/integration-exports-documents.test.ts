/**
 * Document index export (design §4.4; CMMS T15; ERP E-9): download URL + sha256 for stored parts, `available: false`
 * for missing ones, rows keyed by DocumentIdentifier.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Environment } from '@aas/core';
import type { DocumentRow } from '../src/integration/exports/documents.js';
import { createIntegrationStore } from './helpers/integration-store.js';
import { element, expectGolden, harness, normalized, submodel, text, unitCopy, type Json } from './helpers/integration-fixtures.js';

const MANUAL = '/EXM_RFL_InstallManual_V1.0.pdf';
const PDF = new TextEncoder().encode('%PDF-1.7 install manual');

async function setup(mutate?: (env: Environment) => void, publicBaseUrl?: string) {
  const store = createIntegrationStore();
  const pkg = await store.importPackage({ name: 'unit.aasx', package: unitCopy(1, mutate) });
  const api = harness(store, { demo: false, ...(publicBaseUrl ? { publicBaseUrl } : {}) });
  const rows = async (): Promise<DocumentRow[]> =>
    ((await api.call('GET', '/integrations/exports/documents', { query: { packageId: pkg.id } })).body as { items: DocumentRow[] }).items;
  return { store, packageId: pkg.id, rows, ...api };
}

/** Adds a second document (copy of the first with another identifier) */
function secondDocument(env: Environment): void {
  const list = element(submodel(env, 'HandoverDocumentation'), 'Documents')['value'] as Json[];
  const copy = structuredClone(list[0]!);
  copy['idShort'] = 'DocumentsEntry_1';
  element(copy, 'DocumentIds.DocumentIdsEntry_0.DocumentIdentifier')['value'] = 'DOC-03-02-0002';
  element(copy, 'DocumentVersions.DocumentVersionsEntry_0.DigitalFiles.DigitalFilesEntry_0')['value'] = 'file:///second.pdf';
  list.push(copy);
}

describe('documents export', () => {
  it('marks a part the package does not hold as unavailable, without a URL', async () => {
    const [row] = await (await setup()).rows();
    expect(row).toMatchObject({ documentId: 'DOC-03-01-0001', classId: '03-01', classificationSystem: 'VDI2770:2020', version: 'V1.0', status: 'Released' });
    expect(row).toMatchObject({ fileName: `file://${MANUAL}`, available: false, url: null, sha256: null, size: null });
  });

  it('gives a stored file a working download URL whose bytes match the sha256 (T15)', async () => {
    const { store, packageId, rows, call } = await setup();
    await store.putPackageFile(packageId, { part: MANUAL, role: 'supplementary', contentType: 'application/pdf', data: PDF });
    const [row] = await rows();
    expect(row!.available).toBe(true);
    expect(row!.size).toBe(PDF.byteLength);
    expect(row!.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
    expect(row!.contentType).toBe('application/pdf');
    const download = await call('GET', row!.url!);
    expect(download.status).toBe(200);
    expect(createHash('sha256').update(download.body as Uint8Array).digest('hex')).toBe(row!.sha256);
  });

  it('makes the URL absolute when the public base URL is known', async () => {
    const { store, packageId, rows } = await setup(undefined, 'https://aas.plant.local/');
    await store.putPackageFile(packageId, { part: MANUAL, role: 'supplementary', contentType: 'application/pdf', data: PDF });
    expect((await rows())[0]!.url).toMatch(/^https:\/\/aas\.plant\.local\/packages\/pkg_1\/api\/v3\.0\/submodels\/[A-Za-z0-9_-]+\/submodel-elements\/Documents%5B0%5D\.DocumentVersions%5B0%5D\.DigitalFiles%5B0%5D\/attachment$/);
  });

  it('keeps rows keyed by DocumentIdentifier when documents are reordered (E-9)', async () => {
    const before = await (await setup(secondDocument)).rows();
    const after = await (
      await setup((env) => {
        secondDocument(env);
        (element(submodel(env, 'HandoverDocumentation'), 'Documents')['value'] as Json[]).reverse();
      })
    ).rows();
    expect(before.map((row) => row.documentId)).toEqual(['DOC-03-01-0001', 'DOC-03-02-0002']);
    // The link follows the list position — only the URL may differ, every keyed value is the same
    const strip = (rows: DocumentRow[]) => rows.map(({ url, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
  });

  it('matches the golden JSON and CSV', async () => {
    const { store, packageId, call } = await setup();
    await store.putPackageFile(packageId, { part: MANUAL, role: 'supplementary', contentType: 'application/pdf', data: PDF });
    const asJson = await call('GET', '/integrations/exports/documents', { query: { packageId } });
    expectGolden('documents.json', `${JSON.stringify(normalized(asJson.body), null, 2)}\n`);
    expectGolden('documents.csv', text((await call('GET', '/integrations/exports/documents', { query: { packageId, format: 'csv' } })).body));
  });
});
