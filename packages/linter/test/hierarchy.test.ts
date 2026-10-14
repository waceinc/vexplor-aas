/**
 * Process unit — hierarchy structure.
 *
 * Three things are checked.
 *  (1) Does the process scaffold have **0 violations right after creation** (same bar as the equipment scaffold)
 *  (2) Is attaching and detaching equipment consistent
 *  (3) Do the rules catch a file with broken links — if they cannot, the rules are pointless
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

describe('process scaffold', () => {
  it('has 0 violations right after creation', () => {
    const { environment } = process();
    expect(errorsOf(environment)).toEqual([]);
  });

  it('contains the hierarchy submodel, entry point and ArcheType', () => {
    const { environment, index } = process();
    const elements = environment.submodels![index]!.submodelElements as unknown as Record<string, unknown>[];
    expect(elements.map((e) => e['idShort'])).toEqual(['WeldingProcess', 'ArcheType']);
    expect(elements[0]!['modelType']).toBe('Entity');
    expect(elements[1]!['value']).toBe('Full');
  });

  it('includes ConceptDescriptions for the hierarchy terms — without them it violates KOSMO-SME-3', () => {
    const { environment } = process();
    const names = (environment.conceptDescriptions ?? []).map((c) => c.idShort);
    expect(names).toEqual(['EntryNode', 'Node', 'HasPart', 'ArcheType', 'BulkCount']);
  });

  it('leaves the equipment scaffold unchanged — adds neither hierarchy content nor ConceptDescriptions', () => {
    const environment = scaffoldEnvironment({ assetName: 'TestMachine' });
    expect(environment.conceptDescriptions).toBeUndefined();
    const hierarchy = environment.submodels!.find((s) => s.idShort === HIERARCHY_SUBMODEL_ID_SHORT);
    expect(hierarchy?.submodelElements).toBeUndefined();
    expect(errorsOf(environment)).toEqual([]);
  });
});

describe('attaching equipment', () => {
  it('creates an Entity and a HasPart relationship as a pair', () => {
    const { environment, index } = process();
    const next = addChild(
      environment.submodels![index]!,
      { name: 'RollFormingMachine', globalAssetId: asset('RollFormingMachine') },
      BASE,
    );
    const entry = (next.submodelElements as unknown as Record<string, unknown>[])[0]!;
    const statements = entry['statements'] as Record<string, unknown>[];
    expect(statements.map((s) => s['idShort'])).toEqual([
      'RollFormingMachine',
      'HasPart_RollFormingMachine',
    ]);
    expect(statements[0]!['entityType']).toBe('SelfManagedEntity');
    expect(statements[0]!['globalAssetId']).toBe(asset('RollFormingMachine'));
  });

  it('adds BulkCount when there are multiple units', () => {
    const { environment, index } = process();
    const next = addChild(
      environment.submodels![index]!,
      { name: 'CoBot', globalAssetId: asset('CoBot'), bulkCount: 3 },
      BASE,
    );
    const entry = (next.submodelElements as unknown as Record<string, unknown>[])[0]!;
    const child = (entry['statements'] as Record<string, unknown>[])[0]!;
    const bulk = (child['statements'] as Record<string, unknown>[])[0]!;
    expect(bulk['idShort']).toBe('BulkCount');
    expect(bulk['value']).toBe('3');
  });

  it('attaching equipment introduces no violations', () => {
    const { environment, index } = process();
    let submodel = environment.submodels![index]!;
    submodel = addChild(submodel, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    submodel = addChild(submodel, { name: 'CutPress', globalAssetId: asset('CutPress') }, BASE);
    environment.submodels![index] = submodel;
    expect(errorsOf(environment)).toEqual([]);
  });

  it('cannot attach the same equipment twice', () => {
    const { environment, index } = process();
    const once = addChild(environment.submodels![index]!, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    expect(() => addChild(once, { name: 'CutPress', globalAssetId: asset('RollFormer') }, BASE)).toThrow(/이미 매달린/);
  });

  it('cannot use the same name twice', () => {
    const { environment, index } = process();
    const once = addChild(environment.submodels![index]!, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    expect(() => addChild(once, { name: 'RollFormer', globalAssetId: asset('Other') }, BASE)).toThrow(
      /이미 있는 이름/,
    );
  });

  it('detaching also removes the relationship — removing only one leaves a mismatched file', () => {
    const { environment, index } = process();
    let submodel = addChild(environment.submodels![index]!, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    submodel = addChild(submodel, { name: 'CutPress', globalAssetId: asset('CutPress') }, BASE);
    submodel = removeChild(submodel, 'RollFormer');
    const entry = (submodel.submodelElements as unknown as Record<string, unknown>[])[0]!;
    expect((entry['statements'] as Record<string, unknown>[]).map((s) => s['idShort'])).toEqual([
      'CutPress',
      'HasPart_CutPress',
    ]);
    environment.submodels![index] = submodel;
    expect(errorsOf(environment)).toEqual([]);
  });

  it('reports an attempt to detach something that does not exist', () => {
    const { environment, index } = process();
    expect(() => removeChild(environment.submodels![index]!, '없음')).toThrow(/없는 이름/);
  });
});

describe('rules catch a broken hierarchy', () => {
  const brokenSubmodel = (mutate: (entry: Record<string, unknown>) => void) => {
    const { environment, index } = process();
    let submodel = addChild(environment.submodels![index]!, { name: 'RollFormer', globalAssetId: asset('RollFormer') }, BASE);
    const entry = (submodel.submodelElements as unknown as Record<string, unknown>[])[0]!;
    mutate(entry);
    environment.submodels![index] = submodel;
    return errorsOf(environment).map((f) => f.ruleId);
  };

  it('HIER-2 — catches a missing referenced equipment address', () => {
    const ids = brokenSubmodel((entry) => {
      delete (entry['statements'] as Record<string, unknown>[])[0]!['globalAssetId'];
    });
    expect(ids).toContain('HIER-2');
  });

  it('HIER-2 — catches attaching itself as its own part', () => {
    const ids = brokenSubmodel((entry) => {
      (entry['statements'] as Record<string, unknown>[])[0]!['globalAssetId'] =
        entry['globalAssetId'];
    });
    expect(ids).toContain('HIER-2');
  });

  it('relationship names are free-form — passes as long as references match (as in the observed files)', () => {
    const { environment, index } = process();
    const submodel = addChild(
      environment.submodels![index]!,
      { name: 'RollFormer', globalAssetId: asset('RollFormer') },
      BASE,
    );
    const entry = (submodel.submodelElements as unknown as Record<string, unknown>[])[0]!;
    const statements = entry['statements'] as Record<string, unknown>[];
    statements[1]!['idShort'] = 'HasPart_공정_롤포밍';   // even with an arbitrary renamed idShort
    environment.submodels![index] = submodel;
    expect(errorsOf(environment).map((f) => f.ruleId)).not.toContain('HIER-3');
  });

  it('HIER-3 — catches removing only the relationship', () => {
    const ids = brokenSubmodel((entry) => {
      entry['statements'] = (entry['statements'] as Record<string, unknown>[]).filter(
        (s) => s['modelType'] !== 'RelationshipElement',
      );
    });
    expect(ids).toContain('HIER-3');
  });

  it('HIER-3 — catches the leftover relationship when only the child is removed', () => {
    const ids = brokenSubmodel((entry) => {
      entry['statements'] = (entry['statements'] as Record<string, unknown>[]).filter(
        (s) => s['modelType'] !== 'Entity',
      );
    });
    expect(ids).toContain('HIER-3');
  });

  it('HIER-1 — catches an ArcheType value outside the spec', () => {
    const { environment, index } = process();
    const elements = environment.submodels![index]!.submodelElements as unknown as Record<string, unknown>[];
    elements[1]!['value'] = '아무거나';
    expect(errorsOf(environment).map((f) => f.ruleId)).toContain('HIER-1');
  });

  it('these rules do not fire on equipment files — without hierarchy content they just pass', () => {
    const environment = scaffoldEnvironment({ assetName: 'TestMachine' });
    const ids = lint(environment, ALL_RULES).findings.map((f) => f.ruleId);
    expect(ids.filter((id) => id.startsWith('HIER-'))).toEqual([]);
  });
});
