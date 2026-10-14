/**
 * Template requirement level API — for each submodel of the open file, returns "mandatory / optional" from the IDTA template.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fixture = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx')));

type Json = Record<string, unknown>;
interface Entry {
  submodelId: string;
  elements: Record<string, { cardinality: string; required: boolean }>;
}
interface Body {
  result: Entry[];
  templates: number;
}

async function call(handle: ReturnType<typeof createApi>, path: string): Promise<{ status: number; body: Body }> {
  const response = await handle({ method: 'GET', path, query: {}, queryAll: {}, headers: {} } as ApiRequest);
  return { status: response.status, body: response.body as Body };
}

/** Turns one submodel of the test file into a template — kind=Template plus a cardinality on each element */
function asTemplate(submodel: Json, required: readonly string[]): Json {
  const copy = structuredClone(submodel);
  copy['kind'] = 'Template';
  copy['id'] = `${String(copy['id'])}/template`;
  for (const element of (copy['submodelElements'] ?? []) as Json[]) {
    element['qualifiers'] = [
      { type: 'SMT/Cardinality', valueType: 'xs:string', value: required.includes(String(element['idShort'])) ? 'One' : 'ZeroToOne' },
    ];
  }
  return copy;
}

describe('template requirement level API', () => {
  it('with a template, matches by semanticId and gives mandatory/optional per path', async () => {
    const store = new InMemoryStore();
    const instance = fixture();
    const target = await store.importPackage({ name: '설비.aasx', package: instance });
    const nameplate = instance.environment.submodels!.find((sm) => sm.idShort === 'DigitalNameplate')! as unknown as Json;

    // The template file — kept in the library as a separate file
    const templatePkg = fixture();
    templatePkg.environment.submodels = [asTemplate(nameplate, ['ManufacturerName', 'SerialNumber']) as never];
    await store.importPackage({ name: 'IDTA_Nameplate_template.aasx', package: templatePkg });

    const handle = createApi(store);
    const { status, body } = await call(handle, `/packages/${target.id}/requirements`);
    expect(status).toBe(200);
    expect(body.templates).toBe(1);
    const entry = body.result.find((r) => r.submodelId === nameplate['id'])!;
    expect(entry).toBeTruthy();
    expect(entry.elements['ManufacturerName']).toEqual({ cardinality: 'One', required: true });
    expect(entry.elements['YearOfConstruction']).toEqual({ cardinality: 'ZeroToOne', required: false });
    // Submodels without a template are absent from the result — the UI shows "unknown"
    const technical = instance.environment.submodels!.find((sm) => sm.idShort === 'TechnicalData')!;
    expect(body.result.find((r) => r.submodelId === technical.id)).toBeUndefined();
  });

  it('no templates at all gives an empty list — not an error', async () => {
    const store = new InMemoryStore();
    const target = await store.importPackage({ name: '설비.aasx', package: fixture() });
    const { status, body } = await call(createApi(store), `/packages/${target.id}/requirements`);
    expect(status).toBe(200);
    expect(body).toEqual({ result: [], templates: 0 });
  });

  it('editing a template is reflected in the next query — the cache keys on revision', async () => {
    const store = new InMemoryStore();
    const instance = fixture();
    const target = await store.importPackage({ name: '설비.aasx', package: instance });
    const nameplate = instance.environment.submodels!.find((sm) => sm.idShort === 'DigitalNameplate')! as unknown as Json;
    const templatePkg = fixture();
    const template = asTemplate(nameplate, ['ManufacturerName']);
    templatePkg.environment.submodels = [template as never];
    const tplRecord = await store.importPackage({ name: 'tpl.aasx', package: templatePkg });
    const handle = createApi(store);
    const first = await call(handle, `/packages/${target.id}/requirements`);
    expect(first.body.result[0]!.elements['SerialNumber']!.required).toBe(false);

    const changed = structuredClone(template);
    for (const element of changed['submodelElements'] as Json[]) {
      if (element['idShort'] === 'SerialNumber') (element['qualifiers'] as Json[])[0]!['value'] = 'One';
    }
    await store.updateIdentifiable(tplRecord.id, 'Submodel', String(changed['id']), changed);
    const second = await call(handle, `/packages/${target.id}/requirements`);
    expect(second.body.result[0]!.elements['SerialNumber']!.required).toBe(true);
  });

  it('an unknown file is 404', async () => {
    const { status } = await call(createApi(new InMemoryStore()), '/packages/nope/requirements');
    expect(status).toBe(404);
  });
});
