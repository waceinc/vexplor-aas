/**
 * Tree and location computation tests.
 *
 * This matters more than the screen: if the location the linter points to and the node the UI opens disagree,
 * the whole "click a finding to go to that element" flow breaks.
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

/** A trimmed copy of the actual shape of the golden DigitalNameplate file */
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

describe('tree construction', () => {
  const roots = buildTree(env);

  it('AAS, Submodel and ConceptDescription all get a place in the tree', () => {
    // if only submodels were drawn, KOSMO-AAS-* and KOSMO-CD-* findings would have nowhere to go
    expect(roots.map((r) => r.pointer)).toEqual([
      '/assetAdministrationShells/0',
      '/submodels/0',
      '/submodels/1',
      '/conceptDescriptions',
    ]);
    expect(roots[0]!.children[0]!.pointer).toBe('/assetAdministrationShells/0/assetInformation');
    expect(roots[3]!.children.map((c) => c.pointer)).toEqual(['/conceptDescriptions/0']);
  });

  it('builds pointers in Environment array order (same coordinate system as the linter)', () => {
    expect(roots[1]!.children.map((c) => c.pointer)).toEqual([
      '/submodels/0/submodelElements/0',
      '/submodels/0/submodelElements/1',
      '/submodels/0/submodelElements/2',
    ]);
  });

  it('SML children are addressed by index per spec, SMC children joined with dots', () => {
    const markings = roots[1]!.children[2]!;
    const entry = markings.children[0]!;
    const marking = entry.children[0]!;
    expect(markings.idShortPath).toBe('Markings');
    expect(entry.idShortPath).toBe('Markings[0]');
    expect(marking.idShortPath).toBe('Markings[0].MarkingName');
    // the Part 2 path is used as is in real API calls
    expect(marking.submodelId).toBe(submodels[0]!.id);
  });

  it('pointers of deep elements follow the same rule as the @aas/core walker', () => {
    const marking = roots[1]!.children[2]!.children[0]!.children[0]!;
    expect(marking.pointer).toBe('/submodels/0/submodelElements/2/value/0/value/0');
  });

  it('lists only what is expanded (virtual scrolling slices this array)', () => {
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

describe('finding attribution', () => {
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

  it('a location deeper than any element attaches to the nearest node', () => {
    const byNode = attachFindings(roots, [
      finding('/submodels/0/submodelElements/2/value/0/value/0/semanticId'),
      finding('/submodels/1/id'),
    ]);
    expect([...byNode.keys()]).toEqual([
      '/submodels/0/submodelElements/2/value/0/value/0',
      '/submodels/1',
    ]);
  });

  it('AAS and CD findings also find their place (they used to be dropped, so clicking opened nothing)', () => {
    const byNode = attachFindings(roots, [
      finding('/assetAdministrationShells/0/assetInformation/assetKind'),
      finding('/conceptDescriptions/0/idShort'),
    ]);
    expect([...byNode.keys()]).toEqual([
      '/assetAdministrationShells/0/assetInformation',
      '/conceptDescriptions/0',
    ]);
  });

  it('finds the path to a finding in the real tree, including nodes not ending in a number', () => {
    expect(revealPath(roots, '/submodels/0/submodelElements/2/value/0/value/0/semanticId')).toEqual({
      keys: [
        '/submodels/0',
        '/submodels/0/submodelElements/2',
        '/submodels/0/submodelElements/2/value/0',
        '/submodels/0/submodelElements/2/value/0/value/0',
      ],
      target: '/submodels/0/submodelElements/2/value/0/value/0',
    });

    // nodes not ending in a number, such as the assetInformation and ConceptDescription groups
    expect(revealPath(roots, '/assetAdministrationShells/0/assetInformation/assetKind')).toEqual({
      keys: ['/assetAdministrationShells/0', '/assetAdministrationShells/0/assetInformation'],
      target: '/assetAdministrationShells/0/assetInformation',
    });
    expect(revealPath(roots, '/conceptDescriptions/0/idShort')).toEqual({
      keys: ['/conceptDescriptions', '/conceptDescriptions/0'],
      target: '/conceptDescriptions/0',
    });
  });

  it('returns no target for a location not in the tree', () => {
    expect(revealPath(roots, '/submodels/9/x').target).toBeUndefined();
  });
});

describe('value display', () => {
  it('shows each kind differently', () => {
    expect(displayValue({ modelType: 'Property', value: '42' })).toBe('42');
    expect(
      displayValue({ modelType: 'MultiLanguageProperty', value: [{ language: 'ko', text: '가' }] }),
    ).toBe('ko: 가');
    expect(displayValue({ modelType: 'Range', min: '1', max: '9' })).toBe('1 ~ 9');
    expect(displayValue({ modelType: 'SubmodelElementCollection' })).toBe('');
  });
});

describe('semanticId check (reduced M4)', () => {
  const policy = { iriBase: 'https://www.smart-factory.kr/ids', irdiPrefixes: ['0173-', '0112/'] };
  const levels = (value: string, hasCd = true): string[] =>
    checkSemanticId(value, policy, hasCd).map((note) => note.level);

  it('accepts IRDIs actually used in measured files', () => {
    expect(levels('0112/2///61987#ABA231#009')).toEqual(['ok']);
    expect(levels('0173-1#02-AAA123#001')).toEqual(['ok']);
  });

  it('accepts the in-house IRI convention', () => {
    expect(levels('https://www.smart-factory.kr/ids/cd/AlarmActive/1/0')).toEqual(['ok']);
  });

  it('warns when the IRDI prefix is right but the format is broken', () => {
    expect(levels('0112/2///61987#ABA231')).toEqual(['warning']);
  });

  it('Important: compound property/class IRDIs are standard too (used by the 4 golden files and accepted by KOSMO)', () => {
    // HandoverDocumentation Document (leading #02 = property, trailing #01 = class)
    const compound = '0173-1#02-ABI500#003/0173-1#01-AHF579#003';
    expect(levels(compound)).toEqual(['ok']);
    expect(checkSemanticId(compound, policy, true)[0]!.message).toContain('복합형');
    // the other three the golden files actually use
    for (const value of [
      '0173-1#02-ABI501#003/0173-1#01-AHF580#003',
      '0173-1#02-ABI502#003/0173-1#01-AHF581#003',
      '0173-1#02-ABI503#003/0173-1#01-AHF582#003',
    ]) {
      expect(levels(value)).toEqual(['ok']);
    }
    // chaining three or a broken half still warns: the standard allows at most two
    expect(levels('0173-1#02-ABI500#003/0173-1#01-AHF579#003/0173-1#01-AHF579#003')).toEqual(['warning']);
    expect(levels('0173-1#02-ABI500#003/AHF579')).toEqual(['warning']);
  });

  it('warns separately about an eCl@ss -00 trailing code (CDP does not exist)', () => {
    const notes = checkSemanticId('0173-1#02-AAA123-00#001', policy, true);
    expect(notes.some((n) => n.message.includes('-00'))).toBe(true);
  });

  it('warns about official IDTA IRIs as a rule conflict (no silent pick)', () => {
    const notes = checkSemanticId('https://admin-shell.io/zvei/nameplate/3/0/Nameplate', policy, true);
    expect(notes[0]!.level).toBe('warning');
    expect(notes[0]!.message).toContain('KOSMO');
  });

  it('outside the allow list is an error, and so is an empty value', () => {
    expect(levels('https://example.com/x')).toEqual(['error']);
    expect(levels('')).toEqual(['error']);
  });

  it('also reports when there is no matching CD', () => {
    expect(levels('0112/2///61987#ABA231#009', false)).toEqual(['ok', 'warning']);
  });
});

describe('element count', () => {
  it('counts nested elements too (the number must reflect file size)', () => {
    // DigitalNameplate: 3 + 1 Markings child + 1 Property inside it = 5, TechnicalData: 0
    expect(countElements(submodels)).toBe(5);
    expect(countElements([])).toBe(0);
  });
});

describe('finding rollup (collapsed nodes)', () => {
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

  it('sums descendant findings up to the parent and raises the heaviest severity', () => {
    const byNode = attachFindings(roots, [
      make('/submodels/0/submodelElements/2/value/0/value/0/semanticId', 'error'),
      make('/submodels/0/submodelElements/0/value', 'warning'),
    ]);
    const tally = tallyFindings(roots, byNode);

    // looking at one collapsed Submodel tells you there are 2 findings below
    expect(tally.get('/submodels/0')).toEqual({ own: 0, total: 2, worst: 'error' });
    // intermediate levels count their own share too
    expect(tally.get('/submodels/0/submodelElements/2')).toEqual({ own: 0, total: 1, worst: 'error' });
    expect(tally.get('/submodels/0/submodelElements/0')).toEqual({ own: 1, total: 1, worst: 'warning' });
  });

  it('CD groups are summed too (when collapsed you cannot see what is inside)', () => {
    const byNode = attachFindings(roots, [make('/conceptDescriptions/0/idShort', 'warning')]);
    const tally = tallyFindings(roots, byNode);
    expect(tally.get('/conceptDescriptions')).toEqual({ own: 0, total: 1, worst: 'warning' });
  });
});


describe('tallyFindings: info is not counted in the badge', () => {
  it('a node with only info has no badge; mixed with warnings, only warnings count (2026-09-07)', async () => {
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
