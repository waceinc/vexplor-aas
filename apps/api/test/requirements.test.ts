/**
 * 템플릿 요구 수준 API — 열린 파일의 서브모델마다 IDTA 템플릿의 「필수 · 선택」을 돌려준다.
 */
import { readAasx } from '@aas/aasx';
import { createApi, type ApiRequest } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fixture = () => readAasx(new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')));

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

/** 시험 파일의 서브모델 하나를 템플릿으로 바꾼다 — kind=Template + 요소마다 개수 조건 */
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

describe('템플릿 요구 수준 API', () => {
  it('템플릿이 있으면 semanticId 로 짝을 지어 경로마다 필수·선택을 준다', async () => {
    const store = new InMemoryStore();
    const instance = fixture();
    const target = await store.importPackage({ name: '설비.aasx', package: instance });
    const nameplate = instance.environment.submodels!.find((sm) => sm.idShort === 'DigitalNameplate')! as unknown as Json;

    // 템플릿 파일 — 다른 파일로 보관함에 있다
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
    // 템플릿이 없는 서브모델은 결과에 없다 — 화면은 「모름」
    const technical = instance.environment.submodels!.find((sm) => sm.idShort === 'TechnicalData')!;
    expect(body.result.find((r) => r.submodelId === technical.id)).toBeUndefined();
  });

  it('템플릿이 하나도 없으면 빈 목록 — 오류가 아니다', async () => {
    const store = new InMemoryStore();
    const target = await store.importPackage({ name: '설비.aasx', package: fixture() });
    const { status, body } = await call(createApi(store), `/packages/${target.id}/requirements`);
    expect(status).toBe(200);
    expect(body).toEqual({ result: [], templates: 0 });
  });

  it('템플릿을 고치면 다음 조회에 반영된다 — 캐시는 리비전으로 판단한다', async () => {
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

  it('없는 파일은 404', async () => {
    const { status } = await call(createApi(new InMemoryStore()), '/packages/nope/requirements');
    expect(status).toBe(404);
  });
});
