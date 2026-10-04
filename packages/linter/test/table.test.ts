/**
 * 서브모델 구성요소 상세 정보 테이블 (규정 §13 주의사항 5).
 *
 * 🔴 이 시험의 절반은 "표를 만든다"가 아니라 **"만들지 말아야 할 때 만들지 않는다"** 이다.
 *    규정은 IDTA 표준 템플릿 서브모델의 표를 **생략하라**고 정했다.
 */
import { readAasx } from '@aas/aasx';
import {
  planFor,
  submodelInfo,
  submodelTable,
  submodelTables,
  smtTableCaption,
  submodelTablesHtml,
  tableCsv,
  tableHtml,
} from '@aas/linter';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const environment = readAasx(
  new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')),
).environment;
const find = (idShort: string) => environment.submodels!.find((s) => s.idShort === idShort)!;

describe('무엇을 만들지 가리기', () => {
  /**
   * 🔴 판정 기준은 **실제 제출 가이던스(01-롤포밍기 V4.0)의 표 구성**과 대조해 정했다.
   * 그 문서는 자체 IRI 요소가 없는 두 서브모델에만 표가 없다.
   */
  it('장비 특화 요소(자체 IRI)를 담은 서브모델은 표 대상', () => {
    for (const name of [
      'TechnicalData',
      'OperationalData',
      'HierarchicalStructures',
      'MaintenanceInstructions',
      'RollFormingSafety',
    ]) {
      expect(planFor(find(name)).kind).toBe('table');
    }
  });

  it('🔴 장비 특화 요소가 없으면 표를 만들지 않는다 — 규정이 생략하라고 정했다', () => {
    for (const name of ['DigitalNameplate', 'HandoverDocumentation']) {
      const plan = planFor(find(name));
      expect(plan.kind).toBe('info');
      expect(plan.reason).toContain('생략');
      expect(plan.specificCount).toBe(0);
    }
  });

  it('🔴 이름으로 가리지 않는다 — IDTA 표준 이름이어도 장비 특화가 섞이면 표가 있다', () => {
    // MaintenanceInstructions·HierarchicalStructures는 IDTA 표준 이름이지만
    // 실제 문서에는 표가 있다(장비 특화 내용이 들어가 있기 때문이다)
    expect(planFor(find('MaintenanceInstructions')).specificCount).toBeGreaterThan(0);
  });
});

describe('IDTA SMT 표 서식 — 실제 문서와 같은 모양', () => {
  const tables = submodelTables(environment, find('OperationalData'));

  it('담는 요소마다 표가 한 장씩 나온다', () => {
    const names = tables.map((table) => table.idShort);
    expect(names).toContain('OperationalData');
    expect(names).toContain('MaintenanceMonitoring');
    expect(names).toContain('ConditionStatus');
  });

  it('머리 5줄이 문서와 같다 (idShort · Class · semanticId · Parent · Explanation)', () => {
    const one = tables.find((table) => table.idShort === 'ConditionStatus')!;
    expect(one.className).toBe('SubmodelElementCollection');
    expect(one.semantic.idType).toBe('[IRI]');
    expect(one.parent).toBe('SMC "MaintenanceMonitoring"');
    expect(one.explanation).toBe('Condition Status');
  });

  it('서브모델 자신은 Parent가 `-`', () => {
    expect(tables[0]!.parent).toBe('-');
  });

  it('자식 줄이 `[Prop]이름` · `[타입]값` 꼴이다', () => {
    const one = tables.find((table) => table.idShort === 'ConditionStatus')!;
    const row = one.children.find((child) => child.label === '[Prop]RollWearStatus')!;
    expect(row.value).toBe('[string]Normal');
    expect(row.semantic.definition).toBe('Roll Wear Status');
    expect(row.semantic.korean).toBe('롤 마모 상태');
    expect(row.cardinality).toBe('0..1');
  });

  it('담는 요소는 `[-]N elements`로 적는다', () => {
    const root = tables[0]!;
    const row = root.children.find((child) => child.label === '[SMC]MaintenanceMonitoring')!;
    expect(row.value).toBe('[-]2 elements');
  });

  it('IRDI는 [IRDI]로, 자체 IRI는 [IRI]로 표시한다', () => {
    const technical = submodelTables(environment, find('TechnicalData'));
    const list = technical.find((table) => table.idShort === 'TechnicalPropertyAreas')!;
    expect(list.semantic.idType).toBe('[IRDI]');
  });

  it('🔴 IDTA 원본 링크는 supplementalSemanticIds에서 가져온다 — 지어내지 않는다', () => {
    const maintenance = submodelTables(environment, find('MaintenanceInstructions'));
    const tool = maintenance.find((table) => table.idShort === 'MaintenanceToolList')!;
    expect(tool.semantic.idtaOrigin).toContain('admin-shell.io');
  });

  it('HTML로 뽑으면 표가 된다', () => {
    const html = submodelTablesHtml(tables);
    expect(html).toContain('idShort:');
    expect(html).toContain('[SME type]idShort');
    expect(html).toContain('border-collapse');
  });

  it('🔴 표마다 제목이 붙는다 — 문서와 같은 꼴, 표 위에', () => {
    const html = submodelTablesHtml(tables, { from: 15, submodelName: 'OperationalData' });
    // 실제 가이던스: `표 5 TechnicalData - GeneralInformation`
    expect(html).toContain('표 15 OperationalData - OperationalData');
    expect(html).toContain('표 16 OperationalData - MaintenanceMonitoring');
    // 제목이 표보다 앞에 온다
    expect(html.indexOf('표 15 OperationalData')).toBeLessThan(html.indexOf('<table'));
  });

  it('번호는 이어서 매긴다 — 문서 전체에서 하나로 흐른다', () => {
    const first = smtTableCaption(1, 'TechnicalData', tables[0]!);
    expect(first).toBe(`표 1 TechnicalData - ${tables[0]!.idShort}`);
  });
});

describe('표 내용', () => {
  const rows = submodelTable(environment, find('OperationalData'));

  it('계층이 살아 있다 — 구조를 보여 주는 것이 목적이다', () => {
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.some((row) => row.depth === 0)).toBe(true);
    expect(rows.some((row) => row.depth > 0)).toBe(true);
    expect(rows[0]!.path).not.toContain('.');
  });

  it('예시 값이 들어간다 — 규정이 "예시 데이터를 명확히"라고 요구한다', () => {
    expect(rows.some((row) => row.example !== '')).toBe(true);
  });

  it('설명과 semanticId가 들어간다 (정성 평가 항목)', () => {
    expect(rows.some((row) => row.description !== '')).toBe(true);
    expect(rows.every((row) => row.semanticId !== '')).toBe(true);
  });

  it('🔴 담는 요소에는 데이터타입을 적지 않는다 — 오해를 부른다', () => {
    const container = rows.find((row) => row.modelType === 'SubmodelElementCollection')!;
    expect(container.dataType).toBe('');
  });

  it('HTML은 표로 붙는다 — 글자만 붙으면 소용없다', () => {
    const html = tableHtml(rows);
    expect(html).toContain('<table');
    expect(html).toContain('<th>idShort</th>');
    expect(html).toContain('border-collapse');
  });

  it('🔴 CSV에 BOM을 붙인다 — 없으면 엑셀이 한글을 깨뜨린다', () => {
    expect(tableCsv(rows).charCodeAt(0)).toBe(0xfeff);
  });

  it('CSV에서 큰따옴표를 이스케이프한다', () => {
    const csv = tableCsv([
      {
        depth: 0,
        path: 'X',
        idShort: 'X',
        modelType: 'Property',
        dataType: 'string',
        unit: '',
        example: '그는 "예"라고 했다',
        semanticId: '',
        description: '',
      },
    ]);
    expect(csv).toContain('"그는 ""예""라고 했다"');
  });
});

describe('표를 생략하는 서브모델의 정보', () => {
  const info = submodelInfo(find('DigitalNameplate'));

  it('파일에서 읽을 수 있는 것만 채운다', () => {
    expect(info.elementCount).toBeGreaterThan(0);
    expect(info.dictionaries.length).toBeGreaterThan(0);
  });

  it('🔴 모르는 것은 지어내지 않는다 — 사람이 채울 자리로 남긴다', () => {
    // 템플릿 원본 링크는 IDTA Content Hub에서 사람이 확인해야 한다(주의사항 2)
    expect(info.templateLink).toBe('');
    expect(info.toWrite.join(' ')).toContain('템플릿 원본 링크');
    expect(info.toWrite.join(' ')).toContain('용어사전 버전');
  });
});
