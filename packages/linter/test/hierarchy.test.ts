/**
 * 공정 단위 — 계층 구조.
 *
 * 보는 것은 셋이다.
 *  ① 공정 뼈대가 **태어나자마자 위반 0건**인가 (설비 뼈대와 같은 기준)
 *  ② 설비를 매달고 빼는 것이 앞뒤가 맞는가
 *  ③ 끈이 끊어진 파일을 규칙이 잡아내는가 — 이걸 못 잡으면 규칙이 있으나 마나다
 */
import {
  addChild,
  ALL_RULES,
  HIERARCHY_SUBMODEL_ID_SHORT,
  lint,
  removeChild,
  scaffoldEnvironment,
} from '@aas/linter';
import { describe, expect, it } from 'vitest';

const BASE = 'https://www.smart-factory.kr/ids';
const asset = (name: string) => `${BASE}/asset/${name}/1/0`;

function process(name = 'WeldingProcess') {
  const environment = scaffoldEnvironment({ assetName: name, unit: 'process' });
  const index = environment.submodels!.findIndex((s) => s.idShort === HIERARCHY_SUBMODEL_ID_SHORT);
  return { environment, index };
}

function errorsOf(environment: ReturnType<typeof process>['environment']) {
  return lint(environment, ALL_RULES).findings.filter((f) => f.severity === 'error');
}

describe('공정 뼈대', () => {
  it('태어나자마자 위반 0건이다', () => {
    const { environment } = process();
    expect(errorsOf(environment)).toEqual([]);
  });

  it('계층 서브모델과 진입점·ArcheType이 들어 있다', () => {
    const { environment, index } = process();
    const elements = environment.submodels![index]!.submodelElements as Record<string, unknown>[];
    expect(elements.map((e) => e['idShort'])).toEqual(['WeldingProcess', 'ArcheType']);
    expect(elements[0]!['modelType']).toBe('Entity');
    expect(elements[1]!['value']).toBe('Full');
  });

  it('계층 용어의 ConceptDescription을 함께 넣는다 — 없으면 KOSMO-SME-3 위반이다', () => {
    const { environment } = process();
    const names = (environment.conceptDescriptions ?? []).map((c) => c.idShort);
    expect(names).toEqual(['EntryNode', 'Node', 'HasPart', 'ArcheType', 'BulkCount']);
  });

  it('설비 뼈대는 그대로다 — 계층 내용도 ConceptDescription도 넣지 않는다', () => {
    const environment = scaffoldEnvironment({ assetName: 'TestMachine' });
    expect(environment.conceptDescriptions).toBeUndefined();
    const hierarchy = environment.submodels!.find((s) => s.idShort === HIERARCHY_SUBMODEL_ID_SHORT);
    expect(hierarchy?.submodelElements).toBeUndefined();
    expect(errorsOf(environment)).toEqual([]);
  });
});

describe('설비 매달기', () => {
  it('Entity와 HasPart 관계가 짝으로 생긴다', () => {
    const { environment, index } = process();
    const next = addChild(
      environment.submodels![index]!,
      { name: 'RollFormingMachine', globalAssetId: asset('RollFormingMachine') },
      BASE,
    );
    const entry = (next.submodelElements as Record<string, unknown>[])[0]!;
    const statements = entry['statements'] as Record<string, unknown>[];
    expect(statements.map((s) => s['idShort'])).toEqual([
      'RollFormingMachine',
      'HasPart_RollFormingMachine',
    ]);
    expect(statements[0]!['entityType']).toBe('SelfManagedEntity');
    expect(statements[0]!['globalAssetId']).toBe(asset('RollFormingMachine'));
  });

  it('여러 대면 BulkCount가 붙는다', () => {
    const { environment, index } = process();
    const next = addChild(
      environment.submodels![index]!,
      { name: 'CoBot', globalAssetId: asset('CoBot'), bulkCount: 3 },
      BASE,
    );
    const entry = (next.submodelElements as Record<string, unknown>[])[0]!;
    const child = (entry['statements'] as Record<string, unknown>[])[0]!;
    const bulk = (child['statements'] as Record<string, unknown>[])[0]!;
    expect(bulk['idShort']).toBe('BulkCount');
    expect(bulk['value']).toBe('3');
  });

  it('설비를 매달아도 위반이 생기지 않는다', () => {
    const { environment, index } = process();
    let submodel = environment.submodels![index]!;
    submodel = addChild(submodel, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    submodel = addChild(submodel, { name: 'CutPress', globalAssetId: asset('CutPress') }, BASE);
    environment.submodels![index] = submodel;
    expect(errorsOf(environment)).toEqual([]);
  });

  it('같은 설비를 두 번 매달지 못한다', () => {
    const { environment, index } = process();
    const once = addChild(environment.submodels![index]!, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    expect(() => addChild(once, { name: 'CutPress', globalAssetId: asset('RollFormer') }, BASE)).toThrow(/이미 매달린/);
  });

  it('같은 이름을 두 번 쓰지 못한다', () => {
    const { environment, index } = process();
    const once = addChild(environment.submodels![index]!, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    expect(() => addChild(once, { name: 'RollFormer', globalAssetId: asset('Other') }, BASE)).toThrow(
      /이미 있는 이름/,
    );
  });

  it('뺄 때 관계도 함께 빠진다 — 하나만 지우면 짝이 안 맞는 파일이 된다', () => {
    const { environment, index } = process();
    let submodel = addChild(environment.submodels![index]!, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    submodel = addChild(submodel, { name: 'CutPress', globalAssetId: asset('CutPress') }, BASE);
    submodel = removeChild(submodel, 'RollFormer');
    const entry = (submodel.submodelElements as Record<string, unknown>[])[0]!;
    expect((entry['statements'] as Record<string, unknown>[]).map((s) => s['idShort'])).toEqual([
      'CutPress',
      'HasPart_CutPress',
    ]);
    environment.submodels![index] = submodel;
    expect(errorsOf(environment)).toEqual([]);
  });

  it('없는 것을 빼려 하면 알려 준다', () => {
    const { environment, index } = process();
    expect(() => removeChild(environment.submodels![index]!, '없음')).toThrow(/없는 이름/);
  });
});

describe('끊어진 계층을 규칙이 잡는다', () => {
  const brokenSubmodel = (mutate: (entry: Record<string, unknown>) => void) => {
    const { environment, index } = process();
    let submodel = addChild(environment.submodels![index]!, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    const entry = (submodel.submodelElements as Record<string, unknown>[])[0]!;
    mutate(entry);
    environment.submodels![index] = submodel;
    return errorsOf(environment).map((f) => f.ruleId);
  };

  it('HIER-2 — 가리키는 설비 주소가 빠지면 잡는다', () => {
    const ids = brokenSubmodel((entry) => {
      delete (entry['statements'] as Record<string, unknown>[])[0]!['globalAssetId'];
    });
    expect(ids).toContain('HIER-2');
  });

  it('HIER-2 — 자기 자신을 부분품으로 매달면 잡는다', () => {
    const ids = brokenSubmodel((entry) => {
      (entry['statements'] as Record<string, unknown>[])[0]!['globalAssetId'] =
        entry['globalAssetId'];
    });
    expect(ids).toContain('HIER-2');
  });

  it('관계 이름은 자유다 — 참조만 맞으면 통과한다(실측 파일들이 그렇다)', () => {
    const { environment, index } = process();
    const submodel = addChild(
      environment.submodels![index]!,
      { name: 'RollFormer', globalAssetId: asset('RollFormer') },
      BASE,
    );
    const entry = (submodel.submodelElements as Record<string, unknown>[])[0]!;
    const statements = entry['statements'] as Record<string, unknown>[];
    statements[1]!['idShort'] = 'HasPart_공정_롤포밍';   // 이름을 아무렇게나 바꿔도
    environment.submodels![index] = submodel;
    expect(errorsOf(environment).map((f) => f.ruleId)).not.toContain('HIER-3');
  });

  it('HIER-3 — 관계만 지우면 잡는다', () => {
    const ids = brokenSubmodel((entry) => {
      entry['statements'] = (entry['statements'] as Record<string, unknown>[]).filter(
        (s) => s['modelType'] !== 'RelationshipElement',
      );
    });
    expect(ids).toContain('HIER-3');
  });

  it('HIER-3 — 자식만 지우면 남은 관계를 잡는다', () => {
    const ids = brokenSubmodel((entry) => {
      entry['statements'] = (entry['statements'] as Record<string, unknown>[]).filter(
        (s) => s['modelType'] !== 'Entity',
      );
    });
    expect(ids).toContain('HIER-3');
  });

  it('HIER-1 — ArcheType 값이 규격 밖이면 잡는다', () => {
    const { environment, index } = process();
    const elements = environment.submodels![index]!.submodelElements as Record<string, unknown>[];
    elements[1]!['value'] = '아무거나';
    expect(errorsOf(environment).map((f) => f.ruleId)).toContain('HIER-1');
  });

  it('설비 파일에는 이 규칙이 걸리지 않는다 — 계층 내용이 없으면 그냥 지나간다', () => {
    const environment = scaffoldEnvironment({ assetName: 'TestMachine' });
    const ids = lint(environment, ALL_RULES).findings.map((f) => f.ruleId);
    expect(ids.filter((id) => id.startsWith('HIER-'))).toEqual([]);
  });
});
