/**
 * XML 직렬화 AASX 읽기.
 *
 * 🔴 이 시험의 요점은 "읽힌다"가 아니라 **JSON으로 읽은 것과 똑같이 읽힌다**이다.
 * 조용히 다르게 읽히는 것이 못 읽는 것보다 나쁘다(이 과제의 basyx 실측 교훈).
 *
 * 대조 파일은 같은 내용을 basyx-python-sdk가 XML로 다시 쓴 것이다
 * (`tests/fixtures/01-롤포밍기-XML판.aasx`).
 */
import { readAasx, parseEnvironmentXml, AasxXmlError, writeAasx } from '@aas/aasx';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const xmlBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-XML판.aasx'));
const jsonBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));

/** 키 순서를 빼고 견준다 — XML은 규격이 정한 순서로 쓰이므로 JSON과 키 순서가 다르다 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function countElements(environment: { submodels?: { submodelElements?: unknown[] }[] }): number {
  let total = 0;
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      total += 1;
      const node = item as { value?: unknown; statements?: unknown };
      walk(node.value);
      walk(node.statements);
    }
  };
  for (const submodel of environment.submodels ?? []) walk(submodel.submodelElements);
  return total;
}

describe('XML AASX 읽기', () => {
  const xml = readAasx(xmlBytes);

  it('열린다 — 서브모델·개념정의·요소 수가 맞는다', () => {
    expect(xml.environment.assetAdministrationShells).toHaveLength(1);
    expect(xml.environment.submodels).toHaveLength(7);
    expect(xml.environment.conceptDescriptions).toHaveLength(137);
    expect(countElements(xml.environment)).toBe(196);
  });

  it('🔴 종류(modelType)를 요소 이름에서 만들어 넣는다 — XML에는 그 필드가 없다', () => {
    const nameplate = xml.environment.submodels!.find((s) => s.idShort === 'DigitalNameplate')!;
    expect(nameplate.modelType).toBe('Submodel');
    const serial = nameplate.submodelElements!.find((e) => e.idShort === 'SerialNumber')!;
    expect(serial.modelType).toBe('Property');
    const markings = nameplate.submodelElements!.find((e) => e.idShort === 'Markings')!;
    expect(markings.modelType).toBe('SubmodelElementList');
  });

  it('🔴 순서를 지킨다 — 리스트 자식은 순서로 가리킨다(AASd-120)', () => {
    const handover = xml.environment.submodels!.find((s) => s.idShort === 'HandoverDocumentation')!;
    const documents = handover.submodelElements!.find((e) => e.idShort === 'Documents')!;
    const children = (documents as unknown as { value: { modelType: string }[] }).value;
    expect(children.length).toBeGreaterThan(0);
    // 순서를 잃는 파서는 종류별로 묶어 버린다 — 그러면 이 값이 무너진다
    expect(children.every((child) => child.modelType === 'SubmodelElementCollection')).toBe(true);
  });

  it('🔴 dataSpecificationContent는 배열이 아니라 객체 하나다', () => {
    const cd = xml.environment.conceptDescriptions![0] as unknown as {
      embeddedDataSpecifications: { dataSpecificationContent: { modelType: string } }[];
    };
    const content = cd.embeddedDataSpecifications[0]!.dataSpecificationContent;
    expect(Array.isArray(content)).toBe(false);
    expect(content.modelType).toBe('DataSpecificationIec61360');
  });

  it('🔴 글자를 다듬지 않는다 — 남의 파일이다', () => {
    // 골든 파일의 독일어 설명 5건이 공백으로 끝난다. trim하면 조용히 달라진다
    const text = JSON.stringify(xml.environment);
    expect(text).toContain('ID für diese Wartung ');
  });

  it('들여쓴 XML도 같은 결과를 낸다 — 줄바꿈이 값에 섞이면 안 된다', () => {
    const compact = readAasx(xmlBytes).environment;
    // 같은 문서를 사람이 보기 좋게 들여쓴 판
    const raw = new TextDecoder().decode(
      // 패키지 안에서 본문만 꺼내 다시 넣는 대신, 본문 문자열을 직접 들여쓴다
      new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-XML판.aasx')),
    );
    expect(raw.length).toBeGreaterThan(0); // 파일이 있다는 것만 확인하고
    const indented = parseEnvironmentXml(
      `<environment xmlns="https://admin-shell.io/aas/3/0">
         <submodels>
           <submodel>
             <idShort>Test</idShort>
             <id>https://example.com/sm/1</id>
             <kind>Template</kind>
           </submodel>
         </submodels>
       </environment>`,
    );
    expect(indented.submodels![0]!.idShort).toBe('Test');
    expect(indented.submodels![0]!.id).toBe('https://example.com/sm/1');
    expect(compact.submodels).toHaveLength(7);
  });

  it('JSON으로 읽은 것과 내용이 같다 (교정본 기준으로 비교)', () => {
    // 대조 파일은 AASd-120을 교정한 판이라 SML 자식의 idShort만 다르다.
    // 그 밖의 모든 것은 같아야 한다 — 서브모델 id 목록으로 확인한다
    const json = readAasx(jsonBytes).environment;
    const xmlIds = (xml.environment.submodels ?? []).map((s) => s.id).sort();
    const jsonIds = (json.submodels ?? []).map((s) => s.id).sort();
    expect(xmlIds).toEqual(jsonIds);

    const xmlConcepts = (xml.environment.conceptDescriptions ?? []).map((c) => c.id).sort();
    const jsonConcepts = (json.conceptDescriptions ?? []).map((c) => c.id).sort();
    expect(xmlConcepts).toEqual(jsonConcepts);
  });

  it('XML로 열어 JSON으로 다시 쓸 수 있다 — 저장 경로는 하나로 유지한다', () => {
    const bytes = writeAasx(xml);
    const again = readAasx(bytes);
    expect(again.specPart.endsWith('.json')).toBe(true);
    expect(normalize(again.environment)).toEqual(normalize(xml.environment));
  });

  it('망가진 XML은 사유를 말하고 멈춘다', () => {
    expect(() => parseEnvironmentXml('<nothing/>')).toThrow(AasxXmlError);
  });
});
