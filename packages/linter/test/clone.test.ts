/**
 * 파일 복제(개명) — 호기별로 나누기의 바탕.
 *
 * 지키는 것: 서브모델이 통째로 딸려오고(실측 제보의 핵심), id는 새 이름으로
 * 개명되며, AAS→서브모델 참조가 끊기지 않고, 원본은 건드리지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { ALL_RULES, lint, renameEnvironment, scaffoldEnvironment } from '../src/index.js';

const IRI = 'https://www.smart-factory.kr/ids';

interface Env {
  assetAdministrationShells: {
    id: string;
    idShort: string;
    assetInformation: { globalAssetId: string };
    submodels?: { keys: { value: string }[] }[];
  }[];
  submodels: { id: string; idShort?: string }[];
}

describe('renameEnvironment (호기별 복제)', () => {
  it('서브모델을 전부 유지한 채 id를 새 이름으로 개명한다', () => {
    const source = scaffoldEnvironment({ assetName: 'RollFormer' }) as unknown as Env;
    const cloned = renameEnvironment(source as never, 'RollFormer_1', IRI) as unknown as Env;

    expect(cloned.submodels.length).toBe(source.submodels.length);
    const shell = cloned.assetAdministrationShells[0]!;
    expect(shell.idShort).toBe('RollFormer_1');
    expect(shell.id).toContain('/aas/RollFormer_1/');
    expect(shell.assetInformation.globalAssetId).toBe(`${IRI}/asset/RollFormer_1/1/0`);
    for (const submodel of cloned.submodels) {
      expect(submodel.id).toContain('/sm/RollFormer_1/');
    }
  });

  it('AAS→서브모델 참조가 전부 새 id를 가리킨다 (끊긴 끈 없음)', () => {
    const source = scaffoldEnvironment({ assetName: 'PressMachine' });
    const cloned = renameEnvironment(source, 'PressMachine_2', IRI) as unknown as Env;
    const ids = new Set(cloned.submodels.map((submodel) => submodel.id));
    const refs = (cloned.assetAdministrationShells[0]!.submodels ?? []).map(
      (ref) => ref.keys[0]!.value,
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ids.has(ref)).toBe(true);
  });

  it('🔴 어디서 나왔는지 derivedFrom으로 원본 AAS를 가리킨다 — 호기 수집값을 원본 증빙으로 잇는 끈', () => {
    const source = scaffoldEnvironment({ assetName: 'RollFormer' }) as unknown as Env;
    const cloned = renameEnvironment(source as never, 'RollFormer_1', IRI);
    const shell = cloned.assetAdministrationShells![0]!;
    expect(shell.derivedFrom).toEqual({
      type: 'ModelReference',
      keys: [{ type: 'AssetAdministrationShell', value: source.assetAdministrationShells[0]!.id }],
    });
    // 끈을 달아도 위반이 생기지 않는다
    expect(lint(cloned, ALL_RULES).findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('원본은 그대로 두고, 복제본도 위반 0건이다', () => {
    const source = scaffoldEnvironment({ assetName: 'Welder' }) as unknown as Env;
    const before = JSON.stringify(source);
    const cloned = renameEnvironment(source as never, 'Welder_1', IRI);
    expect(JSON.stringify(source)).toBe(before);
    const findings = lint(cloned, ALL_RULES).findings.filter((finding) => finding.level === 'violation');
    expect(findings).toEqual([]);
  });

  it('규약 밖 id라도 표준 꼴로 새로 짓는다', () => {
    const source = scaffoldEnvironment({ assetName: 'Mixer' }) as unknown as Env;
    source.assetAdministrationShells[0]!.id = 'urn:legacy:mixer';
    const cloned = renameEnvironment(source as never, 'Mixer_1', IRI) as unknown as Env;
    expect(cloned.assetAdministrationShells[0]!.id).toBe(`${IRI}/aas/Mixer_1/1/0`);
  });
});
