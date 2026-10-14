/**
 * File cloning (rename) — the basis for splitting per machine unit.
 *
 * Guarantees: submodels come along in full (the crux of the field report), ids are
 * renamed to the new name, AAS→submodel references stay intact, and the original is untouched.
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

describe('renameEnvironment (per-unit clone)', () => {
  it('renames ids to the new name while keeping every submodel', () => {
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

  it('every AAS→submodel reference points to the new id (no broken links)', () => {
    const source = scaffoldEnvironment({ assetName: 'PressMachine' });
    const cloned = renameEnvironment(source, 'PressMachine_2', IRI) as unknown as Env;
    const ids = new Set(cloned.submodels.map((submodel) => submodel.id));
    const refs = (cloned.assetAdministrationShells[0]!.submodels ?? []).map(
      (ref) => ref.keys[0]!.value,
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ids.has(ref)).toBe(true);
  });

  it('Important: derivedFrom points to the source AAS — the link tying unit-collected values back to the original evidence', () => {
    const source = scaffoldEnvironment({ assetName: 'RollFormer' }) as unknown as Env;
    const cloned = renameEnvironment(source as never, 'RollFormer_1', IRI);
    const shell = cloned.assetAdministrationShells![0]!;
    expect(shell.derivedFrom).toEqual({
      type: 'ModelReference',
      keys: [{ type: 'AssetAdministrationShell', value: source.assetAdministrationShells[0]!.id }],
    });
    // Adding the link introduces no violations
    expect(lint(cloned, ALL_RULES).findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('leaves the original untouched, and the clone has 0 violations too', () => {
    const source = scaffoldEnvironment({ assetName: 'Welder' }) as unknown as Env;
    const before = JSON.stringify(source);
    const cloned = renameEnvironment(source as never, 'Welder_1', IRI);
    expect(JSON.stringify(source)).toBe(before);
    const findings = lint(cloned, ALL_RULES).findings.filter((finding) => finding.severity === 'error');
    expect(findings).toEqual([]);
  });

  it('builds a standard-form id even when the source id is non-conforming', () => {
    const source = scaffoldEnvironment({ assetName: 'Mixer' }) as unknown as Env;
    source.assetAdministrationShells[0]!.id = 'urn:legacy:mixer';
    const cloned = renameEnvironment(source as never, 'Mixer_1', IRI) as unknown as Env;
    expect(cloned.assetAdministrationShells[0]!.id).toBe(`${IRI}/aas/Mixer_1/1/0`);
  });
});
