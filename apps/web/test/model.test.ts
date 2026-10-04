/**
 * 트리·위치 계산 검증.
 *
 * 화면보다 이쪽이 중요하다 — 린터가 가리키는 위치와 UI가 여는 노드가 어긋나면
 * 「지적을 눌러 그 요소로 간다」는 흐름이 통째로 무너진다.
 */
import { describe, expect, it } from 'vitest';
import {
  attachFindings,
  checkSemanticId,
  buildTree,
  countElements,
  displayValue,
  flatten,
  revealPath,
  tallyFindings,
  type Finding,
  type Submodel,
} from '../src/model.js';

/** 골든 파일 DigitalNameplate의 실제 모양을 줄여 옮긴 것 */
const submodels: Submodel[] = [
  {
    modelType: 'Submodel',
    id: 'https://x/sm/DigitalNameplate/3/1',
    idShort: 'DigitalNameplate',
    submodelElements: [
      { modelType: 'Property', idShort: 'URIOfTheProduct', value: 'https://x/p/1', valueType: 'xs:string' },
      {
        modelType: 'MultiLanguageProperty',
        idShort: 'ManufacturerName',
        value: [{ language: 'ko', text: '제조사' }],
      },
      {
        modelType: 'SubmodelElementList',
        idShort: 'Markings',
        typeValueListElement: 'SubmodelElementCollection',
        value: [
          {
            modelType: 'SubmodelElementCollection',
            idShort: 'MarkingsEntry_0',
            value: [{ modelType: 'Property', idShort: 'MarkingName', value: 'CE', valueType: 'xs:string' }],
          },
        ],
      },
    ],
  },
  { modelType: 'Submodel', id: 'https://x/sm/TechnicalData/2/1', idShort: 'TechnicalData' },
];

const shells = [
  {
    modelType: 'AssetAdministrationShell',
    id: 'https://x/aas/Machine/1/0',
    idShort: 'Machine',
    assetInformation: { assetKind: 'Type', globalAssetId: 'https://x/asset/Machine/1/0' },
  },
];
const conceptDescriptions = [
  { modelType: 'ConceptDescription', id: 'https://x/cd/MarkingName/1/0', idShort: 'MarkingName' },
];
const env = { shells, submodels, conceptDescriptions };

describe('트리 구성', () => {
  const roots = buildTree(env);

  it('AAS · Submodel · ConceptDescription이 모두 트리에 자리를 갖는다', () => {
    // 서브모델만 그리면 KOSMO-AAS-*·KOSMO-CD-* 지적이 갈 곳이 없다
    expect(roots.map((r) => r.pointer)).toEqual([
      '/assetAdministrationShells/0',
      '/submodels/0',
      '/submodels/1',
      '/conceptDescriptions',
    ]);
    expect(roots[0]!.children[0]!.pointer).toBe('/assetAdministrationShells/0/assetInformation');
    expect(roots[3]!.children.map((c) => c.pointer)).toEqual(['/conceptDescriptions/0']);
  });

  it('Environment 배열 순서 그대로 pointer를 만든다 — 린터와 같은 좌표계', () => {
    expect(roots[1]!.children.map((c) => c.pointer)).toEqual([
      '/submodels/0/submodelElements/0',
      '/submodels/0/submodelElements/1',
      '/submodels/0/submodelElements/2',
    ]);
  });

  it('SML 자식은 규격대로 인덱스로 가리키고, SMC 자식은 점으로 잇는다', () => {
    const markings = roots[1]!.children[2]!;
    const entry = markings.children[0]!;
    const marking = entry.children[0]!;
    expect(markings.idShortPath).toBe('Markings');
    expect(entry.idShortPath).toBe('Markings[0]');
    expect(marking.idShortPath).toBe('Markings[0].MarkingName');
    // Part 2 경로가 실제 API 호출에 그대로 쓰인다
    expect(marking.submodelId).toBe(submodels[0]!.id);
  });

  it('깊은 요소의 pointer는 @aas/core 순회기와 같은 규칙이다', () => {
    const marking = roots[1]!.children[2]!.children[0]!.children[0]!;
    expect(marking.pointer).toBe('/submodels/0/submodelElements/2/value/0/value/0');
  });

  it('펼쳐진 것만 늘어놓는다 — 가상 스크롤이 이 배열을 자른다', () => {
    expect(flatten(roots, new Set()).map((r) => r.label)).toEqual([
      'Machine',
      'DigitalNameplate',
      'TechnicalData',
      'ConceptDescriptions (1)',
    ]);
    const opened = flatten(roots, new Set(['/submodels/0', '/submodels/0/submodelElements/2']));
    expect(opened.map((r) => r.label)).toEqual([
      'Machine',
      'DigitalNameplate',
      'URIOfTheProduct',
      'ManufacturerName',
      'Markings',
      'MarkingsEntry_0',
      'TechnicalData',
      'ConceptDescriptions (1)',
    ]);
  });
});

describe('지적 귀속', () => {
  const roots = buildTree(env);
  const finding = (pointer: string): Finding => ({
    ruleId: 'KOSMO-SME-3',
    layer: 'L3',
    severity: 'error',
    elementType: 'Property',
    key: 'MarkingName',
    pointer,
    kosmoPath: '',
    message: 'semanticId가 없습니다.',
    fixable: true,
  });

  it('요소보다 깊은 위치를 가리켜도 가장 가까운 노드에 붙는다', () => {
    const byNode = attachFindings(roots, [
      finding('/submodels/0/submodelElements/2/value/0/value/0/semanticId'),
      finding('/submodels/1/id'),
    ]);
    expect([...byNode.keys()]).toEqual([
      '/submodels/0/submodelElements/2/value/0/value/0',
      '/submodels/1',
    ]);
  });

  it('AAS·CD 지적도 제 자리를 찾는다 — 예전엔 버려져서 눌러도 열리지 않았다', () => {
    const byNode = attachFindings(roots, [
      finding('/assetAdministrationShells/0/assetInformation/assetKind'),
      finding('/conceptDescriptions/0/idShort'),
    ]);
    expect([...byNode.keys()]).toEqual([
      '/assetAdministrationShells/0/assetInformation',
      '/conceptDescriptions/0',
    ]);
  });

  it('지적까지 가는 길을 실제 트리에서 찾는다 — 숫자로 끝나지 않는 노드도 포함된다', () => {
    expect(revealPath(roots, '/submodels/0/submodelElements/2/value/0/value/0/semanticId')).toEqual({
      keys: [
        '/submodels/0',
        '/submodels/0/submodelElements/2',
        '/submodels/0/submodelElements/2/value/0',
        '/submodels/0/submodelElements/2/value/0/value/0',
      ],
      target: '/submodels/0/submodelElements/2/value/0/value/0',
    });

    // assetInformation·ConceptDescription 그룹처럼 숫자로 끝나지 않는 노드
    expect(revealPath(roots, '/assetAdministrationShells/0/assetInformation/assetKind')).toEqual({
      keys: ['/assetAdministrationShells/0', '/assetAdministrationShells/0/assetInformation'],
      target: '/assetAdministrationShells/0/assetInformation',
    });
    expect(revealPath(roots, '/conceptDescriptions/0/idShort')).toEqual({
      keys: ['/conceptDescriptions', '/conceptDescriptions/0'],
      target: '/conceptDescriptions/0',
    });
  });

  it('트리에 없는 위치는 target 없이 돌려준다', () => {
    expect(revealPath(roots, '/submodels/9/x').target).toBeUndefined();
  });
});

describe('값 표시', () => {
  it('종류마다 다르게 보여 준다', () => {
    expect(displayValue({ modelType: 'Property', value: '42' })).toBe('42');
    expect(
      displayValue({ modelType: 'MultiLanguageProperty', value: [{ language: 'ko', text: '가' }] }),
    ).toBe('ko: 가');
    expect(displayValue({ modelType: 'Range', min: '1', max: '9' })).toBe('1 ~ 9');
    expect(displayValue({ modelType: 'SubmodelElementCollection' })).toBe('');
  });
});

describe('semanticId 검사 (M4 축소판)', () => {
  const policy = { iriBase: 'https://www.smart-factory.kr/ids', irdiPrefixes: ['0173-', '0112/'] };
  const levels = (value: string, hasCd = true): string[] =>
    checkSemanticId(value, policy, hasCd).map((note) => note.level);

  it('실측 파일에 실제로 쓰인 IRDI를 통과시킨다', () => {
    expect(levels('0112/2///61987#ABA231#009')).toEqual(['ok']);
    expect(levels('0173-1#02-AAA123#001')).toEqual(['ok']);
  });

  it('자체 IRI 규약을 통과시킨다', () => {
    expect(levels('https://www.smart-factory.kr/ids/cd/AlarmActive/1/0')).toEqual(['ok']);
  });

  it('IRDI 접두는 맞지만 형식이 깨진 것은 경고한다', () => {
    expect(levels('0112/2///61987#ABA231')).toEqual(['warning']);
  });

  it('🔴 「속성/클래스」 복합 IRDI도 표준이다 — 골든 4종이 쓰고 KOSMO를 통과한 형식', () => {
    // HandoverDocumentation의 Document(앞 #02=속성, 뒤 #01=클래스)
    const compound = '0173-1#02-ABI500#003/0173-1#01-AHF579#003';
    expect(levels(compound)).toEqual(['ok']);
    expect(checkSemanticId(compound, policy, true)[0]!.message).toContain('복합형');
    // 골든 파일이 실제로 쓰는 나머지 셋
    for (const value of [
      '0173-1#02-ABI501#003/0173-1#01-AHF580#003',
      '0173-1#02-ABI502#003/0173-1#01-AHF581#003',
      '0173-1#02-ABI503#003/0173-1#01-AHF582#003',
    ]) {
      expect(levels(value)).toEqual(['ok']);
    }
    // 셋을 잇거나 한쪽이 깨진 것은 여전히 경고 — 표준은 둘까지다
    expect(levels('0173-1#02-ABI500#003/0173-1#01-AHF579#003/0173-1#01-AHF579#003')).toEqual(['warning']);
    expect(levels('0173-1#02-ABI500#003/AHF579')).toEqual(['warning']);
  });

  it('eCl@ss -00 말미 코드는 따로 경고한다 (CDP 미존재)', () => {
    const notes = checkSemanticId('0173-1#02-AAA123-00#001', policy, true);
    expect(notes.some((n) => n.message.includes('-00'))).toBe(true);
  });

  it('IDTA 공식 IRI는 규정 충돌로 경고한다 — 몰래 고르지 않는다', () => {
    const notes = checkSemanticId('https://admin-shell.io/zvei/nameplate/3/0/Nameplate', policy, true);
    expect(notes[0]!.level).toBe('warning');
    expect(notes[0]!.message).toContain('KOSMO');
  });

  it('허용 목록 밖은 오류, 빈 값도 오류', () => {
    expect(levels('https://example.com/x')).toEqual(['error']);
    expect(levels('')).toEqual(['error']);
  });

  it('대응 CD가 없으면 함께 알려 준다', () => {
    expect(levels('0112/2///61987#ABA231#009', false)).toEqual(['ok', 'warning']);
  });
});

describe('요소 세기', () => {
  it('중첩된 것까지 모두 센다 — 파일 크기를 말해 주는 숫자여야 한다', () => {
    // DigitalNameplate: 3 + Markings 자식 1 + 그 안 Property 1 = 5, TechnicalData: 0
    expect(countElements(submodels)).toBe(5);
    expect(countElements([])).toBe(0);
  });
});

describe('지적 집계 (접힌 노드)', () => {
  const roots = buildTree(env);
  const make = (pointer: string, severity: 'error' | 'warning'): Finding => ({
    ruleId: 'X',
    layer: 'L3',
    severity,
    elementType: 'Property',
    key: 'k',
    pointer,
    kosmoPath: '',
    message: 'm',
    fixable: false,
  });

  it('자손의 지적을 부모까지 합산하고 가장 무거운 등급을 올린다', () => {
    const byNode = attachFindings(roots, [
      make('/submodels/0/submodelElements/2/value/0/value/0/semanticId', 'error'),
      make('/submodels/0/submodelElements/0/value', 'warning'),
    ]);
    const tally = tallyFindings(roots, byNode);

    // 접힌 Submodel 하나만 봐도 아래에 2건이 있다는 것을 알 수 있다
    expect(tally.get('/submodels/0')).toEqual({ own: 0, total: 2, worst: 'error' });
    // 중간 계층도 제 몫만큼 센다
    expect(tally.get('/submodels/0/submodelElements/2')).toEqual({ own: 0, total: 1, worst: 'error' });
    expect(tally.get('/submodels/0/submodelElements/0')).toEqual({ own: 1, total: 1, worst: 'warning' });
  });

  it('CD 그룹도 합산한다 — 접혀 있으면 안에 무엇이 있는지 보이지 않는다', () => {
    const byNode = attachFindings(roots, [make('/conceptDescriptions/0/idShort', 'warning')]);
    const tally = tallyFindings(roots, byNode);
    expect(tally.get('/conceptDescriptions')).toEqual({ own: 0, total: 1, worst: 'warning' });
  });
});


describe('tallyFindings — 참고는 배지에 안 센다', () => {
  it('info만 있는 노드는 배지가 없고, 경고와 섞이면 경고만 센다 (2026-09-07)', async () => {
    const { tallyFindings } = await import('../src/model.js');
    const leaf = { key: '/a/0', label: 'x', modelType: 'Property', pointer: '/a/0', submodelId: '', depth: 1, children: [], node: {} };
    const root = { key: '/a', label: 'a', modelType: 'Submodel', pointer: '/a', submodelId: '', depth: 0, children: [leaf], node: {} };
    const byNode = new Map<string, any[]>([
      ['/a/0', [
        { severity: 'info', ruleId: 'KOSMO-CD-5', pointer: '/a/0', message: '' },
        { severity: 'info', ruleId: 'KOSMO-CD-5', pointer: '/a/0', message: '' },
        { severity: 'warning', ruleId: 'AASd-120', pointer: '/a/0', message: '' },
      ]],
    ]);
    const tally = tallyFindings([root as never], byNode as never);
    expect(tally.get('/a/0')).toMatchObject({ own: 1, total: 1, worst: 'warning' });
    expect(tally.get('/a')).toMatchObject({ own: 0, total: 1, worst: 'warning' });

    const onlyInfo = tallyFindings([root as never], new Map([['/a/0', [{ severity: 'info', ruleId: 'X', pointer: '/a/0', message: '' }]]]) as never);
    expect(onlyInfo.get('/a/0')!.total).toBe(0);
  });
});
