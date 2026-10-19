/**
 * Metamodel versions at the server's edges (2026-10-19) — what is remembered on the way in, what is written on the
 * way out, and the Part 2 base path of V3.1 / V3.2 clients.
 *
 *  - a file goes out as the version it came in as; a model made here is V3.1;
 *  - a lower version reports what it drops and refuses (422, with the report) what it cannot say;
 *  - V3.1 / V3.2 percent-encode Korean and space file names and rename their parts with them;
 *  - `/api/v3/` reaches the same routes as `/api/v3.0/`.
 */
import { readAasx, writeAasx, type AasxPackage } from '@aas/aasx';
import { getAtPointer, type Environment, type MetamodelVersion } from '@aas/core';
import { InMemoryStore } from '@aas/store';
import { canonicalPart2Path, createApi, encodeIdentifier, type ApiRequest } from '@aas/api';
// Named import: the default export does not survive CommonJS interop under NodeNext type checking
import { Ajv2019, type ValidateFunction } from 'ajv/dist/2019.js';
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const fixtures = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const GOLDEN = '01-roll-forming-machine.aasx';
const goldenBytes = new Uint8Array(readFileSync(fixtures + GOLDEN));
const PASSPORT = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../web/public/samples/idta/IDTA-02035-4_BatteryPassport_TechnicalData_1.0.2.aasx', import.meta.url))),
);
const SAMPLE_BUNDLE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../web/public/samples/RB01_OptimizationQuality_sample_bundle.zip', import.meta.url))),
);
const FILE_POINTER = '/submodels/1/submodelElements/0/value/0/value/2/value/0/value/6/value/0';

const SCHEMAS = new Map<MetamodelVersion, ValidateFunction>();
function schema(version: MetamodelVersion): ValidateFunction {
  let validate = SCHEMAS.get(version);
  if (!validate) {
    const ajv = new Ajv2019({ strict: false, unicodeRegExp: false, allErrors: true });
    validate = ajv.compile(JSON.parse(readFileSync(`${fixtures}idta-metamodel/${version}/aas.schema.json`, 'utf8')) as object);
    SCHEMAS.set(version, validate);
  }
  return validate;
}
function body(data: Uint8Array): unknown {
  return JSON.parse(strFromU8(unzipSync(data)['aasx/data.json']!));
}

let handle: ReturnType<typeof createApi>;
beforeEach(async () => {
  const store = new InMemoryStore();
  await store.init();
  handle = createApi(store);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, init: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  const request: ApiRequest = { method, path, query: init.query ?? {}, headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) };
  const response = await handle(request);
  return { status: response.status, headers: response.headers, body: response.body };
}

async function upload(data: Uint8Array, name: string, query: Record<string, string> = {}): Promise<string> {
  const created = await call('POST', '/packages', { body: data, query: { name, ...query } });
  expect(created.status).toBe(201);
  return created.body.packageId as string;
}

/** The golden file changed by `edit` and packed with the internal writer (names and values exactly as given) */
function edited(edit: (env: Environment, pkg: AasxPackage) => AasxPackage | void): Uint8Array {
  const pkg: AasxPackage = readAasx(goldenBytes);
  const environment = JSON.parse(JSON.stringify(pkg.environment)) as Environment;
  const next = edit(environment, { ...pkg, environment }) ?? { ...pkg, environment };
  return writeAasx(next);
}

describe('the version a package came in as', () => {
  it('JSON golden file — 3.0 worked out from the content; downloads byte-for-byte as before', async () => {
    const id = await upload(goldenBytes, GOLDEN);
    const meta = await call('GET', `/packages/${id}/metadata`);
    expect(meta.body.metamodel).toEqual({ version: '3.0', inferred: true });
    const list = await call('GET', '/packages');
    expect(list.body.result[0].metamodel).toEqual({ version: '3.0', inferred: true });

    const download = await call('GET', `/packages/${id}`);
    expect(download.headers['x-aas-metamodel-version']).toBe('3.0');
    expect(download.body).toEqual(writeAasx(readAasx(goldenBytes)));
  });

  it('XML passport template declaring 3.1 — stored and downloaded as 3.1, passing the 3.1 schema', async () => {
    const id = await upload(PASSPORT, 'passport.aasx');
    expect((await call('GET', `/packages/${id}/metadata`)).body.metamodel).toEqual({ version: '3.1', inferred: false });
    const download = await call('GET', `/packages/${id}`);
    expect(download.status).toBe(200);
    expect(download.headers['x-aas-metamodel-version']).toBe('3.1');
    const validate = schema('3.1');
    expect(validate(body(download.body)), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
  });

  it('new equipment is 3.1; a copy keeps the version of its source', async () => {
    const made = await call('POST', '/packages/new', { body: { assetName: 'TestPress' } });
    expect(made.status).toBe(201);
    expect(made.body.metamodel).toEqual({ version: '3.1', inferred: false });
    const copy = await call('POST', `/packages/${made.body.packageId}/clone`, { body: { assetName: 'TestPress_1' } });
    expect(copy.body.metamodel).toEqual({ version: '3.1', inferred: false });
    const download = await call('GET', `/packages/${made.body.packageId}`);
    expect(download.headers['x-aas-metamodel-version']).toBe('3.1');
    const validate = schema('3.1');
    expect(validate(body(download.body)), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
  });

  it('?metamodel=3.1 on upload stores a sample as 3.1 — but only when its content fits 3.1', async () => {
    const fits = await upload(goldenBytes, 'sample.aasx', { metamodel: '3.1' });
    expect((await call('GET', `/packages/${fits}/metadata`)).body.metamodel).toEqual({ version: '3.1', inferred: false });

    // A one-letter idShort is fine in 3.0 and refused by 3.1 — the hint is dropped, the file stays 3.0
    const oneLetter = edited((env) => {
      env.submodels![0]!.idShort = 'a';
    });
    const stays = await upload(oneLetter, 'one-letter.aasx', { metamodel: '3.1' });
    expect((await call('GET', `/packages/${stays}/metadata`)).body.metamodel).toEqual({ version: '3.0', inferred: true });
    // A declared version is never overridden
    const declared = await upload(PASSPORT, 'passport.aasx', { metamodel: '3.2' });
    expect((await call('GET', `/packages/${declared}/metadata`)).body.metamodel).toEqual({ version: '3.1', inferred: false });
  });

  it('a sample bundle opened with ?metamodel=3.1 stores its files as 3.1 and still exports their original bytes', async () => {
    const opened = await call('POST', '/bundles', { body: SAMPLE_BUNDLE, query: { metamodel: '3.1' }, headers: { 'content-type': 'application/zip' } });
    expect(opened.status).toBe(201);
    const ids = (opened.body.files as { packageId: string }[]).map((f) => f.packageId);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect((await call('GET', `/packages/${id}/metadata`)).body.metamodel).toEqual({ version: '3.1', inferred: false });
    }
    // Opening the same bundle again reuses the files — the outgoing bytes still match the kept originals
    const again = await call('POST', '/bundles', { body: SAMPLE_BUNDLE, query: { metamodel: '3.1' }, headers: { 'content-type': 'application/zip' } });
    expect((again.body.files as { reused: boolean }[]).every((f) => f.reused)).toBe(true);
  });
});

describe('choosing the version on the way out', () => {
  it('lowering: a 3.1 value stops the download with the reason; the preview names it first; keep writes it anyway', async () => {
    const role = edited((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Role';
    });
    const id = await upload(role, 'role.aasx');
    expect((await call('GET', `/packages/${id}/metadata`)).body.metamodel).toEqual({ version: '3.1', inferred: true });

    const preview = await call('GET', `/packages/${id}/export-report`, { query: { metamodel: '3.0' } });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ version: '3.0', stored: { version: '3.1' }, blocked: true, lossless: false });
    expect(preview.body.entries.map((e: { feature: string }) => e.feature)).toEqual(['assetKind-role']);

    const refused = await call('GET', `/packages/${id}`, { query: { metamodel: '3.0' } });
    expect(refused.status).toBe(422);
    expect(refused.body.messages[0].code).toBe('Unrepresentable');
    expect(refused.body.report.entries[0].pointer).toBe('/assetAdministrationShells/0/assetInformation/assetKind');

    const kept = await call('GET', `/packages/${id}`, { query: { metamodel: '3.0', unrepresentable: 'keep' } });
    expect(kept.status).toBe(200);
    expect(kept.headers['x-aas-metamodel-version']).toBe('3.0');
    // The default (its own 3.1) is fine
    expect((await call('GET', `/packages/${id}`)).status).toBe(200);
  });

  it('lowering: a 3.2 field is dropped from the file and listed with its value in the preview', async () => {
    const stamped = edited((env) => {
      env.submodels![0]!.administration = { ...env.submodels![0]!.administration, createdAt: '2026-10-19T00:00:00Z' } as never;
    });
    const id = await upload(stamped, 'stamped.aasx');
    expect((await call('GET', `/packages/${id}/metadata`)).body.metamodel.version).toBe('3.2');
    const preview = await call('GET', `/packages/${id}/export-report`, { query: { metamodel: '3.1' } });
    expect(preview.body).toMatchObject({ blocked: false, lossless: false });
    expect(preview.body.entries).toMatchObject([{ kind: 'dropped', field: 'createdAt', value: '2026-10-19T00:00:00Z' }]);

    const download = await call('GET', `/packages/${id}`, { query: { metamodel: '3.1' } });
    expect(download.status).toBe(200);
    const written = body(download.body) as Environment;
    expect((written.submodels![0]!.administration as Record<string, unknown>)['createdAt']).toBeUndefined();
    expect(schema('3.1')(written)).toBe(true);
  });

  it('rejects a version it does not know', async () => {
    const id = await upload(goldenBytes, GOLDEN);
    expect((await call('GET', `/packages/${id}`, { query: { metamodel: '3.9' } })).status).toBe(400);
    expect((await call('GET', `/packages/${id}/export-report`, { query: { unrepresentable: 'drop' } })).status).toBe(400);
  });

  it('Korean and space file names: 3.0 keeps them; 3.1 encodes value, part and relationship alike and passes the schema', async () => {
    const korean = edited((env, pkg) => {
      (getAtPointer(env, FILE_POINTER) as Record<string, unknown>)['value'] = 'file:///설치 설명서.pdf';
      return { ...pkg, environment: env, supplementaryFiles: [{ part: '/설치 설명서.pdf', contentType: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }] };
    });
    const id = await upload(korean, 'korean.aasx');
    expect((await call('GET', `/packages/${id}/metadata`)).body.metamodel).toEqual({ version: '3.0', inferred: true });

    const as30 = await call('GET', `/packages/${id}`);
    expect(Object.keys(unzipSync(as30.body))).toContain('설치 설명서.pdf');

    const preview = await call('GET', `/packages/${id}/export-report`, { query: { metamodel: '3.1' } });
    expect(preview.body).toMatchObject({ blocked: false, lossless: true, entries: [] });
    expect(preview.body.renamed).toMatchObject([
      { from: 'file:///설치 설명서.pdf', to: 'file:///%EC%84%A4%EC%B9%98%20%EC%84%A4%EB%AA%85%EC%84%9C.pdf', part: { from: '/설치 설명서.pdf' } },
    ]);

    const as31 = await call('GET', `/packages/${id}`, { query: { metamodel: '3.1' } });
    expect(as31.status).toBe(200);
    const zip = unzipSync(as31.body);
    expect(Object.keys(zip)).toContain('%EC%84%A4%EC%B9%98%20%EC%84%A4%EB%AA%85%EC%84%9C.pdf');
    expect(strFromU8(zip['aasx/_rels/data.json.rels']!)).toContain('Target="/%EC%84%A4%EC%B9%98%20%EC%84%A4%EB%AA%85%EC%84%9C.pdf"');
    const validate = schema('3.1');
    expect(validate(body(as31.body)), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
    const reread = readAasx(as31.body);
    expect(reread.supplementaryFiles.map((f) => f.part)).toEqual(['/%EC%84%A4%EC%B9%98%20%EC%84%A4%EB%AA%85%EC%84%9C.pdf']);
  });

  it('Part 2 serialization as AASX writes the stored version too', async () => {
    const id = await upload(PASSPORT, 'passport.aasx');
    const response = await call('GET', `/packages/${id}/api/v3.0/serialization`, {
      headers: { accept: 'application/asset-administration-shell-package+xml' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['x-aas-metamodel-version']).toBe('3.1');
  });
});

describe('Part 2 base path of V3.1 / V3.2 clients (/api/v3/)', () => {
  it('maps /api/v3/ onto /api/v3.0/ and leaves every other path alone', () => {
    expect(canonicalPart2Path('/packages/p1/api/v3/shells')).toBe('/packages/p1/api/v3.0/shells');
    expect(canonicalPart2Path('/api/v3/shell-descriptors')).toBe('/api/v3.0/shell-descriptors');
    expect(canonicalPart2Path('/api/v3')).toBe('/api/v3.0');
    expect(canonicalPart2Path('/api/v3.0/shell-descriptors')).toBe('/api/v3.0/shell-descriptors');
    expect(canonicalPart2Path('/api/v31/shells')).toBe('/api/v31/shells');
    expect(canonicalPart2Path('/packages/p1/files/api/v3/x')).toBe('/packages/p1/files/api/v3/x');
  });

  it('answers the same under both prefixes — repository, submodel and registry', async () => {
    const id = await upload(goldenBytes, GOLDEN);
    const shells = await call('GET', `/packages/${id}/api/v3/shells`);
    expect(shells.status).toBe(200);
    expect(shells.body).toEqual((await call('GET', `/packages/${id}/api/v3.0/shells`)).body);

    const submodelId = encodeIdentifier(readAasx(goldenBytes).environment.submodels![0]!.id);
    const submodel = await call('GET', `/packages/${id}/api/v3/submodels/${submodelId}`);
    expect(submodel.status).toBe(200);
    expect(submodel.body).toEqual((await call('GET', `/packages/${id}/api/v3.0/submodels/${submodelId}`)).body);

    const descriptors = await call('GET', '/api/v3/shell-descriptors');
    expect(descriptors.status).toBe(200);
    expect(descriptors.body).toEqual((await call('GET', '/api/v3.0/shell-descriptors')).body);
  });

  it('a prefix that is neither is still unknown', async () => {
    const id = await upload(goldenBytes, GOLDEN);
    expect((await call('GET', `/packages/${id}/api/v3.1/shells`)).status).toBe(404);
  });
});
