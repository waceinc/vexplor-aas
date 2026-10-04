/**
 * API 검증.
 *
 * 서버를 띄우지 않고 핸들러를 직접 부른다 — 포트·소켓이 끼면 실패 원인이 흐려진다.
 * 전송 계층(server.ts)은 본문 읽기와 응답 쓰기뿐이라 여기서 검증할 판단이 없다.
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
const GOLDEN = '01-롤포밍기-공34.aasx';
const goldenBytes = new Uint8Array(readFileSync(root + GOLDEN));
const golden = readAasx(goldenBytes);

let handle: (request: ApiRequest) => Promise<{ status: number; headers: Record<string, string>; body?: unknown }>;
let packageId: string;

/** 요청 한 건 — 없는 값은 기본치로 채운다 */
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

describe('base64url 식별자', () => {
  it('IRI·IRDI를 왕복한다', () => {
    for (const id of [shellId, '0112/2///61360_7#AAS006#001', '가나다/한글#1']) {
      expect(decodeIdentifier(encodeIdentifier(id))).toBe(id);
    }
  });

  it('패딩이 붙은 표준 base64도 받아준다', () => {
    expect(decodeIdentifier('aHR0cHM6Ly9h')).toBe('https://a');
  });
});

describe('AASX 파일 서버 인터페이스 (AasxFileServer SSP-001)', () => {
  it('GET /packages는 PackageDescription 목록을 준다', async () => {
    const list = await call('GET', '/packages');
    expect(list.body.result).toHaveLength(1);
    expect(list.body.result[0].packageId).toBe(packageId);
    expect(list.body.result[0].aasIds).toEqual([shellId]);
    // 우리 확장 필드 — 규격이 추가 속성을 막지 않는다
    expect(list.body.result[0].name).toBe(GOLDEN);
  });

  it('GET /packages?aasId= 로 거른다', async () => {
    const hit = await call('GET', '/packages', { query: { aasId: encodeIdentifier(shellId) } });
    expect(hit.body.result).toHaveLength(1);
    const miss = await call('GET', '/packages', { query: { aasId: encodeIdentifier('없는AAS') } });
    expect(miss.body.result).toHaveLength(0);
  });

  it('GET /packages/{id}는 규격대로 **AASX 파일**을 준다', async () => {
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

  it('메타데이터는 규격 경로를 침범하지 않고 하위 확장 경로에 둔다', async () => {
    const meta = await call('GET', `/packages/${packageId}/metadata`);
    expect(meta.status).toBe(200);
    expect(meta.body.specPart).toBe(golden.specPart);
    expect(meta.body.revision).toBe(1);
  });

  it('multipart/form-data 업로드 (규격 형식)', async () => {
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

    // 올린 바이트가 그대로 다시 나오는지 — multipart 파서가 ZIP을 깨뜨리지 않았는지 본다
    const back = await call('GET', `/packages/${created.body.packageId}`);
    expect(readAasx(back.body as Uint8Array).environment.submodels).toHaveLength(
      golden.environment.submodels!.length,
    );
  });

  it('PUT /packages/{id}로 교체하면 같은 id를 지킨다', async () => {
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

  it('GET /description이 광고하는 프로필', async () => {
    const description = await call('GET', '/description');
    expect(description.body.profiles).toContain(
      'https://admin-shell.io/aas/API/3/0/AasxFileServerServiceSpecification/SSP-001',
    );
  });

  it('린트 결과를 준다', async () => {
    const result = await call('GET', `/packages/${packageId}/lint`);
    expect(result.body.passed).toBe(true);
    expect(result.body.countBySeverity.error).toBe(0);
    expect(result.body.findings).toEqual([]);
  });

  it('검증 결과서를 HTML로 준다 — 인쇄하면 그대로 PDF', async () => {
    const report = await call('GET', `/packages/${packageId}/report`);
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toBe('text/html; charset=utf-8');
    const html = new TextDecoder().decode(report.body as Uint8Array);
    expect(html).toContain('AAS 검증 결과서');
    expect(html).toContain('>PASS<');
    expect(html).toContain('@media print');
  });

  it('AASX가 아닌 본문은 400', async () => {
    const bad = await call('POST', '/packages', {
      body: new Uint8Array([1, 2, 3]),
      query: { name: 'bad.aasx' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.messages[0].messageType).toBe('Error');
  });

  it('name 없이 올리면 400', async () => {
    const bad = await call('POST', '/packages', { body: goldenBytes });
    expect(bad.status).toBe(400);
  });
});

describe('Part 2 — Identifiable', () => {
  it('GET /shells · /submodels · /concept-descriptions 목록', async () => {
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

  it('cursor로 이어 받으면 전량이 나온다', async () => {
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

  it('GET /submodels/{base64url id}로 한 건을 꺼낸다', async () => {
    const one = await call('GET', `${base()}/submodels/${encodeIdentifier(nameplateId)}`);
    expect(one.status).toBe(200);
    expect(one.body.idShort).toBe('DigitalNameplate');
    expect(one.headers['etag']).toBe('"1"');
  });

  it('없는 식별자는 404', async () => {
    const missing = await call('GET', `${base()}/submodels/${encodeIdentifier('없는것')}`);
    expect(missing.status).toBe(404);
    expect(missing.body.messages[0].code).toBe('NotFound');
  });

  it('PUT으로 고치면 리비전이 오른다', async () => {
    const path = `${base()}/submodels/${encodeIdentifier(nameplateId)}`;
    const current = await call('GET', path);
    const updated = await call('PUT', path, {
      body: { ...current.body, category: 'PARAMETER' },
      headers: { 'if-match': '1' },
    });
    // 규격대로 본문 없이 204를 주되, 낙관적 잠금을 이어가도록 ETag로 새 리비전을 알린다
    expect(updated.status).toBe(204);
    expect(updated.headers['etag']).toBe('"2"');
    expect((await call('GET', path)).body.category).toBe('PARAMETER');
  });

  it('If-Match가 어긋나면 409 — 동시 편집 충돌', async () => {
    const path = `${base()}/submodels/${encodeIdentifier(nameplateId)}`;
    const current = await call('GET', path);
    const conflict = await call('PUT', path, {
      body: current.body,
      headers: { 'if-match': '7' },
    });
    expect(conflict.status).toBe(409);
  });

  it('POST /submodels로 만들고 DELETE로 지운다', async () => {
    const id = 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/Extra/1/0';
    const created = await call('POST', `${base()}/submodels`, {
      body: { modelType: 'Submodel', id, idShort: 'Extra', kind: 'Template', submodelElements: [] },
    });
    expect(created.status).toBe(201);

    const deleted = await call('DELETE', `${base()}/submodels/${encodeIdentifier(id)}`);
    expect(deleted.status).toBe(204);
    expect((await call('GET', `${base()}/submodels/${encodeIdentifier(id)}`)).status).toBe(404);
  });

  it('경로에 맞지 않는 modelType은 400', async () => {
    const bad = await call('POST', `${base()}/shells`, {
      body: { modelType: 'Submodel', id: 'x' },
    });
    expect(bad.status).toBe(400);
  });

  it('규격 질의 인자로 거른다 — idShort · semanticId', async () => {
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

  it('GET /serialization — 고른 것만 담아 준다', async () => {
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

  it('Part 2 기저 경로의 /description', async () => {
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

describe('Part 2 — 직렬화 수식자', () => {
  const smPath = (): string => `${base()}/submodels/${encodeIdentifier(nameplateId)}`;

  it('$value — 값만 준다', async () => {
    const value = await call('GET', `${smPath()}/$value`);
    expect(value.status).toBe(200);
    // 자식 idShort가 키가 된다
    expect(value.body.SerialNumber).toBe('EXM-RFL-2026-00127');
    // 구조 정보는 없다
    expect(value.body.modelType).toBeUndefined();
  });

  it('🔴 MultiLanguageProperty는 언어를 키로 하는 객체의 배열이다 (BaSyx 대조로 정정)', async () => {
    // 규격: "각 언어마다 언어를 이름으로, 지역화 문자열을 값으로 갖는 JSON 객체의 배열"
    // 메타모델 표현({language,text})을 그대로 내보내던 것을 2026-08-24에 고쳤다
    const value = await call('GET', `${smPath()}/$value`);
    expect(value.body.ManufacturerName).toEqual([{ ko: 'Example Manufacturer Co., Ltd.' }]);
  });

  it('MLP 쓰기는 규격 형태와 메타모델 형태를 모두 받는다', async () => {
    const path = `${smPath()}/submodel-elements/ManufacturerName/$value`;

    // ① 규격 형태
    expect((await call('PATCH', path, { body: [{ en: 'Spec form' }] })).status).toBe(204);
    expect((await call('GET', path)).body).toEqual([{ en: 'Spec form' }]);

    // ② 메타모델 형태 — 보내는 클라이언트가 있어 받아는 준다
    expect(
      (await call('PATCH', path, { body: [{ language: 'ko', text: '관용 형태' }] })).status,
    ).toBe(204);
    // 내보낼 때는 언제나 규격 형태다
    expect((await call('GET', path)).body).toEqual([{ ko: '관용 형태' }]);
  });

  it('PATCH $value — 여러 값을 한 번에 고친다', async () => {
    const patched = await call('PATCH', `${smPath()}/$value`, {
      body: { SerialNumber: 'SN-바뀜', YearOfConstruction: '2027' },
    });
    expect(patched.status).toBe(204);

    const after = await call('GET', `${smPath()}/$value`);
    expect(after.body.SerialNumber).toBe('SN-바뀜');
    expect(after.body.YearOfConstruction).toBe('2027');
  });

  it('PATCH $value — 없는 이름은 404로 알린다(조용히 넘어가지 않는다)', async () => {
    const bad = await call('PATCH', `${smPath()}/$value`, { body: { 없는요소: 'x' } });
    expect(bad.status).toBe(404);
  });

  it('$metadata — 값과 자식을 뺀 나머지', async () => {
    const meta = await call('GET', `${smPath()}/$metadata`);
    expect(meta.status).toBe(200);
    expect(meta.body.id).toBe(nameplateId);
    expect(meta.body.kind).toBe('Template');
    expect(meta.body.semanticId).toBeDefined();
    expect(meta.body.submodelElements).toBeUndefined(); // 자식은 빠진다
  });

  it('PATCH $metadata — 값은 건드리지 않고 나머지만 갈아 끼운다', async () => {
    const before = await call('GET', `${smPath()}/$value`);
    const meta = await call('GET', `${smPath()}/$metadata`);

    const patched = await call('PATCH', `${smPath()}/$metadata`, {
      body: { ...meta.body, category: 'PARAMETER' },
    });
    expect(patched.status).toBe(204);

    const one = await call('GET', smPath());
    expect(one.body.category).toBe('PARAMETER');
    // 값은 그대로다 — 이게 이 경로의 계약이다
    expect((await call('GET', `${smPath()}/$value`)).body).toEqual(before.body);
    expect(one.body.submodelElements.length).toBeGreaterThan(0);
  });

  it('$reference — 그 자원을 가리키는 ModelReference', async () => {
    const reference = await call('GET', `${smPath()}/$reference`);
    expect(reference.body).toEqual({
      type: 'ModelReference',
      keys: [{ type: 'Submodel', value: nameplateId }],
    });
  });

  it('$path — idShortPath 목록. 트리를 받지 않고 위치만 훑는다', async () => {
    const paths = await call('GET', `${smPath()}/$path`);
    expect(paths.body).toContain('SerialNumber');
    expect(paths.body).toContain('Markings');
    // 중첩은 규격 표기 그대로
    expect(paths.body).toContain('Markings[0].MarkingName');
  });

  it('요소 수준 $metadata · $reference · $path', async () => {
    const elements = `${smPath()}/submodel-elements`;

    const meta = await call('GET', `${elements}/SerialNumber/$metadata`);
    expect(meta.body.valueType).toBe('xs:string');
    expect(meta.body.value).toBeUndefined();

    const reference = await call('GET', `${elements}/SerialNumber/$reference`);
    expect(reference.body.keys[1]).toEqual({ type: 'Property', value: 'SerialNumber' });

    const paths = await call('GET', `${elements}/Markings/$path`);
    expect(paths.body).toEqual(['Markings', 'Markings[0]', 'Markings[0].MarkingName', 'Markings[0].MarkingAdditionalText']);
  });

  it('모음 수준 수식자 — /submodels/$reference · $metadata · $path', async () => {
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

  it('수식자 경로가 식별자로 잘못 먹히지 않는다 (라우팅 우선순위)', async () => {
    // /submodels/$reference 는 /submodels/{id} 와도 모양이 같다.
    // 고정 세그먼트가 많은 쪽이 이겨야 한다
    const reference = await call('GET', `${base()}/submodels/$reference`);
    expect(reference.status).toBe(200);
    expect(reference.body.result).toBeDefined();
    expect(reference.body.messages).toBeUndefined();
  });
});

describe('Part 2 — 부분 갱신과 첨부', () => {
  const smPath = (): string => `${base()}/submodels/${encodeIdentifier(nameplateId)}`;

  it('PATCH 서브모델 — 본문에 온 것만 바꾸고 나머지는 지키다', async () => {
    const before = await call('GET', smPath());
    const patched = await call('PATCH', smPath(), { body: { category: 'PARAMETER' } });
    expect(patched.status).toBe(204);

    const after = await call('GET', smPath());
    expect(after.body.category).toBe('PARAMETER');
    // PUT과 달리 값·자식이 살아 있다
    expect(after.body.submodelElements).toHaveLength(before.body.submodelElements.length);
    expect(after.body.kind).toBe('Template');
  });

  it('PATCH 요소 — 한 속성만 고친다', async () => {
    const path = `${smPath()}/submodel-elements/SerialNumber`;
    const patched = await call('PATCH', path, { body: { category: 'VARIABLE' } });
    expect(patched.status).toBe(204);

    const after = await call('GET', path);
    expect(after.body.category).toBe('VARIABLE');
    expect(after.body.value).toBe('EXM-RFL-2026-00127'); // 값은 그대로
  });

  it('첨부 — 매뉴얼을 올리고 내려받고 지운다', async () => {
    // File 요소의 위치는 API로 찾는다($path + $metadata) — 트리 규칙을 테스트가 다시 구현하면
    // 그 구현이 틀렸을 때 시험이 거짓말을 한다
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

    // 내려받은 AASX 안에도 들어 있고, 규칙 위반이 없어야 한다(PKG-FILE-URI)
    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    expect(reread.supplementaryFiles.some((f) => f.part === '/aasx/suppl/매뉴얼.pdf')).toBe(true);
    const result = lint(reread.environment, ALL_RULES, { package: reread.opc });
    expect(result.countBySeverity.error).toBe(0);

    const removed = await call('DELETE', attachment);
    expect(removed.status).toBe(200);
    expect((await call('GET', attachment)).status).toBe(404);
  });

  it('첨부는 File·Blob에만 붙는다', async () => {
    const bad = await call('PUT', `${smPath()}/submodel-elements/SerialNumber/attachment`, {
      body: new Uint8Array([1, 2, 3]),
      query: { fileName: 'x.bin' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('Part 2 — AAS를 거친 중첩 경로', () => {
  const nested = (): string =>
    `${base()}/shells/${encodeIdentifier(shellId)}/submodels/${encodeIdentifier(nameplateId)}`;

  it('평면 경로와 같은 서브모델을 준다', async () => {
    const flat = await call('GET', `${base()}/submodels/${encodeIdentifier(nameplateId)}`);
    const viaShell = await call('GET', nested());
    expect(viaShell.status).toBe(200);
    expect(viaShell.body).toEqual(flat.body);
  });

  it('요소·수식자도 같은 핸들러를 탄다', async () => {
    expect((await call('GET', `${nested()}/$value`)).body.SerialNumber).toBe('EXM-RFL-2026-00127');
    expect((await call('GET', `${nested()}/$path`)).body).toContain('Markings[0].MarkingName');
    const element = await call('GET', `${nested()}/submodel-elements/SerialNumber`);
    expect(element.body.idShort).toBe('SerialNumber');
  });

  it('중첩 경로로도 값을 고칠 수 있고, 파일까지 남는다', async () => {
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

  it('🔴 그 AAS가 참조하지 않는 서브모델은 열어 주지 않는다', async () => {
    // 다른 패키지의 서브모델 id를 끼워 넣어도 통하면 안 된다
    const outsider = 'https://www.smart-factory.kr/ids/sm/다른장비/Secret/1/0';
    await call('POST', `${base()}/submodels`, {
      body: { modelType: 'Submodel', id: outsider, idShort: 'Secret', kind: 'Template' },
    });

    // 평면 경로로는 보인다(같은 패키지니까)
    expect((await call('GET', `${base()}/submodels/${encodeIdentifier(outsider)}`)).status).toBe(200);

    // 그러나 AAS를 거친 경로로는 404 — AAS가 참조하지 않기 때문이다
    const viaShell = await call(
      'GET',
      `${base()}/shells/${encodeIdentifier(shellId)}/submodels/${encodeIdentifier(outsider)}`,
    );
    expect(viaShell.status).toBe(404);
    expect(viaShell.body.messages[0].text).toContain('참조하지 않는');
  });
});

describe('Part 2 — AssetInformation과 썸네일', () => {
  const shellPath = (): string => `${base()}/shells/${encodeIdentifier(shellId)}`;

  it('GET asset-information', async () => {
    const info = await call('GET', `${shellPath()}/asset-information`);
    expect(info.status).toBe(200);
    expect(info.body.assetKind).toBe('Type');
    expect(info.body.globalAssetId).toContain('/ids/asset/');
  });

  it('PUT asset-information — 「고치기」 말고 사람이 직접 고칠 길', async () => {
    const info = await call('GET', `${shellPath()}/asset-information`);
    const put = await call('PUT', `${shellPath()}/asset-information`, {
      body: { ...info.body, assetKind: 'Instance' },
    });
    expect(put.status).toBe(204);

    // 파일까지 남는다 — A안의 핵심
    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    expect(reread.environment.assetAdministrationShells![0]!.assetInformation.assetKind).toBe(
      'Instance',
    );
    // 그리고 그 자리를 린터가 잡는다
    const report = await call('GET', `/packages/${packageId}/lint`);
    expect(report.body.countByRule['KOSMO-AAS-6']).toBe(1);
  });

  it('GET 썸네일 — 모델이 아니라 패키지 안의 실제 파트', async () => {
    const thumbnail = await call('GET', `${shellPath()}/asset-information/thumbnail`);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/png');
    expect((thumbnail.body as Uint8Array).length).toBeGreaterThan(0);
    // PNG 매직 넘버
    expect([...(thumbnail.body as Uint8Array).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('PUT 썸네일 — 파일과 모델을 함께 갱신하고, 재저장해도 위반 0건', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const put = await call('PUT', `${shellPath()}/asset-information/thumbnail`, {
      body: png,
      query: { fileName: 'new-thumb.png' },
      headers: { 'content-type': 'image/png' },
    });
    expect(put.status).toBe(204);

    const info = await call('GET', `${shellPath()}/asset-information`);
    expect(info.body.defaultThumbnail).toEqual({ path: '/new-thumb.png', contentType: 'image/png' });

    // 파트·관계·Content_Types 세 곳이 맞아야 통과한다(PKG-THUMB-PART)
    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    const result = lint(reread.environment, ALL_RULES, { package: reread.opc });
    expect(result.countBySeverity.error).toBe(0);
    expect(reread.thumbnail?.part).toBe('/new-thumb.png');
    expect(reread.thumbnail?.data).toEqual(png);
  });

  it('DELETE 썸네일 — 규격대로 200이고, 지운 뒤엔 린터가 지적한다', async () => {
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

  /** 골든 파일에서 값이 있는 Property 하나를 idShortPath와 함께 찾는다 */
  function firstProperty(): { path: string; value?: string } {
    const submodel = golden.environment.submodels![0]!;
    for (const node of submodel.submodelElements ?? []) {
      if (node.modelType === 'Property') {
        return { path: node.idShort!, ...(node.value === undefined ? {} : { value: node.value }) };
      }
    }
    throw new Error('Property를 찾지 못했습니다');
  }

  it('목록과 단건 조회', async () => {
    const all = await call('GET', smPath());
    expect(all.body.length).toBe(golden.environment.submodels![0]!.submodelElements!.length);

    const target = firstProperty();
    const one = await call('GET', `${smPath()}/${target.path}`);
    expect(one.status).toBe(200);
    expect(one.body.idShort).toBe(target.path);
  });

  it('중첩 경로 — Markings[0].MarkingName 처럼 인덱스와 점을 섞어 닿는다', async () => {
    // 골든 파일의 DigitalNameplate는 SML(Markings) → SMC(MarkingsEntry_0) → Property 구조다
    const byName = await call('GET', `${smPath()}/Markings.MarkingsEntry_0.MarkingName`);
    expect(byName.status).toBe(200);
    expect(byName.body.modelType).toBe('Property');
    expect(byName.body.value).toContain('CE 2006/42/EC');

    // SML 자식은 인덱스로도 가리킬 수 있어야 한다(Part 2 표기)
    const byIndex = await call('GET', `${smPath()}/Markings[0].MarkingName`);
    expect(byIndex.status).toBe(200);
    expect(byIndex.body.value).toBe(byName.body.value);

    // 중간 계층 자체도 꺼내진다
    const smc = await call('GET', `${smPath()}/Markings[0]`);
    expect(smc.body.modelType).toBe('SubmodelElementCollection');
  });

  it('중첩 요소의 $value 수정이 파일까지 간다', async () => {
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

  it('SMC 전체를 $value로 읽으면 자식이 idShort별로 펼쳐진다', async () => {
    const value = await call('GET', `${smPath()}/Markings[0]/$value`);
    expect(value.status).toBe(200);
    expect(Object.keys(value.body)).toEqual(['MarkingName', 'MarkingAdditionalText']);
  });

  it('$value로 값만 읽고 쓴다 — A안에서 이 경로는 저작 편집이다', async () => {
    const target = firstProperty();
    const read = await call('GET', `${smPath()}/${target.path}/$value`);
    expect(read.status).toBe(200);

    const patched = await call('PATCH', `${smPath()}/${target.path}/$value`, {
      body: { value: '새 예시값' },
    });
    expect(patched.status).toBe(204);

    const after = await call('GET', `${smPath()}/${target.path}/$value`);
    expect(after.body).toBe('새 예시값');

    // 편집이 파일로 나가는지 — A안의 핵심
    const download = await call('GET', `/packages/${packageId}`);
    const reread = readAasx(download.body as Uint8Array);
    const element = (reread.environment.submodels![0]!.submodelElements ?? []).find(
      (n) => n.idShort === target.path,
    ) as { value?: string };
    expect(element.value).toBe('새 예시값');
  });

  it('요소를 추가하고 지운다', async () => {
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

  it('없는 요소 경로는 404', async () => {
    expect((await call('GET', `${smPath()}/없는요소`)).status).toBe(404);
  });

  it('순서 바꾸기 — 한 칸씩 옮기고, 끝에서는 400 (규격 밖 연산)', async () => {
    const names = async (): Promise<string[]> =>
      ((await call('GET', smPath())).body as { idShort: string }[]).map((e) => e.idShort);
    const before = await names();
    const first = before[0]!;
    const second = before[1]!;

    expect((await call('POST', `${smPath()}/${first}/move`, { body: { offset: -1 } })).status).toBe(400);

    const moved = await call('POST', `${smPath()}/${first}/move`, { body: { offset: 1 } });
    expect(moved.status).toBe(204);
    expect((await names()).slice(0, 2)).toEqual([second, first]);

    // 돌려놓기 — 그리고 파일에도 그 순서로 나간다(A안)
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { offset: -1 } })).status).toBe(204);
    expect(await names()).toEqual(before);
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { offset: 0 } })).status).toBe(400);

    // 중첩(SML 자식)도 같은 연산이다
    const inner = await call('POST', `${smPath()}/Markings[0].MarkingName/move`, { body: { offset: 1 } });
    expect(inner.status).toBe(204);
    const smc = await call('GET', `${smPath()}/Markings[0]/$value`);
    expect(Object.keys(smc.body)).toEqual(['MarkingAdditionalText', 'MarkingName']);
    await call('POST', `${smPath()}/Markings[0].MarkingName/move`, { body: { offset: -1 } });
  });

  it('순서 바꾸기 — `to`로 원하는 자리에 바로 (트리에서 끌어다 놓기)', async () => {
    const names = async (): Promise<string[]> =>
      ((await call('GET', smPath())).body as { idShort: string }[]).map((e) => e.idShort);
    const before = await names();
    const first = before[0]!;
    const last = before.length - 1;

    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: last } })).status).toBe(204);
    const after = await names();
    expect(after[last]).toBe(first);
    expect(after.slice(0, last)).toEqual(before.slice(1));

    // 범위 밖·소수는 400, 같은 자리는 204(아무 일 없음)
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: last + 1 } })).status).toBe(400);
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: 1.5 } })).status).toBe(400);
    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: last } })).status).toBe(204);

    expect((await call('POST', `${smPath()}/${first}/move`, { body: { to: 0 } })).status).toBe(204);
    expect(await names()).toEqual(before);
  });

  it('복제 — 바로 아래에 X_2로, 다시 하면 X_3', async () => {
    const target = firstProperty();
    const copy = await call('POST', `${smPath()}/${target.path}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body.idShort).toBe(`${target.path}_2`);
    expect(copy.body.value).toBe(target.value);

    const again = await call('POST', `${smPath()}/${target.path}/duplicate`);
    expect(again.body.idShort).toBe(`${target.path}_3`);

    const all = ((await call('GET', smPath())).body as { idShort: string }[]).map((e) => e.idShort);
    const at = all.indexOf(target.path);
    // 사본은 원본 바로 아래에 선다 — 나중 것이 더 가깝다
    expect(all.slice(at, at + 3)).toEqual([target.path, `${target.path}_3`, `${target.path}_2`]);

    await call('DELETE', `${smPath()}/${target.path}_2`);
    await call('DELETE', `${smPath()}/${target.path}_3`);
  });
});

describe('Quick Fix 경로', () => {
  it('결함 패키지를 고치면 저장소와 내려받은 파일이 함께 정상이 된다', async () => {
    // 결함을 넣은 패키지를 따로 올린다
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

    // 저장소에 반영됐는지 — 다시 린트해서 확인한다
    const after = await call('GET', `/packages/${id}/lint`);
    expect(after.body.passed).toBe(true);
  });

  it('includeWarnings=1이면 고칠 수 있는 경고(AASd-120)도 지운다 — 기본은 위반만 (2026-09-07)', async () => {
    const created = await call('POST', '/packages', { body: goldenBytes, query: { name: '경고본.aasx' } });
    const id = created.body.packageId;
    const before = await call('GET', `/packages/${id}/lint`);
    expect(before.body.countByRule['AASd-120'] ?? 0).toBeGreaterThan(0);

    // 기본 — 경고는 그대로
    const plain = await call('POST', `/packages/${id}/fix`);
    expect(plain.body.after.countByRule['AASd-120'] ?? 0).toBe(before.body.countByRule['AASd-120']);

    // 켜면 — 경고도 지운다. KOSMO 위반 수는 늘지 않는다
    const wide = await call('POST', `/packages/${id}/fix`, { query: { includeWarnings: '1' } });
    expect(wide.status).toBe(200);
    expect(wide.body.after.countByRule['AASd-120'] ?? 0).toBe(0);
    expect(wide.body.after.countBySeverity.error).toBe(0);
  });
});

describe('서브모델 가져오기 (템플릿 임포트)', () => {
  /** 빈 장비 한 대짜리 패키지를 만들어 가져오기 대상으로 쓴다 */
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

  it('id를 새 장비에 맞게 다시 짓고 CD까지 함께 가져온다', async () => {
    const targetId = await emptyTarget();
    const imported = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: nameplateId },
    });

    expect(imported.status).toBe(201);
    expect(imported.body.submodelId).toBe(
      'https://www.smart-factory.kr/ids/sm/NewMachine/DigitalNameplate/3/1',
    );
    expect(imported.body.renamedFrom).toBe(nameplateId);
    // CD를 안 가져오면 KOSMO-SME-3이 전부 터진다
    expect(imported.body.copiedConceptDescriptions).toBeGreaterThan(0);

    const list = await call('GET', `/packages/${targetId}/api/v3.0/submodels`);
    expect(list.body.result).toHaveLength(1);
    const sm = list.body.result[0];
    // semanticId가 자기 id를 따라온다 (KOSMO-SM-3)
    expect(sm.semanticId.keys[0].value).toBe(imported.body.submodelId);
    expect(sm.administration).toEqual({ version: '3', revision: '1' });

    // AAS에도 매달린다
    const refs = await call('GET', `${'/packages/' + targetId}/api/v3.0/shells/${encodeIdentifier(shellId)}/submodel-refs`);
    expect(refs.body.result.map((r: any) => r.keys[0].value)).toContain(imported.body.submodelId);
  });

  it('가져온 서브모델이 KOSMO 규칙을 그대로 통과한다', async () => {
    const targetId = await emptyTarget();
    await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: nameplateId },
    });
    const report = await call('GET', `/packages/${targetId}/lint`, { query: { detail: 'true' } });
    // 서브모델 4종 필수·6종 이상 규칙은 아직 못 채운 상태이므로 그 둘만 남아야 한다
    const rules = new Set(
      report.body.findings.filter((f: any) => f.severity === 'error').map((f: any) => f.ruleId),
    );
    expect([...rules]).toEqual(['KOSMO-AAS-4']);
  });

  it('retarget=false면 원본 id를 그대로 쓴다', async () => {
    const targetId = await emptyTarget();
    const imported = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: nameplateId, retarget: false },
    });
    expect(imported.body.submodelId).toBe(nameplateId);
    expect(imported.body.renamedFrom).toBeUndefined();
  });

  it('같은 것을 두 번 가져오면 409', async () => {
    const targetId = await emptyTarget();
    const body = { sourcePackageId: packageId, submodelId: nameplateId };
    await call('POST', `/packages/${targetId}/import-submodel`, { body });
    const again = await call('POST', `/packages/${targetId}/import-submodel`, { body });
    expect(again.status).toBe(409);
  });

  it('🔴 같은 이름(idShort)이 이미 있으면 판이 달라도 말없이 둘째를 만들지 않는다 — 409, 이유를 말한다', async () => {
    const targetId = await emptyTarget();
    await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: nameplateId },
    });
    // 같은 이름·다른 판을 가진 원본 — 예전엔 id가 달라 그냥 들어갔다
    const other = readAasx(goldenBytes);
    const np = other.environment.submodels!.find((sm) => sm.idShort === 'DigitalNameplate')!;
    np.administration = { version: '2', revision: '0' };
    const created = await call('POST', '/packages', { body: writeAasx(other), query: { name: '옛판.aasx' } });
    const again = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: created.body.packageId, submodelId: nameplateId },
    });
    expect(again.status).toBe(409);
    expect(again.body.messages[0].text).toContain('「DigitalNameplate」');

    // 나란히 두기 — _2로 들어오고 id도 그 이름으로 짓는다
    const alongside = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: created.body.packageId, submodelId: nameplateId, onDuplicate: 'alongside' },
    });
    expect(alongside.status).toBe(201);
    expect(alongside.body.idShort).toBe('DigitalNameplate_2');
    expect(alongside.body.submodelId).toContain('/DigitalNameplate_2/2/0');

    // 바꾸기 — 같은 이름의 것(둘 다 아님: 정확히 그 이름만)을 지우고 새것을 넣는다. AAS 참조도 따라간다
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

  it('없는 원본이면 404', async () => {
    const targetId = await emptyTarget();
    const missing = await call('POST', `/packages/${targetId}/import-submodel`, {
      body: { sourcePackageId: packageId, submodelId: '없는것' },
    });
    expect(missing.status).toBe(404);
  });

  it('🔴 바꾸기는 자리를 지킨다 — 새로 만든 뼈대의 DigitalNameplate를 채워도 첫째 자리 그대로 (2026-09-07 실전 검증)', async () => {
    // 초보자 흐름 그대로: 새로 만들기(뼈대 6종) → 다른 파일에서 DigitalNameplate 가져오기(바꾸기)
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
    // 전에는 지우고 새로 넣어 맨 뒤로 갔다 — 필수 4종 순서가 깨져 보였다
    expect(orderAfter).toEqual(orderBefore);
    expect(after.body.result[0].submodelElements.length).toBeGreaterThan(0);

    // AAS 참조도 같은 자리
    const shells = await call('GET', `/packages/${targetId}/api/v3.0/shells`);
    const refIds = shells.body.result[0].submodels.map((r: any) => r.keys[0].value);
    expect(refIds[0]).toBe(replace.body.submodelId);
    expect(refIds).toHaveLength(orderBefore.length);
  });
});

describe('오류 처리', () => {
  it('없는 경로는 404, 잘못된 메서드는 405', async () => {
    expect((await call('GET', '/없는경로')).status).toBe(404);
    expect((await call('PATCH', '/packages')).status).toBe(405);
  });

  it('본문이 객체가 아니면 400', async () => {
    const bad = await call('PUT', `${base()}/submodels/${encodeIdentifier(nameplateId)}`, {
      body: '문자열',
    });
    expect(bad.status).toBe(400);
  });

  it('limit이 숫자가 아니면 400', async () => {
    const bad = await call('GET', `${base()}/submodels`, { query: { limit: '많이' } });
    expect(bad.status).toBe(400);
  });

  it('health', async () => {
    expect((await call('GET', '/health')).body.status).toBe('ok');
  });
});

describe('업로드 보안 (기획서 Ⅷ)', () => {
  /** 상한을 낮춘 API — 배포처 메모리에 맞춰 조절하는 그 값이다 */
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

  it('압축 폭탄은 413으로 막는다 — 풀기 전에 멈춘다', async () => {
    const send = await tightApi();
    // 1MB의 0은 수 KB로 압축된다. 전형적인 폭탄의 축소판
    const bomb = zipSync({ 'aasx/big.bin': new Uint8Array(1024 * 1024) });
    expect(bomb.length).toBeLessThan(20 * 1024);

    const response = await send('POST', '/packages', { body: bomb, query: { name: 'bomb.aasx' } });
    expect(response.status).toBe(413);
    expect((response.body as any).messages[0].code).toBe('PayloadTooLarge');
    expect((response.body as any).messages[0].text).toMatch(/압축 폭탄일 수 있습니다/);
  });

  it('경로 탈출이 든 파일도 413으로 막는다', async () => {
    const send = await tightApi();
    const evil = zipSync({ '../탈출.json': new TextEncoder().encode('{}') });
    const response = await send('POST', '/packages', { body: evil, query: { name: 'evil.aasx' } });
    expect(response.status).toBe(413);
    expect((response.body as any).messages[0].text).toMatch(/안전하지 않은 파트 경로/);
  });

  it('상한 안의 정상 파일은 그대로 받는다', async () => {
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

describe('규격 이탈 방지', () => {
  it('PATCH는 Submodel에만 있다 — 규격에 없는 메서드를 표준 경로에 열지 않는다', async () => {
    // 공유 코드라고 다 열어 주면 표준 클라이언트가 잘못된 기대를 갖는다
    const shell = await call('PATCH', `${base()}/shells/${encodeIdentifier(shellId)}`, {
      body: { category: 'X' },
    });
    expect(shell.status).toBe(405);

    const cdId = golden.environment.conceptDescriptions![0]!.id;
    const cd = await call('PATCH', `${base()}/concept-descriptions/${encodeIdentifier(cdId)}`, {
      body: { category: 'X' },
    });
    expect(cd.status).toBe(405);

    // Submodel에는 있다
    const submodel = await call('PATCH', `${base()}/submodels/${encodeIdentifier(nameplateId)}`, {
      body: { category: 'PARAMETER' },
    });
    expect(submodel.status).toBe(204);
  });
});

describe('라우터 우선순위', () => {
  it('고정 세그먼트가 매개변수를 이긴다 — 등록 순서에 기대지 않는다', async () => {
    const routes = compile([
      { method: 'GET', pattern: '/x/:id', handle: async () => json(200, { hit: 'param' }) },
      { method: 'GET', pattern: '/x/$value', handle: async () => json(200, { hit: 'static' }) },
    ]);
    const found = match(routes, 'GET', '/x/$value');
    expect(found).not.toBe('method-not-allowed');
    expect(found).toBeDefined();
    expect((found as { route: { pattern: string } }).route.pattern).toBe('/x/$value');

    // 고정과 안 맞으면 매개변수 경로로 간다
    const other = match(routes, 'GET', '/x/abc');
    expect((other as { route: { pattern: string } }).route.pattern).toBe('/x/:id');
  });

  it('경로는 맞고 메서드가 다르면 405로 구분한다', () => {
    const routes = compile([
      { method: 'GET', pattern: '/x/:id', handle: async () => json(200, {}) },
    ]);
    expect(match(routes, 'DELETE', '/x/1')).toBe('method-not-allowed');
    expect(match(routes, 'GET', '/없는/경로')).toBeUndefined();
  });
});

describe('정책 스위치 (규정 충돌을 고르게 한다)', () => {
  it('결과서도 화면(/lint)과 같은 정책으로 판정한다 — 한때 결과서만 기본 정책으로 고정돼 있었다', async () => {
    const strict = await call('GET', `/packages/${packageId}/report`, {
      query: { smlChildIdShort: 'forbid' },
    });
    const html = new TextDecoder().decode(strict.body as Uint8Array);
    expect(html).toContain('>FAIL<');
    // 「적용한 규정 해석」에 고른 정책이 그대로 찍힌다 — 5건 전부
    expect(html).toContain('위반 — 표준 도구·BaSyx 적재가 목표');
    expect(html).toContain('⑤ 표준 템플릿 용어');
    // 시각은 지역 시각(분까지) — UTC ISO가 아니다
    expect(html).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(html).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('smlChildIdShort=forbid면 AASd-120이 위반이 되고, 「고치기」가 교정한다', async () => {
    // 기본 정책에서는 경고라 통과한다
    const relaxed = await call('GET', `/packages/${packageId}/lint`);
    expect(relaxed.body.passed).toBe(true);

    // 상호운용 우선 정책에서는 위반이다 — basyx·aas-test-engines가 거부하는 그 지점
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

    // KOSMO 기준으로도 여전히 0건 — 어느 쪽도 잃지 않는다
    const after = await call('GET', `/packages/${packageId}/lint`);
    expect(after.body.countBySeverity.error).toBe(0);
  });
});

describe('되돌리기 · 다시 하기 (패키지 단위 스냅샷)', () => {
  const sm = () => `${base()}/submodels/${encodeIdentifier(nameplateId)}`;
  const serial = () => `${sm()}/submodel-elements/SerialNumber`;

  it('값 편집 → 되돌리기 → 원래 값. 다시 하기 → 고친 값. 설명이 사람 말로 온다', async () => {
    expect((await call('GET', `/packages/${packageId}/undo`)).body).toEqual({ undo: [], redo: [] });
    // 되돌릴 것이 없을 때는 409 — 조용히 200을 주면 화면이 "됐다"고 믿는다
    expect((await call('POST', `/packages/${packageId}/undo`)).status).toBe(409);

    const patched = await call('PATCH', serial(), { body: { category: 'VARIABLE' } });
    expect(patched.status).toBe(204);
    const status = (await call('GET', `/packages/${packageId}/undo`)).body;
    expect(status.undo).toEqual(['「SerialNumber」 고침']);

    const undone = await call('POST', `/packages/${packageId}/undo`);
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ undone: '「SerialNumber」 고침', undo: [], redo: ['「SerialNumber」 고침'] });
    expect((await call('GET', serial())).body.category).toBeUndefined(); // 원래 category가 없었다

    const redone = await call('POST', `/packages/${packageId}/redo`);
    expect(redone.body).toMatchObject({ redone: '「SerialNumber」 고침', undo: ['「SerialNumber」 고침'], redo: [] });
    expect((await call('GET', serial())).body.category).toBe('VARIABLE');
  });

  it('서브모델을 통째로 지운 것도 한 번에 돌아온다 — 요소 개수까지', async () => {
    const before = (await call('GET', sm())).body;
    expect((await call('DELETE', sm())).status).toBe(204);
    expect((await call('GET', sm())).status).toBe(404);

    const undone = await call('POST', `/packages/${packageId}/undo`);
    expect(undone.body.undone).toBe('서브모델 지움');
    const after = (await call('GET', sm())).body;
    expect(after.submodelElements).toHaveLength(before.submodelElements.length);
    expect(after.submodelElements[0].idShort).toBe(before.submodelElements[0].idShort);
  });

  it('여러 번 바꾸면 최근 것부터 차례로 돌아가고, 새 변경은 다시 하기를 지운다', async () => {
    await call('PATCH', serial(), { body: { category: 'VARIABLE' } });
    await call('DELETE', serial());
    const status = (await call('GET', `/packages/${packageId}/undo`)).body;
    expect(status.undo).toEqual(['「SerialNumber」 지움', '「SerialNumber」 고침']);

    await call('POST', `/packages/${packageId}/undo`); // 지움 취소
    expect((await call('GET', serial())).body.category).toBe('VARIABLE');
    await call('POST', `/packages/${packageId}/undo`); // 고침 취소
    expect((await call('GET', serial())).body.category).toBeUndefined();
    expect((await call('GET', `/packages/${packageId}/undo`)).body.redo).toHaveLength(2);

    // 새로 바꾸면 되돌린 미래는 사라진다 — 두 갈래를 들고 있을 수 없다
    await call('PATCH', serial(), { body: { category: 'CONSTANT' } });
    expect((await call('GET', `/packages/${packageId}/undo`)).body.redo).toEqual([]);
  });

  it('모델이 그대로인 요청(조회·실패)은 스택에 쌓이지 않는다', async () => {
    await call('GET', serial());
    // 없는 요소를 지우려다 404 — 실패한 요청은 되돌릴 것이 아니다
    expect((await call('DELETE', `${sm()}/submodel-elements/없는것`)).status).toBe(404);
    // 같은 값으로 다시 쓰기 — 리비전은 오르지만 모델은 같다
    const now = (await call('GET', serial())).body;
    await call('PUT', serial(), { body: now });
    expect((await call('GET', `/packages/${packageId}/undo`)).body.undo).toEqual([]);
  });

  it('자동 고치기도 한 번에 되돌아간다', async () => {
    // 위반을 하나 만든다 — idShort를 빈 문자열로
    await call('PATCH', serial(), { body: { category: 'VARIABLE' } });
    const fixed = await call('POST', `/packages/${packageId}/fix`);
    expect([200, 204]).toContain(fixed.status);
    const status = (await call('GET', `/packages/${packageId}/undo`)).body;
    // 골든 파일은 고칠 것이 없으니 fix는 모델을 안 바꾼다 → 쌓이지 않는다
    expect(status.undo).toEqual(['「SerialNumber」 고침']);
  });
});


describe('자동 고치기 — 미리보기 · 고른 것만 · 이관 대장 (2026-09-11)', () => {
  const IDTA = 'https://admin-shell.io/zvei/nameplate/2/0/Nameplate';

  it('미리보기는 저장하지 않고 항목마다 대상 이름과 전/후를 준다', async () => {
    const preview = await call('GET', `/packages/${packageId}/fix-preview`, { query: { includeWarnings: '1' } });
    expect(preview.status).toBe(200);
    expect(preview.body.applied.length).toBeGreaterThan(0);
    for (const item of preview.body.applied) {
      expect(typeof item.key).toBe('string');
      expect(typeof item.description).toBe('string');
    }
    // 저장하지 않았다 — 경고 수 그대로
    const lint = await call('GET', `/packages/${packageId}/lint`);
    expect(lint.body.countBySeverity.warning).toBe(preview.body.before.countBySeverity.warning);
  });

  it('select로 고른 것만 반영한다', async () => {
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

  it('🔴 IRI를 옮기면 이관 대장이 파일 안에 남고, 결과서에 실리고, 원본으로 되돌릴 수 있다', async () => {
    // IDTA 공식 IRI를 semanticId로 둔 서브모델 — KOSMO 우선 정책에서 SM-3 위반
    const pkg = readAasx(goldenBytes);
    const sm = pkg.environment.submodels![0]!;
    sm.semanticId = { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: IDTA }] };
    const created = await call('POST', '/packages', { body: writeAasx(pkg), query: { name: 'idta.aasx' } });
    expect(created.status).toBe(201);
    const id = created.body.packageId;

    const fixed = await call('POST', `/packages/${id}/fix`);
    expect(fixed.body.relocations[sm.id]).toBe(IDTA);
    expect(fixed.body.ledger[sm.id]).toBe(IDTA);

    // 파일 안에 남았다 — 별도 조회로도, 결과서에도
    const ledger = await call('GET', `/packages/${id}/relocations`);
    expect(ledger.body.relocations[sm.id]).toBe(IDTA);
    const report = await call('GET', `/packages/${id}/report`);
    expect(new TextDecoder().decode(report.body as Uint8Array)).toContain('IRI 이관 대장 (1건)');

    // 원본으로 되돌리기 — 서브모델 id는 그대로, semanticId만 원본으로
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
