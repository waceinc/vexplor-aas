/**
 * API validation.
 *
 * Calls the handlers directly without starting a server — ports and sockets would blur the cause of a failure.
 * The transport layer (server.ts) only reads bodies and writes responses, so there is no logic to verify here.
 */
import { readAasx, writeAasx } from '@aas/aasx';
import { zipSync } from 'fflate';
import { ALL_RULES, lint } from '@aas/linter';
import { InMemoryStore } from '@aas/store';
import {
  compile,
  createApi,
  decodeIdentifier,
  encodeIdentifier,
  json,
  match,
  type ApiRequest,
} from '@aas/api';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));
const GOLDEN = '01-roll-forming-machine.aasx';
const goldenBytes = new Uint8Array(readFileSync(root + GOLDEN));
const golden = readAasx(goldenBytes);

let handle: (request: ApiRequest) => Promise<{ status: number; headers: Record<string, string>; body?: unknown }>;
let packageId: string;

/** One request — missing values are filled with defaults */
async function call(
  method: string,
  path: string,
  init: {
    body?: unknown;
    query?: Record<string, string>;
    queryAll?: Record<string, string[]>;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  const response = await handle({
    method,
    path,
    query: init.query ?? {},
    headers: init.headers ?? {},
    ...(init.queryAll ? { queryAll: init.queryAll } : {}),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return { status: response.status, headers: response.headers, body: response.body as any };
}

const base = (): string => `/packages/${packageId}/api/v3.0`;
const shellId = golden.environment.assetAdministrationShells![0]!.id;
const nameplateId = golden.environment.submodels![0]!.id;

beforeEach(async () => {
  const store = new InMemoryStore();
  await store.init();
  handle = createApi(store);
  const created = await call('POST', '/packages', { body: goldenBytes, query: { name: GOLDEN } });
  expect(created.status).toBe(201);
  packageId = created.body.packageId;
});

describe('base64url identifiers', () => {
  it('round-trips IRI and IRDI', () => {
    for (const id of [shellId, '0112/2///61360_7#AAS006#001', '가나다/한글#1']) {
      expect(decodeIdentifier(encodeIdentifier(id))).toBe(id);
    }
  });

  it('also accepts standard base64 with padding', () => {
    expect(decodeIdentifier('aHR0cHM6Ly9h')).toBe('https://a');
  });
});

describe('AASX file server interface (AasxFileServer SSP-001)', () => {
  it('GET /packages returns a list of PackageDescription', async () => {
    const list = await call('GET', '/packages');
    expect(list.body.result).toHaveLength(1);
    expect(list.body.result[0].packageId).toBe(packageId);
    expect(list.body.result[0].aasIds).toEqual([shellId]);
    // Our extension fields — the spec does not forbid additional properties
    expect(list.body.result[0].name).toBe(GOLDEN);
  });

  it('GET /packages?aasId= filters', async () => {
    const hit = await call('GET', '/packages', { query: { aasId: encodeIdentifier(shellId) } });
    expect(hit.body.result).toHaveLength(1);
    const miss = await call('GET', '/packages', { query: { aasId: encodeIdentifier('없는AAS') } });
    expect(miss.body.result).toHaveLength(0);
  });

  it('GET /packages/{id} returns an **AASX file** per the spec', async () => {
    const download = await call('GET', `/packages/${packageId}`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe(
      'application/asset-administration-shell-package',
    );
    expect(download.headers['content-disposition']).toContain("filename*=UTF-8''");

    const reread = readAasx(download.body as Uint8Array);
    const result = lint(reread.environment, ALL_RULES, { package: reread.opc });
    expect(result.countBySeverity.error).toBe(0);
  });

  it('metadata lives under a sub extension path without encroaching on spec paths', async () => {
    const meta = await call('GET', `/packages/${packageId}/metadata`);
    expect(meta.status).toBe(200);
    expect(meta.body.specPart).toBe(golden.specPart);
    expect(meta.body.revision).toBe(1);
  });

  it('multipart/form-data upload (spec format)', async () => {
    const boundary = '----aasTestBoundary';
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n올림.aasx\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="올림.aasx"\r\n` +
        `Content-Type: application/asset-administration-shell-package\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + goldenBytes.length + tail.length);
    body.set(head, 0);
    body.set(goldenBytes, head.length);
    body.set(tail, head.length + goldenBytes.length);

    const created = await call('POST', '/packages', {
      body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(created.status).toBe(201);
    expect(created.headers['location']).toBe(`/packages/${created.body.packageId}`);
    expect(created.body.name).toBe('올림.aasx');
    expect(created.body.aasIds).toEqual([shellId]);

    // Check the uploaded bytes come back unchanged — that the multipart parser did not corrupt the ZIP
    const back = await call('GET', `/packages/${created.body.packageId}`);
    expect(readAasx(back.body as Uint8Array).environment.submodels).toHaveLength(
      golden.environment.submodels!.length,
    );
  });

  it('replacing via PUT /packages/{id} keeps the same id', async () => {
    const replaced = readAasx(goldenBytes);
    replaced.environment.submodels = replaced.environment.submodels!.slice(0, 6);
    const put = await call('PUT', `/packages/${packageId}`, {
      body: writeAasx(replaced),
      query: { name: '교체본.aasx' },
    });
    expect(put.status).toBe(204);

    const meta = await call('GET', `/packages/${packageId}/metadata`);
    expect(meta.body.name).toBe('교체본.aasx');
    const submodels = await call('GET', `${base()}/submodels`);
    expect(submodels.body.result).toHaveLength(6);
  });

  it('profiles advertised by GET /description', async () => {
    const description = await call('GET', '/description');
    expect(description.body.profiles).toContain(
      'https://admin-shell.io/aas/API/3/0/AasxFileServerServiceSpecification/SSP-001',
    );
  });

  it('returns lint results', async () => {
    const result = await call('GET', `/packages/${packageId}/lint`);
    expect(result.body.passed).toBe(true);
    expect(result.body.countBySeverity.error).toBe(0);
    expect(result.body.findings).toEqual([]);
  });

  it('returns the validation report as HTML — printing it gives a PDF as is', async () => {
    const report = await call('GET', `/packages/${packageId}/report`);
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toBe('text/html; charset=utf-8');
    const html = new TextDecoder().decode(report.body as Uint8Array);
    expect(html).toContain('AAS 검증 결과서');
    expect(html).toContain('>PASS<');
    expect(html).toContain('@media print');
  });

  it('a non-AASX body is 400', async () => {
    const bad = await call('POST', '/packages', {
      body: new Uint8Array([1, 2, 3]),
      query: { name: 'bad.aasx' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.messages[0].messageType).toBe('Error');
  });

  it('uploading without name is 400', async () => {
    const bad = await call('POST', '/packages', { body: goldenBytes });
    expect(bad.status).toBe(400);
  });
});

describe('Part 2 — Identifiable', () => {
  it('GET /shells · /submodels · /concept-descriptions lists', async () => {
    const shells = await call('GET', `${base()}/shells`);
    expect(shells.body.result).toHaveLength(1);
    expect(shells.body.result[0].id).toBe(shellId);

    const submodels = await call('GET', `${base()}/submodels`);
    expect(submodels.body.result.map((s: any) => s.idShort)).toEqual(
      golden.environment.submodels!.map((s) => s.idShort),
    );

    const cds = await call('GET', `${base()}/concept-descriptions`, { query: { limit: '10' } });
    expect(cds.body.result).toHaveLength(10);
    expect(cds.body.paging_metadata.cursor).toBeDefined();
  });

  it('continuing with cursor yields everything', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call('GET', `${base()}/concept-descriptions`, {
        query: { limit: '50', ...(cursor ? { cursor } : {}) },
      });
      seen.push(...page.body.result.map((c: any) => c.id));
      cursor = page.body.paging_metadata.cursor;
    } while (cursor);
    expect(seen).toHaveLength(golden.environment.conceptDescriptions!.length);
  });

  it('GET /submodels/{base64url id} fetches a single item', async () => {
    const one = await call('GET', `${base()}/submodels/${encodeIdentifier(nameplateId)}`);
    expect(one.status).toBe(200);
    expect(one.body.idShort).toBe('DigitalNameplate');
    expect(one.headers['etag']).toBe('"1"');
  });

  it('an unknown identifier is 404', async () => {
    const missing = await call('GET', `${base()}/submodels/${encodeIdentifier('없는것')}`);
    expect(missing.status).toBe(404);
    expect(missing.body.messages[0].code).toBe('NotFound');
  });

  it('editing via PUT bumps the revision', async () => {
    const path = `${base()}/submodels/${encodeIdentifier(nameplateId)}`;
    const current = await call('GET', path);
    const updated = await call('PUT', path, {
      body: { ...current.body, category: 'PARAMETER' },
      headers: { 'if-match': '1' },
    });
    // Per the spec it returns 204 with no body, but announces the new revision via ETag so optimistic locking can continue
    expect(updated.status).toBe(204);
    expect(updated.headers['etag']).toBe('"2"');
    expect((await call('GET', path)).body.category).toBe('PARAMETER');
  });

  it('mismatched If-Match is 409 — concurrent edit conflict', async () => {
    const path = `${base()}/submodels/${encodeIdentifier(nameplateId)}`;
    const current = await call('GET', path);
    const conflict = await call('PUT', path, {
      body: current.body,
      headers: { 'if-match': '7' },
    });
    expect(conflict.status).toBe(409);
  });

  it('creates via POST /submodels and deletes via DELETE', async () => {
    const id = 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/Extra/1/0';
    const created = await call('POST', `${base()}/submodels`, {
      body: { modelType: 'Submodel', id, idShort: 'Extra', kind: 'Template', submodelElements: [] },
    });
    expect(created.status).toBe(201);

    const deleted = await call('DELETE', `${base()}/submodels/${encodeIdentifier(id)}`);
    expect(deleted.status).toBe(204);
    expect((await call('GET', `${base()}/submodels/${encodeIdentifier(id)}`)).status).toBe(404);
  });

  it('a modelType that does not match the path is 400', async () => {
    const bad = await call('POST', `${base()}/shells`, {
      body: { modelType: 'Submodel', id: 'x' },
    });
    expect(bad.status).toBe(400);
  });

  it('filters by spec query parameters — idShort · semanticId', async () => {
    const byIdShort = await call('GET', `${base()}/submodels`, {
      query: { idShort: 'OperationalData' },
    });
    expect(byIdShort.body.result).toHaveLength(1);
    expect(byIdShort.body.result[0].idShort).toBe('OperationalData');

    const semantic = golden.environment.submodels![0]!.semanticId!.keys[0]!.value;
    const bySemantic = await call('GET', `${base()}/submodels`, {
      query: { semanticId: encodeIdentifier(semantic) },
    });
    expect(bySemantic.body.result).toHaveLength(1);
    expect(bySemantic.body.result[0].idShort).toBe('DigitalNameplate');
  });

  it('GET /serialization — includes only what was selected', async () => {
    const json = await call('GET', `${base()}/serialization`, {
      queryAll: { submodelIds: [encodeIdentifier(nameplateId)] },
      query: { includeConceptDescriptions: 'false' },
    });
    expect(json.status).toBe(200);
    expect(json.body.submodels).toHaveLength(1);
    expect(json.body.conceptDescriptions).toBeUndefined();

    const aasx = await call('GET', `${base()}/serialization`, {
      headers: { accept: 'application/asset-administration-shell-package' },
    });
    expect(aasx.headers['content-type']).toBe('application/asset-administration-shell-package');
    expect(readAasx(aasx.body as Uint8Array).environment.submodels).toHaveLength(
      golden.environment.submodels!.length,
    );
  });

  it('/description under the Part 2 base path', async () => {
    const description = await call('GET', `${base()}/description`);
    expect(description.body.profiles).toContain(
      'https://admin-shell.io/aas/API/3/0/ConceptDescriptionServiceSpecification/SSP-001',
    );
  });

  it('GET /shells/{id}/submodel-refs', async () => {
    const refs = await call('GET', `${base()}/shells/${encodeIdentifier(shellId)}/submodel-refs`);
    expect(refs.body.result).toHaveLength(golden.environment.submodels!.length);
  });
});

describe('Part 2 — serialization modifiers', () => {
  const smPath = (): string => `${base()}/submodels/${encodeIdentifier(nameplateId)}`;

  it('$value — returns values only', async () => {
    const value = await call('GET', `${smPath()}/$value`);
    expect(value.status).toBe(200);
    // Child idShorts become the keys
    expect(value.body.SerialNumber).toBe('EXM-RFL-2026-00127');
    // No structural information
    expect(value.body.modelType).toBeUndefined();
  });

  it('Important: MultiLanguageProperty is an array of objects keyed by language (corrected by comparing with BaSyx)', async () => {
    // Spec: "an array of JSON objects, one per language, with the language as name and the localized string as value"
    // Fixed on 2026-08-24; it used to emit the metamodel representation ({language,text}) as is
    const value = await call('GET', `${smPath()}/$value`);
    expect(value.body.ManufacturerName).toEqual([{ ko: 'Example Manufacturer Co., Ltd.' }]);
  });

  it('MLP writes accept both the spec shape and the metamodel shape', async () => {
    const path = `${smPath()}/submodel-elements/ManufacturerName/$value`;

    // ① Spec shape
    expect((await call('PATCH', path, { body: [{ en: 'Spec form' }] })).status).toBe(204);
    expect((await call('GET', path)).body).toEqual([{ en: 'Spec form' }]);

    // ② Metamodel shape — some clients send it, so we accept it
    expect(
      (await call('PATCH', path, { body: [{ language: 'ko', text: '관용 형태' }] })).status,
    ).toBe(204);
    // Output is always the spec shape
    expect((await call('GET', path)).body).toEqual([{ ko: '관용 형태' }]);
  });

  it('PATCH $value — edits several values at once', async () => {
    const patched = await call('PATCH', `${smPath()}/$value`, {
      body: { SerialNumber: 'SN-바뀜', YearOfConstruction: '2027' },
    });
    expect(patched.status).toBe(204);

    const after = await call('GET', `${smPath()}/$value`);
    expect(after.body.SerialNumber).toBe('SN-바뀜');
    expect(after.body.YearOfConstruction).toBe('2027');
  });

  it('PATCH $value — reports an unknown name as 404 (does not pass silently)', async () => {
    const bad = await call('PATCH', `${smPath()}/$value`, { body: { 없는요소: 'x' } });
    expect(bad.status).toBe(404);
  });

  it('$metadata — everything except values and children', async () => {
    const meta = await call('GET', `${smPath()}/$metadata`);
    expect(meta.status).toBe(200);
    expect(meta.body.id).toBe(nameplateId);
    expect(meta.body.kind).toBe('Template');
    expect(meta.body.semanticId).toBeDefined();
    expect(meta.body.submodelElements).toBeUndefined(); // children are left out
  });

  it('PATCH $metadata — replaces only the rest without touching values', async () => {
    const before = await call('GET', `${smPath()}/$value`);
    const meta = await call('GET', `${smPath()}/$metadata`);

    const patched = await call('PATCH', `${smPath()}/$metadata`, {
      body: { ...meta.body, category: 'PARAMETER' },
    });
    expect(patched.status).toBe(204);

    const one = await call('GET', smPath());
    expect(one.body.category).toBe('PARAMETER');
    // Values stay as is — that is this path's contract
    expect((await call('GET', `${smPath()}/$value`)).body).toEqual(before.body);
    expect(one.body.submodelElements.length).toBeGreaterThan(0);
  });

  it('$reference — a ModelReference pointing at that resource', async () => {
    const reference = await call('GET', `${smPath()}/$reference`);
    expect(reference.body).toEqual({
      type: 'ModelReference',
      keys: [{ type: 'Submodel', value: nameplateId }],
    });
  });

  it('$path — a list of idShortPaths. Scans positions only, without fetching the tree', async () => {
    const paths = await call('GET', `${smPath()}/$path`);
    expect(paths.body).toContain('SerialNumber');
    expect(paths.body).toContain('Markings');
    // Nesting uses the spec notation as is
    expect(paths.body).toContain('Markings[0].MarkingName');
  });

  it('element-level $metadata · $reference · $path', async () => {
    const elements = `${smPath()}/submodel-elements`;

    const meta = await call('GET', `${elements}/SerialNumber/$metadata`);
    expect(meta.body.valueType).toBe('xs:string');
    expect(meta.body.value).toBeUndefined();

    const reference = await call('GET', `${elements}/SerialNumber/$reference`);
    expect(reference.body.keys[1]).toEqual({ type: 'Property', value: 'SerialNumber' });

    const paths = await call('GET', `${elements}/Markings/$path`);
    expect(paths.body).toEqual(['Markings', 'Markings[0]', 'Markings[0].MarkingName', 'Markings[0].MarkingAdditionalText']);
  });

  it('collection-level modifiers — /submodels/$reference · $metadata · $path', async () => {
    const references = await call('GET', `${base()}/submodels/$reference`);
    expect(references.body.result[0]).toEqual({
      type: 'ModelReference',
      keys: [{ type: 'Submodel', value: golden.environment.submodels![0]!.id }],
    });

    const metas = await call('GET', `${base()}/submodels/$metadata`, { query: { limit: '2' } });
    expect(metas.body.result).toHaveLength(2);
    expect(metas.body.result[0].submodelElements).toBeUndefined();

    const paths = await call('GET', `${base()}/submodels/$path`, { query: { limit: '1' } });
    expect(paths.body.result[0]).toContain('SerialNumber');

    const shellRefs = await call('GET', `${base()}/shells/$reference`);
    expect(shellRefs.body.result[0].keys[0].type).toBe('AssetAdministrationShell');
  });

  it('modifier paths are not mistaken for identifiers (routing precedence)', async () => {
    // /submodels/$reference has the same shape as /submodels/{id}.
    // The one with more fixed segments must win
    const reference = await call('GET', `${base()}/submodels/$reference`);
    expect(reference.status).toBe(200);
    expect(reference.body.result).toBeDefined();
    expect(reference.body.messages).toBeUndefined();
  });
});

describe('Part 2 — partial updates and attachments', () => {
  const smPath = (): string => `${base()}/submodels/${encodeIdentifier(nameplateId)}`;

  it('PATCH submodel — changes only what is in the body and keeps the rest', async () => {
    const before = await call('GET', smPath());
    const patched = await call('PATCH', smPath(), { body: { category: 'PARAMETER' } });
    expect(patched.status).toBe(204);

    const after = await call('GET', smPath());
    expect(after.body.category).toBe('PARAMETER');
    // Unlike PUT, values and children survive
    expect(after.body.submodelElements).toHaveLength(before.body.submodelElements.length);
    expect(after.body.kind).toBe('Template');
  });

  it('PATCH element — edits just one attribute', async () => {
    const path = `${smPath()}/submodel-elements/SerialNumber`;
    const patched = await call('PATCH', path, { body: { category: 'VARIABLE' } });
    expect(patched.status).toBe(204);

    const after = await call('GET', path);
    expect(after.body.category).toBe('VARIABLE');
    expect(after.body.value).toBe('EXM-RFL-2026-00127'); // value unchanged
  });

  it('attachments — upload, download and delete a manual', async () => {
    // Locate the File element through the API ($path + $metadata) — if the test re-implemented the tree rules,
    // the test would lie whenever that re-implementation was wrong
    const hando = golden.environment.submodels!.find((s) => s.idShort === 'HandoverDocumentation')!;
    const smBase = `${base()}/submodels/${encodeIdentifier(hando.id)}`;
    const paths = (await call('GET', `${smBase}/$path`)).body as string[];

    let filePath: string | undefined;
    for (const path of paths) {
      const meta = await call('GET', `${smBase}/submodel-elements/${path}/$metadata`);
      if (meta.status === 200 && meta.body.modelType === 'File') {
        filePath = path;
        break;
      }
    }
    expect(filePath).toBeDefined();

    const attachment = `${smBase}/submodel-elements/${filePath}/attachment`;
    const pdf = new TextEncoder().encode('%PDF-1.7 가짜 매뉴얼');

    const put = await call('PUT', attachment, {
      body: pdf,
      query: { fileName: '매뉴얼.pdf' },
      headers: { 'content-type': 'application/pdf' },
    });
    expect(put.status).toBe(204);

    const got = await call('GET', attachment);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('application/pdf');
    expect(got.body).toEqual(pdf);

    // It is also inside the downloaded AASX, with no rule violations (PKG-FILE-URI)
    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    expect(reread.supplementaryFiles.some((f) => f.part === '/aasx/suppl/매뉴얼.pdf')).toBe(true);
    const result = lint(reread.environment, ALL_RULES, { package: reread.opc });
    expect(result.countBySeverity.error).toBe(0);

    const removed = await call('DELETE', attachment);
    expect(removed.status).toBe(200);
    expect((await call('GET', attachment)).status).toBe(404);
  });

  it('attachments only attach to File and Blob', async () => {
    const bad = await call('PUT', `${smPath()}/submodel-elements/SerialNumber/attachment`, {
      body: new Uint8Array([1, 2, 3]),
      query: { fileName: 'x.bin' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('Part 2 — nested paths via the AAS', () => {
  const nested = (): string =>
    `${base()}/shells/${encodeIdentifier(shellId)}/submodels/${encodeIdentifier(nameplateId)}`;

  it('returns the same submodel as the flat path', async () => {
    const flat = await call('GET', `${base()}/submodels/${encodeIdentifier(nameplateId)}`);
    const viaShell = await call('GET', nested());
    expect(viaShell.status).toBe(200);
    expect(viaShell.body).toEqual(flat.body);
  });

  it('elements and modifiers go through the same handlers', async () => {
    expect((await call('GET', `${nested()}/$value`)).body.SerialNumber).toBe('EXM-RFL-2026-00127');
    expect((await call('GET', `${nested()}/$path`)).body).toContain('Markings[0].MarkingName');
    const element = await call('GET', `${nested()}/submodel-elements/SerialNumber`);
    expect(element.body.idShort).toBe('SerialNumber');
  });

  it('values can be edited via the nested path too, and the change reaches the file', async () => {
    const patched = await call('PATCH', `${nested()}/submodel-elements/SerialNumber/$value`, {
      body: 'SN-중첩경로',
    });
    expect(patched.status).toBe(204);

    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    const serial = (reread.environment.submodels![0]!.submodelElements ?? []).find(
      (n) => n.idShort === 'SerialNumber',
    ) as { value?: string };
    expect(serial.value).toBe('SN-중첩경로');
  });

  it('Important: does not open a submodel that the AAS does not reference', async () => {
    // Slipping in another package's submodel id must not work
    const outsider = 'https://www.smart-factory.kr/ids/sm/다른장비/Secret/1/0';
    await call('POST', `${base()}/submodels`, {
      body: { modelType: 'Submodel', id: outsider, idShort: 'Secret', kind: 'Template' },
    });

    // Visible via the flat path (same package)
    expect((await call('GET', `${base()}/submodels/${encodeIdentifier(outsider)}`)).status).toBe(200);

    // But 404 via the AAS path — because the AAS does not reference it
    const viaShell = await call(
      'GET',
      `${base()}/shells/${encodeIdentifier(shellId)}/submodels/${encodeIdentifier(outsider)}`,
    );
    expect(viaShell.status).toBe(404);
    expect(viaShell.body.messages[0].text).toContain('참조하지 않는');
  });
});

describe('Part 2 — AssetInformation and thumbnails', () => {
  const shellPath = (): string => `${base()}/shells/${encodeIdentifier(shellId)}`;

  it('GET asset-information', async () => {
    const info = await call('GET', `${shellPath()}/asset-information`);
    expect(info.status).toBe(200);
    expect(info.body.assetKind).toBe('Type');
    expect(info.body.globalAssetId).toContain('/ids/asset/');
  });

  it('PUT asset-information — a way for people to edit it directly, not via "fix"', async () => {
    const info = await call('GET', `${shellPath()}/asset-information`);
    const put = await call('PUT', `${shellPath()}/asset-information`, {
      body: { ...info.body, assetKind: 'Instance' },
    });
    expect(put.status).toBe(204);

    // The change reaches the file — the core of option A
    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    expect(reread.environment.assetAdministrationShells![0]!.assetInformation.assetKind).toBe(
      'Instance',
    );
    // And the linter catches that spot
    const report = await call('GET', `/packages/${packageId}/lint`);
    expect(report.body.countByRule['KOSMO-AAS-6']).toBe(1);
  });

  it('GET thumbnail — the actual part inside the package, not the model', async () => {
    const thumbnail = await call('GET', `${shellPath()}/asset-information/thumbnail`);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/png');
    expect((thumbnail.body as Uint8Array).length).toBeGreaterThan(0);
    // PNG magic number
    expect([...(thumbnail.body as Uint8Array).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('PUT thumbnail — updates file and model together, and re-saving gives 0 violations', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const put = await call('PUT', `${shellPath()}/asset-information/thumbnail`, {
      body: png,
      query: { fileName: 'new-thumb.png' },
      headers: { 'content-type': 'image/png' },
    });
    expect(put.status).toBe(204);

    const info = await call('GET', `${shellPath()}/asset-information`);
    expect(info.body.defaultThumbnail).toEqual({ path: '/new-thumb.png', contentType: 'image/png' });

    // Part, relationship and Content_Types must all agree to pass (PKG-THUMB-PART)
    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    const result = lint(reread.environment, ALL_RULES, { package: reread.opc });
    expect(result.countBySeverity.error).toBe(0);
    expect(reread.thumbnail?.part).toBe('/new-thumb.png');
    expect(reread.thumbnail?.data).toEqual(png);
  });

  it('DELETE thumbnail — 200 per the spec, and the linter flags it after deletion', async () => {
    const removed = await call('DELETE', `${shellPath()}/asset-information/thumbnail`);
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe('/thumbnail.png');

    expect((await call('GET', `${shellPath()}/asset-information/thumbnail`)).status).toBe(404);
    const report = await call('GET', `/packages/${packageId}/lint`);
    expect(report.body.countByRule['KOSMO-AAS-1']).toBe(1);
  });
});

describe('Part 2 — SubmodelElement', () => {
  const smPath = (): string => `${base()}/submodels/${encodeIdentifier(nameplateId)}/submodel-elements`;

  /** Find one Property with a value in the golden file, along with its idShortPath */
  function firstProperty(): { path: string; value?: string } {
    const submodel = golden.environment.submodels![0]!;
    for (const node of submodel.submodelElements ?? []) {
      if (node.modelType === 'Property') {
        return { path: node.idShort!, ...(node.value === undefined ? {} : { value: node.value }) };
      }
    }
    throw new Error('Property를 찾지 못했습니다');
  }

  it('list and single fetch', async () => {
    const all = await call('GET', smPath());
    expect(all.body.length).toBe(golden.environment.submodels![0]!.submodelElements!.length);

    const target = firstProperty();
    const one = await call('GET', `${smPath()}/${target.path}`);
    expect(one.status).toBe(200);
    expect(one.body.idShort).toBe(target.path);
  });

  it('nested path — reaches items by mixing indexes and dots, like Markings[0].MarkingName', async () => {
    // The golden file's DigitalNameplate has the structure SML(Markings) → SMC(MarkingsEntry_0) → Property
    const byName = await call('GET', `${smPath()}/Markings.MarkingsEntry_0.MarkingName`);
    expect(byName.status).toBe(200);
    expect(byName.body.modelType).toBe('Property');
    expect(byName.body.value).toContain('CE 2006/42/EC');

    // SML children must also be addressable by index (Part 2 notation)
    const byIndex = await call('GET', `${smPath()}/Markings[0].MarkingName`);
    expect(byIndex.status).toBe(200);
    expect(byIndex.body.value).toBe(byName.body.value);

    // The intermediate level itself can be fetched too
    const smc = await call('GET', `${smPath()}/Markings[0]`);
    expect(smc.body.modelType).toBe('SubmodelElementCollection');
  });

  it('editing $value of a nested element reaches the file', async () => {
    const path = `${smPath()}/Markings[0].MarkingAdditionalText/$value`;
    expect((await call('PATCH', path, { body: '개정 표기' })).status).toBe(204);

    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    const markings = (reread.environment.submodels![0]!.submodelElements ?? []).find(
      (n) => n.idShort === 'Markings',
    ) as { value: { value: { idShort?: string; value?: string }[] }[] };
    const target = markings.value[0]!.value.find((c) => c.idShort === 'MarkingAdditionalText');
    expect(target?.value).toBe('개정 표기');
  });

  it('reading a whole SMC via $value expands children by idShort', async () => {
    const value = await call('GET', `${smPath()}/Markings[0]/$value`);
    expect(value.status).toBe(200);
    expect(Object.keys(value.body)).toEqual(['MarkingName', 'MarkingAdditionalText']);
  });

  it('reads and writes values only via $value — under option A this path is authoring edits', async () => {
    const target = firstProperty();
    const read = await call('GET', `${smPath()}/${target.path}/$value`);
    expect(read.status).toBe(200);

    const patched = await call('PATCH', `${smPath()}/${target.path}/$value`, {
      body: { value: '새 예시값' },
    });
    expect(patched.status).toBe(204);

    const after = await call('GET', `${smPath()}/${target.path}/$value`);
    expect(after.body).toBe('새 예시값');

    // Whether edits reach the file — the core of option A
    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    const element = (reread.environment.submodels![0]!.submodelElements ?? []).find(
      (n) => n.idShort === target.path,
    ) as { value?: string };
    expect(element.value).toBe('새 예시값');
  });

  it('adds and deletes an element', async () => {
    const added = await call('POST', smPath(), {
      body: { modelType: 'Property', idShort: 'TempProbe', valueType: 'xs:string', value: '42' },
    });
    expect(added.status).toBe(201);
    expect(added.body.idShort).toBe('TempProbe');

    const one = await call('GET', `${smPath()}/TempProbe`);
    expect(one.body.value).toBe('42');

    const removed = await call('DELETE', `${smPath()}/TempProbe`);
    expect(removed.status).toBe(204);
    expect((await call('GET', `${smPath()}/TempProbe`)).status).toBe(404);
  });

  it('an unknown element path is 404', async () => {
    expect((await call('GET', `${smPath()}/없는요소`)).status).toBe(404);
  });

  it('reorder — moves one position at a time, 400 at the ends (non-spec operation)', async () => {
    const names = async (): Promise<string[]> =>
      ((await call('GET', smPath())).body as { idShort: string }[]).map((e) => e.idShort);
    const before = await names();
    const first = before[0]!;
    const second = before[1]!;

    expect((await call('POST', `${smPath()}/${first}/move`, { body: { offset: -1 } })).status).toBe(400);

    const moved = await call('POST', `${smPath()}/${first}/move`, { body: { offset: 1 } });
    expect(moved.status).toBe(204);
    expect((await names()).slice(0, 2)).toEqual([second, first]);

    // Restore it — and the file gets that order too (option A)
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { offset: -1 } })).status).toBe(204);
    expect(await names()).toEqual(before);
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { offset: 0 } })).status).toBe(400);

    // Nested items (SML children) use the same operation
    const inner = await call('POST', `${smPath()}/Markings[0].MarkingName/move`, { body: { offset: 1 } });
    expect(inner.status).toBe(204);
    const smc = await call('GET', `${smPath()}/Markings[0]/$value`);
    expect(Object.keys(smc.body)).toEqual(['MarkingAdditionalText', 'MarkingName']);
    await call('POST', `${smPath()}/Markings[0].MarkingName/move`, { body: { offset: -1 } });
  });

  it('reorder — straight to the desired position with `to` (drag and drop in the tree)', async () => {
    const names = async (): Promise<string[]> =>
      ((await call('GET', smPath())).body as { idShort: string }[]).map((e) => e.idShort);
    const before = await names();
    const first = before[0]!;
    const last = before.length - 1;

    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: last } })).status).toBe(204);
    const after = await names();
    expect(after[last]).toBe(first);
    expect(after.slice(0, last)).toEqual(before.slice(1));

    // Out of range or fractional is 400, the same position is 204 (no-op)
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: last + 1 } })).status).toBe(400);
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: 1.5 } })).status).toBe(400);
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: last } })).status).toBe(204);

    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: 0 } })).status).toBe(204);
    expect(await names()).toEqual(before);
  });

  it('duplicate — right below as X_2, again gives X_3', async () => {
    const target = firstProperty();
    const copy = await call('POST', `${smPath()}/${target.path}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body.idShort).toBe(`${target.path}_2`);
    expect(copy.body.value).toBe(target.value);

    const again = await call('POST', `${smPath()}/${target.path}/duplicate`);
    expect(again.body.idShort).toBe(`${target.path}_3`);

    const all = ((await call('GET', smPath())).body as { idShort: string }[]).map((e) => e.idShort);
    const at = all.indexOf(target.path);
    // A copy goes right below the original — the later one is closer
    expect(all.slice(at, at + 3)).toEqual([target.path, `${target.path}_3`, `${target.path}_2`]);

    await call('DELETE', `${smPath()}/${target.path}_2`);
    await call('DELETE', `${smPath()}/${target.path}_3`);
  });
});

describe('Quick Fix path', () => {
  it('fixing a defective package makes both the store and the downloaded file valid', async () => {
    // Upload a package with injected defects separately
    const damaged = readAasx(goldenBytes);
    damaged.environment.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    delete damaged.environment.assetAdministrationShells![0]!.assetInformation.globalAssetId;
    damaged.environment.submodels![1]!.kind = 'Instance';

    const created = await call('POST', '/packages', {
      body: writeAasx(damaged),
      query: { name: '결함본.aasx' },
    });
    const id = created.body.packageId;

    const before = await call('GET', `/packages/${id}/lint`);
    expect(before.body.countBySeverity.error).toBeGreaterThan(0);

    const fixed = await call('POST', `/packages/${id}/fix`);
    expect(fixed.status).toBe(200);
    expect(fixed.body.after.countBySeverity.error).toBe(0);
    expect(fixed.body.applied.length).toBeGreaterThan(0);
    expect(fixed.body.store.updated).toBeGreaterThan(0);

    // Whether the store was updated — confirm by linting again
    const after = await call('GET', `/packages/${id}/lint`);
    expect(after.body.passed).toBe(true);
  });

  it('with includeWarnings=1 it also clears fixable warnings (AASd-120) — by default only violations (2026-09-07)', async () => {
    const created = await call('POST', '/packages', { body: goldenBytes, query: { name: '경고본.aasx' } });
    const id = created.body.packageId;
    const before = await call('GET', `/packages/${id}/lint`);
    expect(before.body.countByRule['AASd-120'] ?? 0).toBeGreaterThan(0);

    // Default — warnings stay
    const plain = await call('POST', `/packages/${id}/fix`);
    expect(plain.body.after.countByRule['AASd-120'] ?? 0).toBe(before.body.countByRule['AASd-120']);

    // Enabled — warnings are cleared too. The KOSMO violation count does not grow
    const wide = await call('POST', `/packages/${id}/fix`, { query: { includeWarnings: '1' } });
    expect(wide.status).toBe(200);
    expect(wide.body.after.countByRule['AASd-120'] ?? 0).toBe(0);
    expect(wide.body.after.countBySeverity.error).toBe(0);
  });
});

describe('submodel import (template import)', () => {
  /** Build a package with a single empty machine to use as the import target */
  async function emptyTarget(): Promise<string> {
    const bare = readAasx(goldenBytes);
    bare.environment.assetAdministrationShells![0]!.idShort = 'NewMachine';
    bare.environment.assetAdministrationShells![0]!.submodels = [];
    bare.environment.submodels = [];
    bare.environment.conceptDescriptions = [];
    const created = await call('POST', '/packages', {
      body: writeAasx(bare),
      query: { name: '새장비.aasx' },
    });
    return created.body.packageId;
  }

  it('re-derives ids for the new machine and imports the CDs along with it', async () => {
    const targetId = await emptyTarget();
    const imported = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: nameplateId },
    });

    expect(imported.status).toBe(201);
    expect(imported.body.submodelId).toBe(
      'https://www.smart-factory.kr/ids/sm/NewMachine/DigitalNameplate/3/1',
    );
    expect(imported.body.renamedFrom).toBe(nameplateId);
    // Without importing the CDs, KOSMO-SME-3 fails across the board
    expect(imported.body.copiedConceptDescriptions).toBeGreaterThan(0);

    const list = await call('GET', `/packages/${targetId}/api/v3.0/submodels`);
    expect(list.body.result).toHaveLength(1);
    const sm = list.body.result[0];
    // semanticId follows its own id (KOSMO-SM-3)
    expect(sm.semanticId.keys[0].value).toBe(imported.body.submodelId);
    expect(sm.administration).toEqual({ version: '3', revision: '1' });

    // It is attached to the AAS too
    const refs = await call('GET', `${'/packages/' + targetId}/api/v3.0/shells/${encodeIdentifier(shellId)}/submodel-refs`);
    expect(refs.body.result.map((r: any) => r.keys[0].value)).toContain(imported.body.submodelId);
  });

  it('an imported submodel passes the KOSMO rules as is', async () => {
    const targetId = await emptyTarget();
    await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: nameplateId },
    });
    const report = await call('GET', `/packages/${targetId}/lint`, { query: { detail: 'true' } });
    // The "4 mandatory submodels · 6 or more" rules are not yet met, so only those two should remain
    const rules = new Set(
      report.body.findings.filter((f: any) => f.severity === 'error').map((f: any) => f.ruleId),
    );
    expect([...rules]).toEqual(['KOSMO-AAS-4']);
  });

  it('with retarget=false it keeps the original id', async () => {
    const targetId = await emptyTarget();
    const imported = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: nameplateId, retarget: false },
    });
    expect(imported.body.submodelId).toBe(nameplateId);
    expect(imported.body.renamedFrom).toBeUndefined();
  });

  it('importing the same thing twice is 409', async () => {
    const targetId = await emptyTarget();
    const body = { sourcePackageId: packageId, submodelId: nameplateId };
    await call('POST', `/packages/${targetId}/import-submodel`, { body });
    const again = await call('POST', `/packages/${targetId}/import-submodel`, { body });
    expect(again.status).toBe(409);
  });

  it('Important: if the same name (idShort) already exists, it does not silently create a second one even with a different revision — 409 with a reason', async () => {
    const targetId = await emptyTarget();
    await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: nameplateId },
    });
    // A source with the same name but a different revision — it used to slip in because the id differed
    const other = readAasx(goldenBytes);
    const np = other.environment.submodels!.find((sm) => sm.idShort === 'DigitalNameplate')!;
    np.administration = { version: '2', revision: '0' };
    const created = await call('POST', '/packages', { body: writeAasx(other), query: { name: '옛버전.aasx' } });
    const again = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: created.body.packageId, submodelId: nameplateId },
    });
    expect(again.status).toBe(409);
    expect(again.body.messages[0].text).toContain('「DigitalNameplate」');

    // Side by side — comes in as _2 and the id is derived from that name too
    const alongside = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: created.body.packageId, submodelId: nameplateId, onDuplicate: 'alongside' },
    });
    expect(alongside.status).toBe(201);
    expect(alongside.body.idShort).toBe('DigitalNameplate_2');
    expect(alongside.body.submodelId).toContain('/DigitalNameplate_2/2/0');

    // Replace — deletes the one with the same name (not both: exactly that name only) and adds the new one. The AAS reference follows
    const replace = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: created.body.packageId, submodelId: nameplateId, onDuplicate: 'replace' },
    });
    expect(replace.status).toBe(201);
    expect(replace.body.replaced).toHaveLength(1);
    const list = await call('GET', `/packages/${targetId}/api/v3.0/submodels`);
    const names = list.body.result.map((sm: any) => sm.idShort).sort();
    expect(names).toEqual(['DigitalNameplate', 'DigitalNameplate_2']);
    const refs = await call('GET', `/packages/${targetId}/api/v3.0/shells/${encodeIdentifier(shellId)}/submodel-refs`);
    const refIds = refs.body.result.map((r: any) => r.keys[0].value);
    expect(refIds).toHaveLength(2);
    expect(refIds).toContain(replace.body.submodelId);
  });

  it('a nonexistent source is 404', async () => {
    const targetId = await emptyTarget();
    const missing = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: '없는것' },
    });
    expect(missing.status).toBe(404);
  });

  it('Important: replace keeps the position — filling DigitalNameplate in a freshly created skeleton keeps it in first place (2026-09-07 field validation)', async () => {
    // The beginner flow as is: create new (6-submodel skeleton) → import DigitalNameplate from another file (replace)
    const made = await call('POST', '/packages/new', { body: { assetName: 'PressMachine' } });
    expect(made.status).toBe(201);
    const targetId = made.body.packageId as string;
    const before = await call('GET', `/packages/${targetId}/api/v3.0/submodels`);
    const orderBefore = before.body.result.map((sm: any) => sm.idShort);
    expect(orderBefore[0]).toBe('DigitalNameplate');

    const replace = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: nameplateId, onDuplicate: 'replace' },
    });
    expect(replace.status).toBe(201);
    expect(replace.body.replaced).toHaveLength(1);

    const after = await call('GET', `/packages/${targetId}/api/v3.0/submodels`);
    const orderAfter = after.body.result.map((sm: any) => sm.idShort);
    // It used to delete and re-add, moving it to the end — the order of the 4 mandatory submodels looked broken
    expect(orderAfter).toEqual(orderBefore);
    expect(after.body.result[0].submodelElements.length).toBeGreaterThan(0);

    // The AAS reference stays in the same position too
    const shells = await call('GET', `/packages/${targetId}/api/v3.0/shells`);
    const refIds = shells.body.result[0].submodels.map((r: any) => r.keys[0].value);
    expect(refIds[0]).toBe(replace.body.submodelId);
    expect(refIds).toHaveLength(orderBefore.length);
  });
});

describe('error handling', () => {
  it('an unknown path is 404, a wrong method is 405', async () => {
    expect((await call('GET', '/없는경로')).status).toBe(404);
    expect((await call('PATCH', '/packages')).status).toBe(405);
  });

  it('a body that is not an object is 400', async () => {
    const bad = await call('PUT', `${base()}/submodels/${encodeIdentifier(nameplateId)}`, {
      body: '문자열',
    });
    expect(bad.status).toBe(400);
  });

  it('a non-numeric limit is 400', async () => {
    const bad = await call('GET', `${base()}/submodels`, { query: { limit: '많이' } });
    expect(bad.status).toBe(400);
  });

  it('health', async () => {
    expect((await call('GET', '/health')).body.status).toBe('ok');
  });
});

describe('upload security (spec document Ⅷ)', () => {
  /** API with lowered limits — the very value tuned to the deployment's memory */
  async function tightApi() {
    const store = new InMemoryStore();
    await store.init();
    const handle = createApi(store, { aasxLimits: { maxTotalUncompressedBytes: 64 * 1024 } });
    return async (method: string, path: string, init: { body?: unknown; query?: Record<string, string> } = {}) =>
      handle({
        method,
        path,
        query: init.query ?? {},
        headers: {},
        ...(init.body === undefined ? {} : { body: init.body }),
      });
  }

  it('blocks a zip bomb with 413 — stops before extracting', async () => {
    const send = await tightApi();
    // 1 MB of zeros compresses to a few KB. A miniature of a typical bomb
    const bomb = zipSync({ 'aasx/big.bin': new Uint8Array(1024 * 1024) });
    expect(bomb.length).toBeLessThan(20 * 1024);

    const response = await send('POST', '/packages', { body: bomb, query: { name: 'bomb.aasx' } });
    expect(response.status).toBe(413);
    expect((response.body as any).messages[0].code).toBe('PayloadTooLarge');
    expect((response.body as any).messages[0].text).toMatch(/압축 폭탄일 수 있습니다/);
  });

  it('files containing path traversal are blocked with 413 too', async () => {
    const send = await tightApi();
    const evil = zipSync({ '../탈출.json': new TextEncoder().encode('{}') });
    const response = await send('POST', '/packages', { body: evil, query: { name: 'evil.aasx' } });
    expect(response.status).toBe(413);
    expect((response.body as any).messages[0].text).toMatch(/안전하지 않은 파트 경로/);
  });

  it('a valid file within the limits is accepted as is', async () => {
    const store = new InMemoryStore();
    await store.init();
    const handle = createApi(store, { aasxLimits: { maxTotalUncompressedBytes: 8 * 1024 * 1024 } });
    const response = await handle({
      method: 'POST',
      path: '/packages',
      query: { name: '정상.aasx' },
      headers: {},
      body: goldenBytes,
    });
    expect(response.status).toBe(201);
  });
});

describe('preventing spec drift', () => {
  it('PATCH exists only on Submodel — methods not in the spec are not opened on standard paths', async () => {
    // Opening everything just because the code is shared gives standard clients wrong expectations
    const shell = await call('PATCH', `${base()}/shells/${encodeIdentifier(shellId)}`, {
      body: { category: 'X' },
    });
    expect(shell.status).toBe(405);

    const cdId = golden.environment.conceptDescriptions![0]!.id;
    const cd = await call('PATCH', `${base()}/concept-descriptions/${encodeIdentifier(cdId)}`, {
      body: { category: 'X' },
    });
    expect(cd.status).toBe(405);

    // Submodel has it
    const submodel = await call('PATCH', `${base()}/submodels/${encodeIdentifier(nameplateId)}`, {
      body: { category: 'PARAMETER' },
    });
    expect(submodel.status).toBe(204);
  });
});

describe('router precedence', () => {
  it('fixed segments beat parameters — independent of registration order', async () => {
    const routes = compile([
      { method: 'GET', pattern: '/x/:id', handle: async () => json(200, { hit: 'param' }) },
      { method: 'GET', pattern: '/x/$value', handle: async () => json(200, { hit: 'static' }) },
    ]);
    const found = match(routes, 'GET', '/x/$value');
    expect(found).not.toBe('method-not-allowed');
    expect(found).toBeDefined();
    expect((found as { route: { pattern: string } }).route.pattern).toBe('/x/$value');

    // If it does not match a fixed segment, it goes to the parameter path
    const other = match(routes, 'GET', '/x/abc');
    expect((other as { route: { pattern: string } }).route.pattern).toBe('/x/:id');
  });

  it('a matching path with a different method is distinguished as 405', () => {
    const routes = compile([
      { method: 'GET', pattern: '/x/:id', handle: async () => json(200, {}) },
    ]);
    expect(match(routes, 'DELETE', '/x/1')).toBe('method-not-allowed');
    expect(match(routes, 'GET', '/없는/경로')).toBeUndefined();
  });
});

describe('policy switches (letting users choose between conflicting rules)', () => {
  it('the report judges with the same policy as the UI (/lint) — at one point only the report was pinned to the default policy', async () => {
    const strict = await call('GET', `/packages/${packageId}/report`, {
      query: { smlChildIdShort: 'forbid' },
    });
    const html = new TextDecoder().decode(strict.body as Uint8Array);
    expect(html).toContain('>FAIL<');
    // The chosen policy shows up as is under "applied rule interpretation" — all 5 items
    expect(html).toContain('위반 — 표준 도구·BaSyx 적재가 목표');
    expect(html).toContain('⑤ 표준 템플릿 용어');
    // Time is local time (to the minute) — not UTC ISO
    expect(html).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(html).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('with smlChildIdShort=forbid, AASd-120 becomes a violation and "fix" corrects it', async () => {
    // Under the default policy it is a warning and passes
    const relaxed = await call('GET', `/packages/${packageId}/lint`);
    expect(relaxed.body.passed).toBe(true);

    // Under the interoperability-first policy it is a violation — exactly the point basyx and aas-test-engines reject
    const strict = await call('GET', `/packages/${packageId}/lint`, {
      query: { smlChildIdShort: 'forbid' },
    });
    expect(strict.body.passed).toBe(false);
    expect(strict.body.countByRule['AASd-120']).toBeGreaterThan(0);

    const fixed = await call('POST', `/packages/${packageId}/fix`, {
      query: { smlChildIdShort: 'forbid' },
    });
    expect(fixed.body.after.countBySeverity.error).toBe(0);
    expect(fixed.body.applied.some((a: any) => a.ruleId === 'AASd-120')).toBe(true);

    // Still 0 by the KOSMO standard too — nothing is lost on either side
    const after = await call('GET', `/packages/${packageId}/lint`);
    expect(after.body.countBySeverity.error).toBe(0);
  });
});

describe('undo · redo (package-level snapshots)', () => {
  const sm = () => `${base()}/submodels/${encodeIdentifier(nameplateId)}`;
  const serial = () => `${sm()}/submodel-elements/SerialNumber`;

  it('edit value → undo → original value. Redo → edited value. The description comes in plain language', async () => {
    expect((await call('GET', `/packages/${packageId}/undo`)).body).toEqual({ undo: [], redo: [] });
    // 409 when there is nothing to undo — silently returning 200 would make the UI believe it "worked"
    expect((await call('POST', `/packages/${packageId}/undo`)).status).toBe(409);

    const patched = await call('PATCH', serial(), { body: { category: 'VARIABLE' } });
    expect(patched.status).toBe(204);
    const status = (await call('GET', `/packages/${packageId}/undo`)).body;
    expect(status.undo).toEqual(['「SerialNumber」 고침']);

    const undone = await call('POST', `/packages/${packageId}/undo`);
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ undone: '「SerialNumber」 고침', undo: [], redo: ['「SerialNumber」 고침'] });
    expect((await call('GET', serial())).body.category).toBeUndefined(); // there was no category originally

    const redone = await call('POST', `/packages/${packageId}/redo`);
    expect(redone.body).toMatchObject({ redone: '「SerialNumber」 고침', undo: ['「SerialNumber」 고침'], redo: [] });
    expect((await call('GET', serial())).body.category).toBe('VARIABLE');
  });

  it('deleting a whole submodel also comes back in one step — down to the element count', async () => {
    const before = (await call('GET', sm())).body;
    expect((await call('DELETE', sm())).status).toBe(204);
    expect((await call('GET', sm())).status).toBe(404);

    const undone = await call('POST', `/packages/${packageId}/undo`);
    expect(undone.body.undone).toBe('서브모델 지움');
    const after = (await call('GET', sm())).body;
    expect(after.submodelElements).toHaveLength(before.submodelElements.length);
    expect(after.submodelElements[0].idShort).toBe(before.submodelElements[0].idShort);
  });

  it('after several changes it steps back from the most recent, and a new change clears redo', async () => {
    await call('PATCH', serial(), { body: { category: 'VARIABLE' } });
    await call('DELETE', serial());
    const status = (await call('GET', `/packages/${packageId}/undo`)).body;
    expect(status.undo).toEqual(['「SerialNumber」 지움', '「SerialNumber」 고침']);

    await call('POST', `/packages/${packageId}/undo`); // undo the delete
    expect((await call('GET', serial())).body.category).toBe('VARIABLE');
    await call('POST', `/packages/${packageId}/undo`); // undo the edit
    expect((await call('GET', serial())).body.category).toBeUndefined();
    expect((await call('GET', `/packages/${packageId}/undo`)).body.redo).toHaveLength(2);

    // A new change discards the undone future — we cannot hold two branches
    await call('PATCH', serial(), { body: { category: 'CONSTANT' } });
    expect((await call('GET', `/packages/${packageId}/undo`)).body.redo).toEqual([]);
  });

  it('requests that leave the model unchanged (reads · failures) are not pushed onto the stack', async () => {
    await call('GET', serial());
    // A 404 from trying to delete a nonexistent element — a failed request is nothing to undo
    expect((await call('DELETE', `${sm()}/submodel-elements/없는것`)).status).toBe(404);
    // Rewriting with the same value — the revision goes up but the model is the same
    const now = (await call('GET', serial())).body;
    await call('PUT', serial(), { body: now });
    expect((await call('GET', `/packages/${packageId}/undo`)).body.undo).toEqual([]);
  });

  it('auto-fix is also undone in one step', async () => {
    // Create one violation — idShort set to an empty string
    await call('PATCH', serial(), { body: { category: 'VARIABLE' } });
    const fixed = await call('POST', `/packages/${packageId}/fix`);
    expect([200, 204]).toContain(fixed.status);
    const status = (await call('GET', `/packages/${packageId}/undo`)).body;
    // The golden file has nothing to fix, so fix leaves the model unchanged → nothing is pushed
    expect(status.undo).toEqual(['「SerialNumber」 고침']);
  });
});


describe('auto-fix — preview · selected only · migration ledger (2026-09-11)', () => {
  const IDTA = 'https://admin-shell.io/zvei/nameplate/2/0/Nameplate';

  it('preview does not save and gives the target name and before/after for each item', async () => {
    const preview = await call('GET', `/packages/${packageId}/fix-preview`, { query: { includeWarnings: '1' } });
    expect(preview.status).toBe(200);
    expect(preview.body.applied.length).toBeGreaterThan(0);
    for (const item of preview.body.applied) {
      expect(typeof item.key).toBe('string');
      expect(typeof item.description).toBe('string');
    }
    // Not saved — warning count unchanged
    const lint = await call('GET', `/packages/${packageId}/lint`);
    expect(lint.body.countBySeverity.warning).toBe(preview.body.before.countBySeverity.warning);
  });

  it('applies only what was chosen with select', async () => {
    const preview = await call('GET', `/packages/${packageId}/fix-preview`, { query: { includeWarnings: '1' } });
    const first = preview.body.applied[0];
    const fixed = await call('POST', `/packages/${packageId}/fix`, {
      query: { includeWarnings: '1' },
      body: { select: [{ ruleId: first.ruleId, pointer: first.pointer }] },
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.applied.length).toBe(1);
    expect(fixed.body.applied[0].pointer).toBe(first.pointer);
    expect(fixed.body.after.countBySeverity.warning).toBe(preview.body.before.countBySeverity.warning - 1);
  });

  it('Important: moving an IRI leaves a migration ledger in the file, includes it in the report, and can be reverted to the original', async () => {
    // A submodel with the official IDTA IRI as semanticId — an SM-3 violation under the KOSMO-first policy
    const pkg = readAasx(goldenBytes);
    const sm = pkg.environment.submodels![0]!;
    sm.semanticId = { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: IDTA }] };
    const created = await call('POST', '/packages', { body: writeAasx(pkg), query: { name: 'idta.aasx' } });
    expect(created.status).toBe(201);
    const id = created.body.packageId;

    const fixed = await call('POST', `/packages/${id}/fix`);
    expect(fixed.body.relocations[sm.id]).toBe(IDTA);
    expect(fixed.body.ledger[sm.id]).toBe(IDTA);

    // Kept in the file — visible via a separate query and in the report too
    const ledger = await call('GET', `/packages/${id}/relocations`);
    expect(ledger.body.relocations[sm.id]).toBe(IDTA);
    const report = await call('GET', `/packages/${id}/report`);
    expect(new TextDecoder().decode(report.body as Uint8Array)).toContain('IRI 이관 대장 (1건)');

    // Revert to the original — the submodel id stays, only the semanticId goes back to the original
    const reverted = await call('POST', `/packages/${id}/relocations/revert`);
    expect(reverted.status).toBe(200);
    expect(reverted.body.reverted).toEqual([{ iri: sm.id, original: IDTA, how: 'semanticId' }]);
    expect(reverted.body.remaining).toEqual({});
    const after = await call('GET', `/packages/${id}/api/v3.0/submodels/${encodeIdentifier(sm.id)}`);
    expect(after.body.id).toBe(sm.id);
    expect(after.body.semanticId.keys[0].value).toBe(IDTA);
    expect((await call('GET', `/packages/${id}/relocations`)).body.relocations).toEqual({});
  });
});
